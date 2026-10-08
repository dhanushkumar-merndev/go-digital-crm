-- Dashboards and analytics now read Redis on every visit and rebuild an entry
-- once its data version moves. Two changes keep that version ledger cheap:
--
-- 1. One bump per transaction per scope/resource. A transaction's rows all
--    become visible at the same commit, so later bumps in it add nothing, and
--    a 1,000-row import used to rewrite the same ledger row 1,000 times.
-- 2. test_drives and tasks feed the dashboards but had no trigger, so starting
--    a drive or completing a task never marked the cached aggregate out of date.

begin;

create or replace function app_private.bump_workspace_cache_version(
  target_organization_id uuid,
  target_resource_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare resolved_scope_key text;
declare bumped_setting text;
begin
  if target_resource_key not in ('tenant-dashboard', 'inventory-dashboard', 'platform-dashboard') then
    raise exception using errcode = '22023', message = 'INVALID_WORKSPACE_CACHE_RESOURCE';
  end if;
  if target_resource_key = 'platform-dashboard' then
    resolved_scope_key := 'platform';
  elsif target_organization_id is not null then
    resolved_scope_key := 'tenant:' || target_organization_id::text;
  else
    return;
  end if;

  -- Transaction-local marker: reset at commit or rollback, invisible to other sessions.
  bumped_setting := 'app.cache_bumped_'
    || pg_catalog.md5(resolved_scope_key || '|' || target_resource_key);
  if pg_catalog.current_setting(bumped_setting, true) = '1' then
    return;
  end if;

  insert into public.workspace_cache_versions as cache_version (
    scope_key, resource_key, version, updated_at
  ) values (
    resolved_scope_key, target_resource_key, 1, now()
  ) on conflict (scope_key, resource_key) do update
    set version = cache_version.version + 1,
        updated_at = excluded.updated_at;

  perform pg_catalog.set_config(bumped_setting, '1', true);
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['test_drives', 'tasks'] loop
    execute format('drop trigger if exists workspace_cache_tenant_dashboard on public.%I', table_name);
    execute format(
      'create trigger workspace_cache_tenant_dashboard after insert or update or delete on public.%I for each row execute function app_private.bump_workspace_cache_versions_from_row(''tenant-dashboard'')',
      table_name
    );
  end loop;
end;
$$;

commit;
