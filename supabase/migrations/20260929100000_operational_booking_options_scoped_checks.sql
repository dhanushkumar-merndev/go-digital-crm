begin;

-- The "Create case" booking picker (get_operational_case_booking_options) ran
-- two plpgsql access checks, can_access_record and can_access_customer, on
-- every open booking of the organization before sorting and keeping 25. At
-- about 3.7 ms per booking that was 260-300 ms for the demo tenant's 73
-- bookings, and it grows with the booking backlog until the 8 s statement
-- timeout. It was the most expensive read in the lead-to-delivery flow.
--
-- Same rows, same order, same errors:
-- * can_access_record depends only on (branch, team, owner), so each distinct
--   combination is checked once instead of once per booking.
-- * can_access_customer is skipped for organization-wide scope, where it is
--   true for every live customer (which the customer join already requires),
--   and otherwise runs in display order and stops at the page size. A CASE, not
--   an OR, because an OR on a plpgsql variable is not short-circuited.
--
-- Verified before deploy against the live function as a temporary copy: 56/56
-- identical results (Finance, Insurance, RTO, Delivery, Exchange managers, an
-- OWN_RECORDS Sales Consultant, and two denied roles x 7 searches). Warm, per
-- call: RTO/Insurance/Delivery 260-280 ms -> 36-42 ms, Finance 84 -> 12 ms.
--
-- Patched in place from the deployed definition (never re-emitted), and the
-- result must be byte-identical to the verified text.
do $migration$
declare
  target constant regprocedure := 'public.get_operational_case_booking_options(text,text,integer)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target);
begin

  -- edit 1
  if (length(definition) - length(replace(definition, $o$  result jsonb;
begin
$o$, ''))) / length($o$  result jsonb;
begin
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND: edit 1';
  end if;
  definition := replace(definition, $o$  result jsonb;
begin
$o$, $n$  result jsonb;
  broad_scope boolean;
begin
$n$);

  -- edit 2
  if (length(definition) - length(replace(definition, $o$  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;
$o$, ''))) / length($o$  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND: edit 2';
  end if;
  definition := replace(definition, $o$  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;
$o$, $n$  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;
  -- With organization-wide scope can_access_customer is true for every live
  -- customer of the organization, which the customer join already requires.
  broad_scope := app_private.has_active_approved_support_session(current_organization_id)
    or exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = current_organization_id
        and assignment_row.active
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
    );
$n$);

  -- edit 3
  if (length(definition) - length(replace(definition, $o$  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
$o$, ''))) / length($o$  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND: edit 3';
  end if;
  definition := replace(definition, $o$  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
$o$, $n$  -- can_access_record depends only on (branch, team, owner): check each
  -- distinct combination once instead of once per booking.
  with booking_scopes as materialized (
    select distinct scope_row.branch_id, scope_row.team_id, scope_row.assigned_user_id
    from public.bookings scope_row
    where scope_row.organization_id = current_organization_id
      and scope_row.deleted_at is null
      and scope_row.status in ('CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY')
  ),
  visible_booking_scopes as materialized (
    select scope_row.branch_id, scope_row.team_id, scope_row.assigned_user_id
    from booking_scopes scope_row
    where app_private.can_access_record(
      current_organization_id, scope_row.branch_id, scope_row.team_id, scope_row.assigned_user_id
    )
  )
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
$n$);

  -- edit 4
  if (length(definition) - length(replace(definition, $o$      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
$o$, ''))) / length($o$      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND: edit 4';
  end if;
  definition := replace(definition, $o$      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
$o$, $n$      and exists (
        select 1 from visible_booking_scopes visible_row
        where visible_row.branch_id is not distinct from booking_row.branch_id
          and visible_row.team_id is not distinct from booking_row.team_id
          and visible_row.assigned_user_id is not distinct from booking_row.assigned_user_id
      )
$n$);

  -- edit 5
  if (length(definition) - length(replace(definition, $o$  from (
    select booking_row.id as booking_id,$o$, ''))) / length($o$  from (
    select booking_row.id as booking_id,$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND: edit 5';
  end if;
  definition := replace(definition, $o$  from (
    select booking_row.id as booking_id,$o$, $n$  from (
    select sorted_row.* from (
    select booking_row.id as booking_id,$n$);

  -- edit 6
  if (length(definition) - length(replace(definition, $o$    order by booking_row.updated_at desc, booking_row.id desc
    limit target_limit
  ) option_row;
$o$, ''))) / length($o$    order by booking_row.updated_at desc, booking_row.id desc
    limit target_limit
  ) option_row;
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND: edit 6';
  end if;
  definition := replace(definition, $o$    order by booking_row.updated_at desc, booking_row.id desc
    limit target_limit
  ) option_row;
$o$, $n$    order by booking_row.updated_at desc, booking_row.id desc
    -- OFFSET 0 keeps the check below out of this subquery, so it runs
    -- row by row in this order until the limit is met.
    offset 0
    ) sorted_row
    -- CASE, not OR: an OR on a plpgsql variable is not short-circuited.
    where case
      when broad_scope then true
      else app_private.can_access_customer(current_organization_id, sorted_row.customer_id)
    end
    limit target_limit
  ) option_row;
$n$);

  if md5(definition) <> '17d3a75d2ad0d97a15bbf7df4da9ebca' then
    raise exception using errcode = 'P0001',
      message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_UNVERIFIED: ' || md5(definition);
  end if;
  execute definition;
end;
$migration$;

commit;
