-- Keep the legacy Customer 360 RPC available for non-Sales-Consultant roles,
-- while enforcing the dedicated follow-up and appointment permissions added
-- after its original implementation.

begin;

alter function public.get_customer_360(uuid) set schema app_private;
alter function app_private.get_customer_360(uuid) rename to get_customer_360_legacy_20260824;

revoke all on function app_private.get_customer_360_legacy_20260824(uuid)
  from public, anon, authenticated;

create function public.get_customer_360(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  target_organization_id uuid;
  followup_access boolean := false;
  appointment_access boolean := false;
begin
  -- The internal function performs the existing tenant, customer and record
  -- scope checks before any response is returned to this permission wrapper.
  result := app_private.get_customer_360_legacy_20260824(target_customer_id);

  select customer_row.organization_id
  into target_organization_id
  from public.customers customer_row
  where customer_row.id = target_customer_id
    and customer_row.deleted_at is null;

  followup_access := app_private.has_permission(target_organization_id, 'followup.view');
  appointment_access := app_private.has_permission(target_organization_id, 'appointment.view');

  result := jsonb_set(
    result,
    '{section_access,followups}',
    to_jsonb(followup_access),
    true
  );
  result := jsonb_set(
    result,
    '{section_access,appointments}',
    to_jsonb(appointment_access),
    true
  );

  if not followup_access then
    result := jsonb_set(result, '{followups}', '[]'::jsonb, true);
  end if;
  if not appointment_access then
    result := jsonb_set(result, '{appointments}', '[]'::jsonb, true);
  end if;

  return result;
end;
$$;

revoke all on function public.get_customer_360(uuid) from public, anon;
grant execute on function public.get_customer_360(uuid) to authenticated;

commit;
