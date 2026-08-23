-- System Administrator health is deliberately limited to provider connections and
-- their recorded sync runs. error_logs has no dependable branch relationship, so
-- it is not exposed to a branch-scoped administrator from this workspace.

create or replace function public.get_system_administrator_health_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_organization_id uuid;
begin
  select profile_row.organization_id
  into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;

  if auth.uid() is null
    or actor_organization_id is null
    or not app_private.mfa_policy_satisfied(actor_organization_id)
    or not app_private.has_permission(actor_organization_id, 'integration.view')
    or not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = actor_organization_id
        and assignment_row.active
        and role_row.role_key = 'system_administrator'
    )
  then
    raise exception using errcode = '42501', message = 'SYSTEM_HEALTH_ACCESS_REQUIRED';
  end if;

  return (
    with visible_connections as materialized (
      select
        connection_row.id,
        connection_row.provider_key,
        connection_row.display_name,
        connection_row.scope_mode,
        connection_row.status,
        connection_row.last_tested_at,
        connection_row.last_sync_at,
        connection_row.last_error_code,
        connection_row.updated_at,
        coalesce((
          select jsonb_agg(branch_row.name order by branch_row.name)
          from public.integration_branch_mappings mapping_row
          join public.branches branch_row
            on branch_row.id = mapping_row.branch_id
           and branch_row.organization_id = mapping_row.organization_id
          where mapping_row.organization_id = actor_organization_id
            and mapping_row.connected_account_id = connection_row.id
            and branch_row.active
            and branch_row.deleted_at is null
            and app_private.can_access_branch(actor_organization_id, branch_row.id)
        ), '[]'::jsonb) as visible_branch_names
      from public.connected_accounts connection_row
      where connection_row.organization_id = actor_organization_id
        and connection_row.deleted_at is null
        and app_private.can_access_connection(actor_organization_id, connection_row.id)
    ),
    scoped_sync_runs as materialized (
      select
        sync_row.id,
        sync_row.connected_account_id,
        sync_row.sync_type,
        sync_row.status,
        sync_row.records_processed,
        sync_row.started_at,
        sync_row.completed_at
      from public.sync_runs sync_row
      join visible_connections connection_row
        on connection_row.id = sync_row.connected_account_id
      where sync_row.organization_id = actor_organization_id
    )
    select jsonb_build_object(
      'generated_at', now(),
      'scope', jsonb_build_object(
        'organization_wide', app_private.has_organization_wide_scope(actor_organization_id),
        'accessible_branches', (
          select count(*)::bigint
          from public.branches branch_row
          where branch_row.organization_id = actor_organization_id
            and branch_row.active
            and branch_row.deleted_at is null
            and app_private.can_access_branch(actor_organization_id, branch_row.id)
        )
      ),
      'kpis', jsonb_build_object(
        'visible_connections', (select count(*)::bigint from visible_connections),
        'attention_connections', (
          select count(*)::bigint
          from visible_connections
          where status in ('ERROR', 'DISCONNECTED') or last_error_code is not null
        ),
        'sync_runs_24h', (
          select count(*)::bigint
          from scoped_sync_runs
          where started_at >= now() - interval '24 hours'
        ),
        'failed_syncs_24h', (
          select count(*)::bigint
          from scoped_sync_runs
          where started_at >= now() - interval '24 hours'
            and status in ('FAILED', 'ERROR')
        )
      ),
      'provider_summary', coalesce((
        select jsonb_agg(jsonb_build_object(
          'provider_key', provider_key,
          'connections', connections,
          'attention_connections', attention_connections,
          'sync_runs_7d', sync_runs_7d
        ) order by attention_connections desc, connections desc, provider_key)
        from (
          select
            connection_row.provider_key,
            count(*)::bigint as connections,
            count(*) filter (
              where connection_row.status in ('ERROR', 'DISCONNECTED')
                or connection_row.last_error_code is not null
            )::bigint as attention_connections,
            (
              select count(*)::bigint
              from scoped_sync_runs sync_row
              where sync_row.connected_account_id in (
                select visible_connection.id
                from visible_connections visible_connection
                where visible_connection.provider_key = connection_row.provider_key
              )
                and sync_row.started_at >= now() - interval '7 days'
            ) as sync_runs_7d
          from visible_connections connection_row
          group by connection_row.provider_key
        ) provider_row
      ), '[]'::jsonb),
      'attention_connections', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', connection_row.id,
          'provider_key', connection_row.provider_key,
          'display_name', connection_row.display_name,
          'scope_mode', connection_row.scope_mode,
          'status', connection_row.status,
          'last_tested_at', connection_row.last_tested_at,
          'last_sync_at', connection_row.last_sync_at,
          'last_error_code', connection_row.last_error_code,
          'visible_branch_names', connection_row.visible_branch_names
        ) order by connection_row.updated_at desc, connection_row.id desc)
        from (
          select *
          from visible_connections
          where status in ('ERROR', 'DISCONNECTED') or last_error_code is not null
          order by updated_at desc, id desc
          limit 25
        ) connection_row
      ), '[]'::jsonb),
      'recent_sync_runs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', sync_row.id,
          'connection_id', sync_row.connected_account_id,
          'provider_key', connection_row.provider_key,
          'display_name', connection_row.display_name,
          'sync_type', sync_row.sync_type,
          'status', sync_row.status,
          'records_processed', sync_row.records_processed,
          'started_at', sync_row.started_at,
          'completed_at', sync_row.completed_at
        ) order by sync_row.started_at desc, sync_row.id desc)
        from (
          select *
          from scoped_sync_runs
          order by started_at desc, id desc
          limit 25
        ) sync_row
        join visible_connections connection_row
          on connection_row.id = sync_row.connected_account_id
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_system_administrator_health_workspace() from public, anon;
grant execute on function public.get_system_administrator_health_workspace() to authenticated;
