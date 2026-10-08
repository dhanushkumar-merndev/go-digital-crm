begin;

-- The Audit Logs and Security pages read public.audit_logs straight through
-- RLS. Its policies call has_permission / mfa_policy_satisfied /
-- can_access_branch once per row, about 3 ms each, so returning the latest 8
-- rows of a 4,000-row table took 12 s as Super Admin: every row was checked
-- before the sort could stop. The answers depend only on (organization_id,
-- branch_id), and a user can see very few such pairs.
--
-- This RPC asks the same helpers once per pair the caller could possibly see,
-- then filters rows by plain array membership while walking the
-- (created_at, id) index. The policies are untouched: they still govern every
-- other read and every write.
--
-- Visibility matches audit_logs_read AND require_privileged_mfa:
--   * platform rows (organization_id null): is_platform_admin() and
--     mfa_policy_satisfied(null);
--   * tenant rows: mfa_policy_satisfied(org) and has_permission(org,
--     'audit.view') and, for a branch-less row, has_organization_wide_scope
--     (org), otherwise can_access_branch(org, branch).
-- has_permission is true for a tenant only through the caller's own profile
-- organization or a support session they requested, so those are the only
-- candidate organizations; any other organization fails the policy anyway.
create or replace function public.get_audit_log_page(
  target_action text default '',
  target_resource text default '',
  cursor_created_at timestamptz default null,
  cursor_id bigint default null,
  page_limit integer default 26
)
returns table (
  id bigint,
  action text,
  resource_type text,
  resource_id text,
  actor_id uuid,
  branch_id uuid,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  platform_rows boolean;
  readable_organization_ids uuid[];
  readable_scope_keys text[];
  action_term text := left(btrim(coalesce(target_action, '')), 80);
  resource_term text := left(btrim(coalesce(target_resource, '')), 80);
  row_limit integer := least(greatest(coalesce(page_limit, 26), 1), 201);
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if (cursor_created_at is null) <> (cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_CURSOR';
  end if;

  platform_rows := app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null::uuid);

  with candidate as (
    select profile_row.organization_id
    from public.profiles profile_row
    where profile_row.id = auth.uid()
      and profile_row.organization_id is not null
    union
    select session_row.organization_id
    from public.support_sessions session_row
    where session_row.requester_id = auth.uid()
  ), readable as (
    select candidate.organization_id
    from candidate
    where app_private.mfa_policy_satisfied(candidate.organization_id)
      and app_private.has_permission(candidate.organization_id, 'audit.view')
  ), scope_keys as (
    select readable.organization_id::text || '/*' as scope_key
    from readable
    where app_private.has_organization_wide_scope(readable.organization_id)
    union all
    select branch_row.organization_id::text || '/' || branch_row.id::text
    from public.branches branch_row
    join readable on readable.organization_id = branch_row.organization_id
    where branch_row.deleted_at is null
      and app_private.can_access_branch(branch_row.organization_id, branch_row.id)
  )
  select
    coalesce((select array_agg(readable.organization_id) from readable), '{}'),
    coalesce((select array_agg(scope_keys.scope_key) from scope_keys), '{}')
  into readable_organization_ids, readable_scope_keys;

  return query
  select log_row.id,
    log_row.action,
    log_row.resource_type,
    log_row.resource_id,
    log_row.actor_id,
    log_row.branch_id,
    log_row.metadata,
    log_row.created_at
  from public.audit_logs log_row
  where (
      (log_row.organization_id is null and platform_rows)
      or (
        log_row.organization_id = any (readable_organization_ids)
        and (log_row.organization_id::text || '/' || coalesce(log_row.branch_id::text, '*'))
          = any (readable_scope_keys)
      )
    )
    and (
      action_term = ''
      or log_row.action ilike '%' || replace(replace(replace(action_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
    and (
      resource_term = ''
      or log_row.resource_type ilike '%' || replace(replace(replace(resource_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
    and (
      cursor_created_at is null
      or log_row.created_at < cursor_created_at
      or (log_row.created_at = cursor_created_at and log_row.id < cursor_id)
    )
  order by log_row.created_at desc, log_row.id desc
  limit row_limit;
end;
$$;

revoke all on function public.get_audit_log_page(text, text, timestamptz, bigint, integer)
  from public, anon;
grant execute on function public.get_audit_log_page(text, text, timestamptz, bigint, integer)
  to authenticated;

commit;
