begin;

-- Tenant administrators need to understand which platform modules are currently
-- available, without gaining any ability to change platform-wide entitlements.
create or replace function public.get_tenant_module_entitlements_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  rows_data jsonb;
  enabled_count integer;
  expiring_count integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null
    or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'user.manage')
    or not app_private.has_organization_wide_scope(current_organization_id)
  then
    raise exception using errcode = '42501', message = 'MODULE_ENTITLEMENT_VIEW_PERMISSION_REQUIRED';
  end if;

  with usage_by_module as materialized (
    select usage_row.module_id, sum(usage_row.quantity)::bigint as usage_last_30_days
    from public.module_usage usage_row
    where usage_row.organization_id = current_organization_id
      and usage_row.usage_date >= current_date - 29
    group by usage_row.module_id
  ), module_rows as materialized (
    select
      module_row.id,
      module_row.module_key,
      module_row.name,
      module_row.active as catalog_active,
      entitlement_row.enabled,
      entitlement_row.valid_until,
      coalesce(usage_summary.usage_last_30_days, 0)::bigint as usage_last_30_days,
      case
        when entitlement_row.id is null then 'NOT_CONFIGURED'
        when not entitlement_row.enabled then 'DISABLED'
        when entitlement_row.valid_until is not null and entitlement_row.valid_until <= now() then 'EXPIRED'
        else 'ENABLED'
      end as status
    from public.modules module_row
    left join public.organization_module_entitlements entitlement_row
      on entitlement_row.organization_id = current_organization_id
     and entitlement_row.module_id = module_row.id
    left join usage_by_module usage_summary on usage_summary.module_id = module_row.id
    where module_row.active or entitlement_row.id is not null
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'module_key', module_key,
      'name', name,
      'catalog_active', catalog_active,
      'status', status,
      'valid_until', valid_until,
      'usage_last_30_days', usage_last_30_days
    ) order by
      case status when 'ENABLED' then 0 when 'EXPIRED' then 1 when 'DISABLED' then 2 else 3 end,
      name,
      id), '[]'::jsonb),
    count(*) filter (where status = 'ENABLED')::integer,
    count(*) filter (
      where status = 'ENABLED'
        and valid_until is not null
        and valid_until > now()
        and valid_until <= now() + interval '30 days'
    )::integer
  into rows_data, enabled_count, expiring_count
  from module_rows;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'kpis', jsonb_build_object(
      'enabled', coalesce(enabled_count, 0),
      'expiring_30_days', coalesce(expiring_count, 0),
      'disabled', (select count(*)::integer from jsonb_array_elements(rows_data) row where row->>'status' = 'DISABLED'),
      'not_configured', (select count(*)::integer from jsonb_array_elements(rows_data) row where row->>'status' = 'NOT_CONFIGURED')
    ),
    'records', rows_data
  );
end;
$$;

revoke all on function public.get_tenant_module_entitlements_workspace() from public, anon;
grant execute on function public.get_tenant_module_entitlements_workspace() to authenticated;

commit;
