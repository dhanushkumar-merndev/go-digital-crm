-- Platform module catalog: compact server-side data for the Super Admin module
-- workspace. Tenant entitlement counts and usage remain platform-only.

create index if not exists module_usage_module_usage_date_idx
  on public.module_usage (module_id, usage_date desc);
create index if not exists organization_module_entitlements_module_enabled_idx
  on public.organization_module_entitlements (module_id, enabled, organization_id);
create index if not exists plan_modules_module_plan_idx
  on public.plan_modules (module_id, plan_id);
create unique index if not exists platform_module_active_change_request_unique_idx
  on public.audit_logs (actor_id, request_id)
  where organization_id is null and action = 'platform_module.active_changed';

create or replace function public.get_platform_module_workspace(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default null,
  target_status text default 'ALL'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text;
  normalized_status text;
  result jsonb;
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MODULE_ACCESS_REQUIRED';
  end if;
  if target_page < 1 or target_page > 100000
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_MODULE_PAGE';
  end if;

  normalized_search := nullif(left(btrim(coalesce(target_search, '')), 80), '');
  normalized_status := upper(coalesce(target_status, 'ALL'));
  if normalized_status not in ('ALL', 'ACTIVE', 'INACTIVE') then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_MODULE_STATUS';
  end if;

  with filtered_modules as materialized (
    select module_row.id, module_row.module_key, module_row.name, module_row.active
    from public.modules module_row
    where (normalized_status = 'ALL'
        or (normalized_status = 'ACTIVE' and module_row.active)
        or (normalized_status = 'INACTIVE' and not module_row.active))
      and (
        normalized_search is null
        or module_row.name ilike '%' || normalized_search || '%'
        or module_row.module_key ilike '%' || normalized_search || '%'
      )
  ), paged_modules as materialized (
    select *
    from filtered_modules
    order by active desc, name asc, id asc
    limit target_page_size offset ((target_page - 1) * target_page_size)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered_modules),
    'kpis', jsonb_build_object(
      'total_modules', (select count(*) from public.modules),
      'active_modules', (select count(*) from public.modules where active),
      'inactive_modules', (select count(*) from public.modules where not active),
      'plan_assignments', (select count(*) from public.plan_modules),
      'enabled_entitlements', (
        select count(*) from public.organization_module_entitlements where enabled
      )
    ),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
      'id', module_row.id,
      'module_key', module_row.module_key,
      'name', module_row.name,
      'active', module_row.active,
      'plan_count', (select count(*) from public.plan_modules plan_module_row
        where plan_module_row.module_id = module_row.id),
      'tenant_count', (select count(*) from public.organization_module_entitlements entitlement_row
        where entitlement_row.module_id = module_row.id),
      'enabled_tenant_count', (select count(*) from public.organization_module_entitlements entitlement_row
        where entitlement_row.module_id = module_row.id and entitlement_row.enabled),
      'usage_last_30_days', coalesce((select sum(usage_row.quantity) from public.module_usage usage_row
        where usage_row.module_id = module_row.id and usage_row.usage_date >= current_date - 29), 0)
    ) order by module_row.active desc, module_row.name asc, module_row.id asc) from paged_modules module_row), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.set_platform_module_active(
  target_module_id uuid,
  target_active boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  module_row public.modules%rowtype;
  existing_active boolean;
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MODULE_MANAGE_REQUIRED';
  end if;
  if target_module_id is null or target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_MODULE_MUTATION';
  end if;

  select (audit_row.metadata ->> 'active')::boolean into existing_active
  from public.audit_logs audit_row
  where audit_row.organization_id is null
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'platform_module.active_changed'
  limit 1;
  if found then
    return jsonb_build_object('id', target_module_id, 'active', existing_active, 'idempotent', true);
  end if;

  update public.modules
  set active = target_active
  where id = target_module_id
  returning * into module_row;
  if not found then
    raise exception using errcode = 'P0002', message = 'PLATFORM_MODULE_NOT_FOUND';
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    null, auth.uid(), 'platform_module.active_changed', 'module', module_row.id::text,
    target_request_id,
    jsonb_build_object(
      'module_key', module_row.module_key,
      'active', module_row.active,
      'safe_message', case when module_row.active then 'Platform module enabled' else 'Platform module disabled' end
    )
  );

  return jsonb_build_object('id', module_row.id, 'active', module_row.active, 'idempotent', false);
end;
$$;

revoke all on function public.get_platform_module_workspace(integer, integer, text, text) from public, anon;
grant execute on function public.get_platform_module_workspace(integer, integer, text, text) to authenticated;
revoke all on function public.set_platform_module_active(uuid, boolean, uuid) from public, anon;
grant execute on function public.set_platform_module_active(uuid, boolean, uuid) to authenticated;
