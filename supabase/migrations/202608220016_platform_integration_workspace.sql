-- Super Admin provider overview. This is a platform-only aggregate view; it
-- does not expose tenant credentials or provider payloads.

create index if not exists connected_accounts_platform_status_updated_idx
  on public.connected_accounts (status, updated_at desc, id)
  where deleted_at is null;
create index if not exists provider_events_connection_received_idx
  on public.provider_events (connected_account_id, received_at desc);
create index if not exists sync_runs_connection_started_idx
  on public.sync_runs (connected_account_id, started_at desc);

create or replace function public.get_platform_integration_workspace(
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
    raise exception using errcode = '42501', message = 'PLATFORM_INTEGRATION_ACCESS_REQUIRED';
  end if;
  if target_page < 1 or target_page > 100000
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_INTEGRATION_PAGE';
  end if;

  normalized_search := nullif(left(btrim(coalesce(target_search, '')), 80), '');
  normalized_status := upper(coalesce(target_status, 'ALL'));
  if normalized_status not in ('ALL', 'CONNECTED', 'ATTENTION', 'PENDING') then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_INTEGRATION_STATUS';
  end if;

  with filtered_connections as materialized (
    select connection_row.id, connection_row.organization_id, connection_row.provider_key,
      connection_row.display_name, connection_row.scope_mode, connection_row.status,
      connection_row.external_account_id, connection_row.last_tested_at, connection_row.last_sync_at,
      connection_row.last_error_code, connection_row.updated_at, organization_row.name as organization_name
    from public.connected_accounts connection_row
    join public.organizations organization_row on organization_row.id = connection_row.organization_id
    where connection_row.deleted_at is null
      and organization_row.deleted_at is null
      and (normalized_status = 'ALL'
        or (normalized_status = 'CONNECTED' and connection_row.status = 'CONNECTED' and connection_row.last_error_code is null)
        or (normalized_status = 'ATTENTION' and (connection_row.status in ('ERROR', 'DISCONNECTED') or connection_row.last_error_code is not null))
        or (normalized_status = 'PENDING' and connection_row.status in ('PENDING', 'AUTHORIZING')))
      and (normalized_search is null
        or connection_row.display_name ilike '%' || normalized_search || '%'
        or connection_row.provider_key ilike '%' || normalized_search || '%'
        or organization_row.name ilike '%' || normalized_search || '%')
  ), paged_connections as materialized (
    select * from filtered_connections
    order by updated_at desc, id desc
    limit target_page_size offset ((target_page - 1) * target_page_size)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered_connections),
    'kpis', jsonb_build_object(
      'total_connections', (select count(*) from public.connected_accounts where deleted_at is null),
      'healthy_connections', (select count(*) from public.connected_accounts
        where deleted_at is null and status = 'CONNECTED' and last_error_code is null),
      'attention_connections', (select count(*) from public.connected_accounts
        where deleted_at is null and (status in ('ERROR', 'DISCONNECTED') or last_error_code is not null)),
      'events_last_7_days', (select count(*) from public.provider_events where received_at >= now() - interval '7 days'),
      'sync_runs_last_7_days', (select count(*) from public.sync_runs where started_at >= now() - interval '7 days')
    ),
    'status_overview', jsonb_build_object(
      'healthy', (select count(*) from public.connected_accounts
        where deleted_at is null and status = 'CONNECTED' and last_error_code is null),
      'attention', (select count(*) from public.connected_accounts
        where deleted_at is null and (status in ('ERROR', 'DISCONNECTED') or last_error_code is not null)),
      'pending', (select count(*) from public.connected_accounts
        where deleted_at is null and status in ('PENDING', 'AUTHORIZING'))
    ),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
      'id', connection_row.id,
      'provider_key', connection_row.provider_key,
      'display_name', connection_row.display_name,
      'organization_name', connection_row.organization_name,
      'scope_mode', connection_row.scope_mode,
      'status', connection_row.status,
      'external_account_hint', case when connection_row.external_account_id is null then null
        else left(connection_row.external_account_id, 4) || '…' || right(connection_row.external_account_id, 4) end,
      'last_tested_at', connection_row.last_tested_at,
      'last_sync_at', connection_row.last_sync_at,
      'has_attention', connection_row.status in ('ERROR', 'DISCONNECTED') or connection_row.last_error_code is not null,
      'events_last_30_days', (select count(*) from public.provider_events event_row
        where event_row.connected_account_id = connection_row.id and event_row.received_at >= now() - interval '30 days'),
      'sync_runs_last_30_days', (select count(*) from public.sync_runs sync_row
        where sync_row.connected_account_id = connection_row.id and sync_row.started_at >= now() - interval '30 days')
    ) order by connection_row.updated_at desc, connection_row.id desc) from paged_connections connection_row), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_platform_integration_workspace(integer, integer, text, text) from public, anon;
grant execute on function public.get_platform_integration_workspace(integer, integer, text, text) to authenticated;
