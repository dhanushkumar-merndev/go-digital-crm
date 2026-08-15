begin;

create index if not exists connected_accounts_workspace_idx
  on public.connected_accounts (organization_id, updated_at desc, id)
  where deleted_at is null;
create index if not exists connected_accounts_workspace_status_idx
  on public.connected_accounts (organization_id, status, updated_at desc, id)
  where deleted_at is null;
create index if not exists provider_events_workspace_today_idx
  on public.provider_events (organization_id, received_at desc, id);

create or replace function public.get_integration_workspace_kpis()
returns table (
  connected bigint,
  healthy bigint,
  attention bigint,
  events_today bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*) filter (where connection_row.status = 'CONNECTED')::bigint as connected,
    count(*) filter (
      where connection_row.status = 'CONNECTED'
        and connection_row.last_error_code is null
    )::bigint as healthy,
    count(*) filter (
      where connection_row.status in ('ERROR', 'DISCONNECTED')
        or connection_row.last_error_code is not null
    )::bigint as attention,
    (
      select count(*)::bigint
      from public.provider_events event_row
      where event_row.received_at >= date_trunc('day', now())
    ) as events_today
  from public.connected_accounts connection_row
  where connection_row.deleted_at is null;
$$;

revoke all on function public.get_integration_workspace_kpis() from public, anon;
grant execute on function public.get_integration_workspace_kpis() to authenticated;

commit;
