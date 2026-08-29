begin;

-- Booking a test drive from a lead ("New test drive" with `?lead=<id>`) opened a
-- form that immediately said "The selected customer is no longer available."
--
-- The page seeds the lead id from the URL, then looks that id up in the
-- opportunity option list to display it. That list only matched on customer
-- name, interested model and phone, and returns the 25 most recently updated
-- leads -- so unless the lead the user had just come from happened to be in that
-- top 25, it was never found, and the form reported the customer as gone before
-- the user had touched anything.
--
-- The other option RPCs in this codebase already accept an id in the search
-- term for exactly this reason. This one now does too, so a lead can be
-- resolved directly instead of being hunted for by name.

create or replace function public.get_test_drive_lead_options(
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  search_uuid uuid;
  result jsonb;
begin
  if char_length(normalized_search) > 160
    or target_limit is null or target_limit not between 1 and 25
  then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_LEAD_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not app_private.has_permission(current_organization_id, 'lead.view')
    or not app_private.has_permission(current_organization_id, 'lead.update')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
    select lead_row.id as lead_id,
      lead_row.customer_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      branch_row.name as branch_name,
      profile_row.full_name as assigned_user_name,
      lead_row.updated_at
    from public.leads lead_row
    join public.customers customer_row
      on customer_row.id = lead_row.customer_id
     and customer_row.organization_id = lead_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    join public.profiles profile_row
      on profile_row.id = lead_row.assigned_user_id
     and profile_row.organization_id = lead_row.organization_id
     and profile_row.active
     and profile_row.deleted_at is null
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      )
      and app_private.can_access_customer(
        lead_row.organization_id,
        lead_row.customer_id
      )
      and app_private.can_access_lead(lead_row.id)
      and (
        normalized_search = ''
        -- An exact id wins outright: this is the "opened from that lead" path,
        -- not a search, and the row must come back even when it is nowhere near
        -- the most recently updated 25.
        or lead_row.id = search_uuid
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or position(normalized_search in lower(coalesce(lead_row.interested_model, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
    order by lead_row.updated_at desc, lead_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

commit;
