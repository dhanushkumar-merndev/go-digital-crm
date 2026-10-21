-- Customer 360 had no operations view: finance, insurance, RTO, exchange and
-- delivery progress for a customer was only visible on each desk's own list.
-- This returns one customer's cases across the five desks, applying exactly the
-- predicates of each desk's read policy (*_cases_read): department permission,
-- customer.view, record scope and customer scope. A user without a desk's
-- permission gets none of its rows. The session-level checks are evaluated
-- once; only the record and customer checks run per row.
--
-- The new (organization_id, customer_id) indexes keep the read to that one
-- customer's handful of cases, so the per-row policy checks run a few times,
-- not once per case in the tenant.

create index concurrently if not exists finance_cases_org_customer_idx
  on public.finance_cases (organization_id, customer_id) where deleted_at is null;
create index concurrently if not exists insurance_cases_org_customer_idx
  on public.insurance_cases (organization_id, customer_id) where deleted_at is null;
create index concurrently if not exists rto_cases_org_customer_idx
  on public.rto_cases (organization_id, customer_id) where deleted_at is null;
create index concurrently if not exists exchange_cases_org_customer_idx
  on public.exchange_cases (organization_id, customer_id) where deleted_at is null;
create index concurrently if not exists delivery_cases_org_customer_idx
  on public.delivery_cases (organization_id, customer_id) where deleted_at is null;

begin;

create or replace function public.get_customer_operational_cases(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  visible_departments text[] := '{}'::text[];
  result jsonb;
begin
  if auth.uid() is null
    or current_organization_id is null
    or target_customer_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  select coalesce(array_agg(department_row.department order by department_row.sort_order), '{}')
  into visible_departments
  from (values ('FINANCE', 1), ('INSURANCE', 2), ('RTO', 3), ('EXCHANGE', 4), ('DELIVERY', 5))
    as department_row(department, sort_order)
  where app_private.operational_case_permission(
    current_organization_id, department_row.department, 'VIEW'
  );

  with cases as (
    select 'FINANCE' as department, case_row.id, case_row.booking_id, case_row.status,
      case_row.priority, case_row.due_at, case_row.updated_at, case_row.branch_id,
      case_row.assigned_user_id
    from public.finance_cases case_row
    where 'FINANCE' = any(visible_departments)
      and case_row.organization_id = current_organization_id
      and case_row.customer_id = target_customer_id
      and case_row.deleted_at is null
    union all
    select 'INSURANCE', case_row.id, case_row.booking_id, case_row.status, case_row.priority,
      case_row.due_at, case_row.updated_at, case_row.branch_id, case_row.assigned_user_id
    from public.insurance_cases case_row
    where 'INSURANCE' = any(visible_departments)
      and case_row.organization_id = current_organization_id
      and case_row.customer_id = target_customer_id
      and case_row.deleted_at is null
    union all
    select 'RTO', case_row.id, case_row.booking_id, case_row.status, case_row.priority,
      case_row.due_at, case_row.updated_at, case_row.branch_id, case_row.assigned_user_id
    from public.rto_cases case_row
    where 'RTO' = any(visible_departments)
      and case_row.organization_id = current_organization_id
      and case_row.customer_id = target_customer_id
      and case_row.deleted_at is null
    union all
    select 'EXCHANGE', case_row.id, case_row.booking_id, case_row.status, case_row.priority,
      case_row.due_at, case_row.updated_at, case_row.branch_id, case_row.assigned_user_id
    from public.exchange_cases case_row
    where 'EXCHANGE' = any(visible_departments)
      and case_row.organization_id = current_organization_id
      and case_row.customer_id = target_customer_id
      and case_row.deleted_at is null
    union all
    select 'DELIVERY', case_row.id, case_row.booking_id, case_row.status, case_row.priority,
      case_row.due_at, case_row.updated_at, case_row.branch_id, case_row.assigned_user_id
    from public.delivery_cases case_row
    where 'DELIVERY' = any(visible_departments)
      and case_row.organization_id = current_organization_id
      and case_row.customer_id = target_customer_id
      and case_row.deleted_at is null
  ),
  visible as (
    select case_row.*
    from cases case_row
    where app_private.can_access_customer(current_organization_id, target_customer_id)
      and app_private.can_access_record(
        current_organization_id, case_row.branch_id, null, case_row.assigned_user_id
      )
  )
  select jsonb_build_object(
    'departments', to_jsonb(visible_departments),
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'department', visible_row.department,
        'id', visible_row.id,
        'booking_id', visible_row.booking_id,
        'booking_number', booking_row.booking_number,
        'status', visible_row.status,
        'priority', visible_row.priority,
        'due_at', visible_row.due_at,
        'updated_at', visible_row.updated_at
      ) order by visible_row.updated_at desc, visible_row.id)
      from visible visible_row
      left join public.bookings booking_row
        on booking_row.organization_id = current_organization_id
       and booking_row.id = visible_row.booking_id
       and booking_row.deleted_at is null
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_customer_operational_cases(uuid) from public, anon;
grant execute on function public.get_customer_operational_cases(uuid) to authenticated;

commit;
