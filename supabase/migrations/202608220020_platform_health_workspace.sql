-- Platform health is based on recorded provider/sync/error signals only. It
-- does not claim synthetic latency, uptime, or backup measurements.

create index if not exists error_logs_platform_service_created_idx
  on public.error_logs (service, created_at desc, id);
create index if not exists sync_runs_platform_started_idx
  on public.sync_runs (started_at desc, id);

create or replace function public.get_platform_health_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_HEALTH_ACCESS_REQUIRED';
  end if;
  return jsonb_build_object(
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'provider_connections', (select count(*) from public.connected_accounts where deleted_at is null),
      'provider_attention', (select count(*) from public.connected_accounts
        where deleted_at is null and (status in ('ERROR', 'DISCONNECTED') or last_error_code is not null)),
      'sync_runs_24h', (select count(*) from public.sync_runs where started_at >= now() - interval '24 hours'),
      'errors_24h', (select count(*) from public.error_logs where created_at >= now() - interval '24 hours'),
      'active_tenants', (select count(*) from public.organizations where status = 'ACTIVE' and deleted_at is null)
    ),
    'services', coalesce((select jsonb_agg(jsonb_build_object(
      'service', service, 'errors_24h', errors_24h, 'last_error_at', last_error_at,
      'last_safe_code', last_safe_code
    ) order by errors_24h desc, last_error_at desc nulls last, service) from (
      select error_row.service, count(*) filter (where error_row.created_at >= now() - interval '24 hours')::bigint as errors_24h,
        max(error_row.created_at) as last_error_at,
        (array_agg(error_row.safe_code order by error_row.created_at desc))[1] as last_safe_code
      from public.error_logs error_row
      where error_row.created_at >= now() - interval '30 days'
      group by error_row.service
      order by errors_24h desc, last_error_at desc nulls last, error_row.service
      limit 25
    ) service_row), '[]'::jsonb),
    'provider_attention', coalesce((select jsonb_agg(jsonb_build_object(
      'id', connection_row.id, 'provider_key', connection_row.provider_key,
      'display_name', connection_row.display_name, 'organization_name', connection_row.organization_name,
      'status', connection_row.status, 'last_sync_at', connection_row.last_sync_at,
      'last_error_code', connection_row.last_error_code
    ) order by connection_row.updated_at desc, connection_row.id desc)
    from (
      select connection_source.*, organization_row.name as organization_name
      from public.connected_accounts connection_source
      join public.organizations organization_row on organization_row.id = connection_source.organization_id
      where connection_source.deleted_at is null and organization_row.deleted_at is null
        and (connection_source.status in ('ERROR', 'DISCONNECTED') or connection_source.last_error_code is not null)
      order by connection_source.updated_at desc, connection_source.id desc
      limit 25
    ) connection_row), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_platform_health_workspace() from public, anon;
grant execute on function public.get_platform_health_workspace() to authenticated;
