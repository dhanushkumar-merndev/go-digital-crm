-- A Sales lead could only become a booking through four separate saves:
-- save the quotation, mark it sent, mark it accepted, then create the booking
-- from the accepted quotation. A walk-in customer who agrees on the spot, or a
-- lead that skips the test drive, had to be walked through every one of them,
-- and "Create booking" on a lead with no accepted quotation was a dead end.
--
-- quick_book_lead finishes a booking from whatever quotation state the lead is
-- in, in one transaction:
--   no quotation yet   -> price it now (target_items), then send, accept, book
--   DRAFT quotation    -> optionally re-price, then send, accept, book
--   SENT quotation     -> accept, book
--   ACCEPTED quotation -> book
--
-- It composes the existing RPCs rather than re-implementing them, so pricing
-- validation, the discount-approval threshold, version checks, scope checks,
-- stage history, activities and audit rows are exactly those of the normal
-- path. A discount that needs approval is refused here: approval is a separate
-- person's decision and cannot be granted by the requester's own booking.
--
-- Each step gets a request id derived from the caller's one request id, so a
-- retried or double-submitted Book now replays the same quotation and booking
-- instead of creating a second one.

create or replace function public.quick_book_lead(
  target_lead_id uuid,
  target_quotation_id uuid,
  expected_quotation_version bigint,
  target_items jsonb,
  target_booking_amount numeric,
  target_finance_required boolean,
  target_exchange_required boolean,
  target_expected_delivery_date date,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  quotation_row public.quotations%rowtype;
  quotation_state jsonb;
  quotation_id uuid;
  quotation_version bigint;
  quotation_status text;
  booking_result jsonb;
  presented_reason constant text := 'Presented and accepted in person (quick booking)';
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_lead_id is null or target_request_id is null
    or (target_quotation_id is null and target_items is null)
    or (target_quotation_id is not null and expected_quotation_version is null)
  then
    raise exception using errcode = '22023', message = 'INVALID_QUICK_BOOKING_INPUT';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'quotation.manage')
    or not app_private.has_permission(current_organization_id, 'booking.manage')
  then
    raise exception using errcode = '42501', message = 'QUICK_BOOKING_PERMISSION_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':booking.quick_created:' || target_request_id::text, 0
  ));

  if target_items is not null then
    -- save_quotation validates the lead, its customer link and the caller's scope.
    quotation_state := public.save_quotation(
      target_quotation_id, expected_quotation_version, target_lead_id, target_items,
      md5(target_request_id::text || ':quick-book:save')::uuid
    );
    quotation_id := (quotation_state->>'id')::uuid;
    quotation_version := (quotation_state->>'version')::bigint;
    quotation_status := quotation_state->>'status';
    if quotation_state->>'approval_status' in ('PENDING', 'REJECTED') then
      raise exception using errcode = '23514', message = 'QUOTATION_APPROVAL_REQUIRED';
    end if;
  else
    select * into quotation_row
    from public.quotations source_row
    where source_row.id = target_quotation_id
      and source_row.organization_id = current_organization_id
      and source_row.lead_id = target_lead_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'QUOTATION_NOT_FOUND';
    end if;
    if not app_private.can_access_record(
      quotation_row.organization_id, quotation_row.branch_id,
      quotation_row.team_id, quotation_row.assigned_user_id
    ) then
      raise exception using errcode = '42501', message = 'QUOTATION_SCOPE_DENIED';
    end if;
    if quotation_row.version <> expected_quotation_version then
      raise exception using errcode = '40001', message = 'QUOTATION_VERSION_CONFLICT';
    end if;
    if quotation_row.approval_status in ('PENDING', 'REJECTED') then
      raise exception using errcode = '23514', message = 'QUOTATION_APPROVAL_REQUIRED';
    end if;
    quotation_id := quotation_row.id;
    quotation_version := quotation_row.version;
    quotation_status := quotation_row.status;
  end if;

  if quotation_status = 'CONVERTED' then
    raise exception using errcode = '23505', message = 'QUOTATION_ALREADY_BOOKED';
  end if;
  if quotation_status = 'DRAFT' then
    quotation_state := public.transition_quotation_status(
      quotation_id, quotation_version, 'SENT', presented_reason,
      md5(target_request_id::text || ':quick-book:sent')::uuid
    );
    quotation_version := (quotation_state->>'version')::bigint;
    quotation_status := quotation_state->>'status';
  end if;
  if quotation_status = 'SENT' then
    quotation_state := public.transition_quotation_status(
      quotation_id, quotation_version, 'ACCEPTED', presented_reason,
      md5(target_request_id::text || ':quick-book:accepted')::uuid
    );
    quotation_version := (quotation_state->>'version')::bigint;
    quotation_status := quotation_state->>'status';
  end if;
  if quotation_status <> 'ACCEPTED' then
    raise exception using errcode = '23514', message = 'QUOTATION_NOT_BOOKABLE';
  end if;

  booking_result := public.create_booking_from_quotation(
    quotation_id, quotation_version, target_booking_amount,
    target_finance_required, target_exchange_required, target_expected_delivery_date,
    md5(target_request_id::text || ':quick-book:booking')::uuid
  );
  return booking_result || jsonb_build_object('quotation_version', quotation_version);
end;
$$;

revoke all on function public.quick_book_lead(
  uuid, uuid, bigint, jsonb, numeric, boolean, boolean, date, uuid
) from public, anon;
grant execute on function public.quick_book_lead(
  uuid, uuid, bigint, jsonb, numeric, boolean, boolean, date, uuid
) to authenticated;
