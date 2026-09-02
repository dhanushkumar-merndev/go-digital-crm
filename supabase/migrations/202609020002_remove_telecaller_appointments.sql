begin;

-- Product policy: Telecaller / BDC handles lead intake, calls, follow-ups and
-- Sales handoff. Customer appointments belong to Sales Consultant and manager
-- workflows. Existing appointment records remain intact for audit and for the
-- authorized Sales users who own them.
delete from public.role_permissions role_permission_row
using public.roles role_row, public.permissions permission_row
where role_permission_row.role_id = role_row.id
  and role_permission_row.permission_id = permission_row.id
  and role_row.role_key = 'telecaller_bdc'
  and permission_row.permission_key like 'appointment.%';

-- New tenant provisioning must not restore the permissions removed above.
create or replace function app_private.apply_default_work_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  permission_keys text[] := '{}';
begin
  if new.organization_id is null or not new.system_role then
    return new;
  end if;

  permission_keys := case
    when new.role_key in ('client_admin', 'system_administrator') then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.complete',
      'followup.cancel', 'followup.assign', 'followup.override_complete',
      'appointment.view', 'appointment.create', 'appointment.update',
      'appointment.complete', 'appointment.cancel', 'appointment.assign'
    ]
    when new.role_key = 'telecaller_bdc' then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.complete',
      'followup.cancel'
    ]
    when new.role_key = 'sales_consultant' then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.complete',
      'followup.cancel', 'appointment.view', 'appointment.create',
      'appointment.update', 'appointment.complete', 'appointment.cancel'
    ]
    when new.role_key in ('team_manager', 'showroom_manager') then array[
      'followup.view', 'followup.create', 'followup.update', 'followup.cancel',
      'followup.assign', 'appointment.view', 'appointment.create',
      'appointment.update', 'appointment.complete', 'appointment.cancel',
      'appointment.assign'
    ]
    when new.role_key = 'customer_relationship_manager' then array[
      'followup.view', 'followup.create', 'followup.update',
      'followup.complete', 'followup.cancel'
    ]
    when new.role_key in ('gm_sales', 'business_owner') then array[
      'followup.view', 'appointment.view'
    ]
    else '{}'::text[]
  end;

  insert into public.role_permissions (role_id, permission_id)
  select new.id, permission_row.id
  from public.permissions permission_row
  where permission_row.permission_key = any(permission_keys)
  on conflict do nothing;

  return new;
end;
$$;

-- Enforce the frozen role boundary even if a generic role-management path
-- attempts to grant an appointment permission later.
create or replace function app_private.reject_telecaller_appointment_permission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.roles role_row
    join public.permissions permission_row on permission_row.id = new.permission_id
    where role_row.id = new.role_id
      and role_row.role_key = 'telecaller_bdc'
      and permission_row.permission_key like 'appointment.%'
  ) then
    raise exception using
      errcode = '23514',
      message = 'TELECALLER_APPOINTMENT_PERMISSION_NOT_ALLOWED';
  end if;
  return new;
end;
$$;

drop trigger if exists role_permissions_reject_telecaller_appointments
on public.role_permissions;
create trigger role_permissions_reject_telecaller_appointments
before insert or update of role_id, permission_id on public.role_permissions
for each row execute function app_private.reject_telecaller_appointment_permission();

revoke all on function app_private.reject_telecaller_appointment_permission()
from public, anon, authenticated;

commit;
