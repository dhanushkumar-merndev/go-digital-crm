-- Assignment queues are read-only projections. Mutations continue to use the
-- locking, eligibility-checked and audited public.assign_lead transaction.
-- These indexes cover the oldest-unassigned queue, phone search, consultant
-- load rollup and the bounded recent-assignment feed at 100k-lead scale.
create index concurrently if not exists leads_assignment_unassigned_org_oldest_idx
  on public.leads (organization_id, created_at, id)
  include (branch_id, team_id)
  where deleted_at is null and assigned_user_id is null;

create index concurrently if not exists leads_team_unassigned_queue_idx
  on public.leads (organization_id, team_id, created_at desc, id desc)
  where deleted_at is null and assigned_user_id is null;

create index concurrently if not exists leads_assignment_phone_trgm_idx
  on public.leads using gin (normalized_phone gin_trgm_ops)
  where deleted_at is null
    and assigned_user_id is null
    and normalized_phone is not null;

create index concurrently if not exists leads_assignment_consultant_load_idx
  on public.leads (organization_id, team_id, assigned_user_id)
  include (temperature)
  where deleted_at is null
    and assigned_user_id is not null
    and lifecycle_status <> 'Lost';

create index concurrently if not exists lead_assignment_history_team_recent_idx
  on public.lead_assignment_history (
    organization_id,
    team_id,
    created_at desc,
    id desc
  );

begin;

-- Both role-specific public RPCs use the same bounded read implementation.
-- This helper is deliberately private and cannot be called by authenticated
-- clients; each public wrapper resolves and verifies its own role-bound scope.
create or replace function app_private.build_lead_assignment_workspace(
  target_organization_id uuid,
  target_actor_id uuid,
  target_team_ids uuid[],
  target_search text,
  target_page integer,
  target_page_size integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  escaped_search text;
  search_phone_digits text;
  offset_value bigint;
  total_result bigint := 0;
  records_result jsonb := '[]'::jsonb;
  consultants_result jsonb := '[]'::jsonb;
  recent_assignments_result jsonb := '[]'::jsonb;
begin
  if target_actor_id is null
    or target_actor_id is distinct from auth.uid()
    or target_organization_id is null
    or coalesce(cardinality(target_team_ids), 0) = 0
  then
    raise exception using
      errcode = '42501',
      message = 'ASSIGNMENT_WORKSPACE_SCOPE_REQUIRED';
  end if;

  if target_page is null
    or target_page < 1
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 160
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ASSIGNMENT_WORKSPACE_QUERY';
  end if;

  offset_value := (target_page::bigint - 1) * target_page_size::bigint;
  -- Offset pagination is retained for the public contract, but callers cannot
  -- request work beyond the supported 100k-lead operational window.
  if offset_value > 100000 then
    raise exception using
      errcode = '22023',
      message = 'ASSIGNMENT_PAGE_WINDOW_EXCEEDED';
  end if;

  -- Treat SQL LIKE metacharacters as literal user input. Phone matching is
  -- gated separately so a name such as "Asha" cannot become LIKE '%%'.
  escaped_search := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(
        normalized_search,
        pg_catalog.chr(92),
        pg_catalog.chr(92) || pg_catalog.chr(92)
      ),
      '%',
      pg_catalog.chr(92) || '%'
    ),
    '_',
    pg_catalog.chr(92) || '_'
  );
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);

  if normalized_search = '' then
    select count(*)::bigint
    into total_result
    from public.leads lead_row
    where lead_row.organization_id = target_organization_id
      and lead_row.team_id = any(target_team_ids)
      and lead_row.assigned_user_id is null
      and lead_row.deleted_at is null;

    with page_ids as materialized (
      select
        lead_row.id,
        lead_row.team_id,
        lead_row.created_at
      from public.leads lead_row
      where lead_row.organization_id = target_organization_id
        and lead_row.team_id = any(target_team_ids)
        and lead_row.assigned_user_id is null
        and lead_row.deleted_at is null
      order by lead_row.created_at, lead_row.id
      offset offset_value
      limit target_page_size
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', lead_row.id,
          'team_id', lead_row.team_id,
          'team_name', team_row.name,
          'customer_id', lead_row.customer_id,
          'customer_name', lead_row.customer_name,
          'phone', lead_row.phone,
          'source', lead_row.source,
          'interested_model', lead_row.interested_model,
          'lifecycle_status', lead_row.lifecycle_status::text,
          'temperature', lead_row.temperature::text,
          'created_at', lead_row.created_at,
          'assignment_kind', case
            when lead_row.lifecycle_status = 'Qualified' then 'QUALIFIED'
            else 'FRESH'
          end,
          'assignment_mode', case
            when lead_row.lifecycle_status = 'Qualified'
              then team_row.qualified_assignment_mode::text
            else team_row.fresh_assignment_mode::text
          end
        )
        order by page_row.created_at, page_row.id
      ),
      '[]'::jsonb
    )
    into records_result
    from page_ids page_row
    join public.leads lead_row
      on lead_row.organization_id = target_organization_id
     and lead_row.id = page_row.id
     and lead_row.team_id = page_row.team_id
     and lead_row.assigned_user_id is null
     and lead_row.deleted_at is null
    join public.teams team_row
      on team_row.organization_id = lead_row.organization_id
     and team_row.id = lead_row.team_id
     and team_row.active;
  else
    select count(*)::bigint
    into total_result
    from public.leads lead_row
    where lead_row.organization_id = target_organization_id
      and lead_row.team_id = any(target_team_ids)
      and lead_row.assigned_user_id is null
      and lead_row.deleted_at is null
      and (
        lead_row.id::text ilike '%' || escaped_search || '%' escape E'\\'
        or lower(lead_row.customer_name)
          like '%' || escaped_search || '%' escape E'\\'
        or (
          search_phone_digits <> ''
          and lead_row.normalized_phone
            like '%' || search_phone_digits || '%'
        )
      );

    with page_ids as materialized (
      select
        lead_row.id,
        lead_row.team_id,
        lead_row.created_at
      from public.leads lead_row
      where lead_row.organization_id = target_organization_id
        and lead_row.team_id = any(target_team_ids)
        and lead_row.assigned_user_id is null
        and lead_row.deleted_at is null
        and (
          lead_row.id::text ilike '%' || escaped_search || '%' escape E'\\'
          or lower(lead_row.customer_name)
            like '%' || escaped_search || '%' escape E'\\'
          or (
            search_phone_digits <> ''
            and lead_row.normalized_phone
              like '%' || search_phone_digits || '%'
          )
        )
      order by lead_row.created_at, lead_row.id
      offset offset_value
      limit target_page_size
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', lead_row.id,
          'team_id', lead_row.team_id,
          'team_name', team_row.name,
          'customer_id', lead_row.customer_id,
          'customer_name', lead_row.customer_name,
          'phone', lead_row.phone,
          'source', lead_row.source,
          'interested_model', lead_row.interested_model,
          'lifecycle_status', lead_row.lifecycle_status::text,
          'temperature', lead_row.temperature::text,
          'created_at', lead_row.created_at,
          'assignment_kind', case
            when lead_row.lifecycle_status = 'Qualified' then 'QUALIFIED'
            else 'FRESH'
          end,
          'assignment_mode', case
            when lead_row.lifecycle_status = 'Qualified'
              then team_row.qualified_assignment_mode::text
            else team_row.fresh_assignment_mode::text
          end
        )
        order by page_row.created_at, page_row.id
      ),
      '[]'::jsonb
    )
    into records_result
    from page_ids page_row
    join public.leads lead_row
      on lead_row.organization_id = target_organization_id
     and lead_row.id = page_row.id
     and lead_row.team_id = page_row.team_id
     and lead_row.assigned_user_id is null
     and lead_row.deleted_at is null
    join public.teams team_row
      on team_row.organization_id = lead_row.organization_id
     and team_row.id = lead_row.team_id
     and team_row.active;
  end if;

  -- Aggregate lead load once per consultant before joining the small active
  -- member set. This replaces the prior member-to-leads fanout and GROUP BY.
  with lead_loads as materialized (
    select
      lead_row.team_id,
      lead_row.assigned_user_id as user_id,
      count(*)::bigint as current_leads,
      count(*) filter (where lead_row.temperature = 'HOT')::bigint as hot_leads
    from public.leads lead_row
    where lead_row.organization_id = target_organization_id
      and lead_row.team_id = any(target_team_ids)
      and lead_row.assigned_user_id is not null
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
    group by lead_row.team_id, lead_row.assigned_user_id
  ), consultant_rows as materialized (
    select
      member_row.user_id,
      member_row.team_id,
      profile_row.full_name,
      member_row.eligible_for_fresh_leads,
      member_row.eligible_for_qualified_leads,
      coalesce(load_row.current_leads, 0::bigint) as current_leads,
      coalesce(load_row.hot_leads, 0::bigint) as hot_leads
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.organization_id = member_row.organization_id
     and profile_row.id = member_row.user_id
     and profile_row.active
     and profile_row.deleted_at is null
    left join lead_loads load_row
      on load_row.team_id = member_row.team_id
     and load_row.user_id = member_row.user_id
    where member_row.organization_id = target_organization_id
      and member_row.team_id = any(target_team_ids)
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id', row.user_id,
        'team_id', row.team_id,
        'full_name', row.full_name,
        'eligible_for_fresh_leads', row.eligible_for_fresh_leads,
        'eligible_for_qualified_leads', row.eligible_for_qualified_leads,
        'current_leads', row.current_leads,
        'hot_leads', row.hot_leads
      )
      order by row.current_leads, row.full_name
    ),
    '[]'::jsonb
  )
  into consultants_result
  from consultant_rows row;

  -- Limit history IDs before touching lead/customer PII or profile display data.
  with history_ids as materialized (
    select
      history_row.id,
      history_row.created_at
    from public.lead_assignment_history history_row
    where history_row.organization_id = target_organization_id
      and history_row.team_id = any(target_team_ids)
    order by history_row.created_at desc, history_row.id desc
    limit 25
  ), history_rows as materialized (
    select
      history_row.id,
      history_row.lead_id,
      history_row.method::text as method,
      history_row.reason,
      history_row.created_at,
      lead_row.customer_name,
      profile_row.full_name as assigned_to_name,
      actor_row.full_name as assigned_by_name
    from history_ids history_id_row
    join public.lead_assignment_history history_row
      on history_row.organization_id = target_organization_id
     and history_row.id = history_id_row.id
    join public.leads lead_row
      on lead_row.organization_id = history_row.organization_id
     and lead_row.id = history_row.lead_id
    join public.profiles profile_row
      on profile_row.organization_id = history_row.organization_id
     and profile_row.id = history_row.new_owner_id
    left join public.profiles actor_row
      on actor_row.organization_id = history_row.organization_id
     and actor_row.id = history_row.assigned_by
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', row.id,
        'lead_id', row.lead_id,
        'customer_name', row.customer_name,
        'assigned_to_name', row.assigned_to_name,
        'assigned_by_name', row.assigned_by_name,
        'method', row.method,
        'reason', row.reason,
        'created_at', row.created_at
      )
      order by row.created_at desc, row.id desc
    ),
    '[]'::jsonb
  )
  into recent_assignments_result
  from history_rows row;

  return jsonb_build_object(
    'total', total_result,
    'records', records_result,
    'consultants', consultants_result,
    'recent_assignments', recent_assignments_result
  );
end;
$$;

revoke all on function app_private.build_lead_assignment_workspace(
  uuid,
  uuid,
  uuid[],
  text,
  integer,
  integer
) from public, anon, authenticated;

create or replace function public.get_team_lead_assignment_workspace(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  managed_team_ids uuid[];
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  offset_value bigint;
begin
  if target_page is null
    or target_page < 1
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_PAGE';
  end if;
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_SEARCH';
  end if;
  offset_value := (target_page::bigint - 1) * target_page_size::bigint;
  if offset_value > 100000 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_PAGE_WINDOW_EXCEEDED';
  end if;

  access_context := public.get_access_context();
  if current_user_id is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'team-manager'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
     and role_row.role_key = 'team_manager'
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = assignment_row.role_id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'lead.assign'
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = current_user_id
      and assignment_row.active
  ) then
    raise exception using
      errcode = '42501',
      message = 'TEAM_MANAGER_LEAD_ASSIGN_REQUIRED';
  end if;

  -- The lead.assign permission and scope must come from the same active Team
  -- Manager role assignment. A permission on another role cannot widen this queue.
  select coalesce(
    array_agg(distinct team_row.id order by team_row.id),
    array[]::uuid[]
  )
  into managed_team_ids
  from public.teams team_row
  join public.branches branch_row
    on branch_row.organization_id = team_row.organization_id
   and branch_row.id = team_row.branch_id
   and branch_row.active
   and branch_row.deleted_at is null
  where team_row.organization_id = current_organization_id
    and team_row.manager_id = current_user_id
    and team_row.active
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.organization_id = assignment_row.organization_id
       and role_row.id = assignment_row.role_id
       and role_row.role_key = 'team_manager'
      join public.role_permissions role_permission_row
        on role_permission_row.role_id = assignment_row.role_id
      join public.permissions permission_row
        on permission_row.id = role_permission_row.permission_id
       and permission_row.permission_key = 'lead.assign'
      where assignment_row.organization_id = current_organization_id
        and assignment_row.user_id = current_user_id
        and assignment_row.active
        and (
          assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES', 'OWN_TEAM')
          or (
            assignment_row.data_scope = 'ONE_BRANCH'
            and assignment_row.scope_branch_id = team_row.branch_id
          )
          or (
            assignment_row.data_scope = 'SELECTED_BRANCHES'
            and team_row.branch_id = any(assignment_row.selected_branch_ids)
          )
        )
    );

  if cardinality(managed_team_ids) = 0 then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_TEAM_REQUIRED';
  end if;

  return app_private.build_lead_assignment_workspace(
    current_organization_id,
    current_user_id,
    managed_team_ids,
    target_search,
    target_page,
    target_page_size
  );
end;
$$;

revoke all on function public.get_team_lead_assignment_workspace(
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.get_team_lead_assignment_workspace(
  text,
  integer,
  integer
) to authenticated;

create or replace function public.get_showroom_lead_assignment_workspace(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  allowed_branch_ids uuid[];
  scoped_team_ids uuid[];
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  offset_value bigint;
begin
  if target_page is null
    or target_page < 1
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 160
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_SHOWROOM_ASSIGNMENT_QUERY';
  end if;
  offset_value := (target_page::bigint - 1) * target_page_size::bigint;
  if offset_value > 100000 then
    raise exception using
      errcode = '22023',
      message = 'ASSIGNMENT_PAGE_WINDOW_EXCEEDED';
  end if;

  access_context := public.get_access_context();
  if current_user_id is null
    or access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'showroom-manager'
    or access_context->>'organization_id' is null
  then
    raise exception using
      errcode = '42501',
      message = 'SHOWROOM_ASSIGNMENT_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
     and role_row.role_key = 'showroom_manager'
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = assignment_row.role_id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
     and permission_row.permission_key = 'lead.assign'
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = current_user_id
      and assignment_row.active
  ) then
    raise exception using
      errcode = '42501',
      message = 'SHOWROOM_LEAD_ASSIGN_PERMISSION_REQUIRED';
  end if;

  -- Resolve only branches admitted by an active Showroom Manager assignment
  -- whose own role carries lead.assign. Do not union scopes from unrelated roles.
  select coalesce(
    array_agg(distinct branch_row.id order by branch_row.id),
    array[]::uuid[]
  )
  into allowed_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.organization_id = assignment_row.organization_id
       and role_row.id = assignment_row.role_id
       and role_row.role_key = 'showroom_manager'
      join public.role_permissions role_permission_row
        on role_permission_row.role_id = assignment_row.role_id
      join public.permissions permission_row
        on permission_row.id = role_permission_row.permission_id
       and permission_row.permission_key = 'lead.assign'
      where assignment_row.organization_id = current_organization_id
        and assignment_row.user_id = current_user_id
        and assignment_row.active
        and (
          assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
          or (
            assignment_row.data_scope = 'ONE_BRANCH'
            and assignment_row.scope_branch_id = branch_row.id
          )
          or (
            assignment_row.data_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(assignment_row.selected_branch_ids)
          )
        )
    );

  if cardinality(allowed_branch_ids) = 0 then
    raise exception using
      errcode = '42501',
      message = 'SHOWROOM_BRANCH_SCOPE_REQUIRED';
  end if;

  select coalesce(
    array_agg(team_row.id order by team_row.id),
    array[]::uuid[]
  )
  into scoped_team_ids
  from public.teams team_row
  where team_row.organization_id = current_organization_id
    and team_row.branch_id = any(allowed_branch_ids)
    and team_row.active;

  if cardinality(scoped_team_ids) = 0 then
    raise exception using
      errcode = 'P0002',
      message = 'SHOWROOM_ASSIGNMENT_TEAMS_NOT_FOUND';
  end if;

  return app_private.build_lead_assignment_workspace(
    current_organization_id,
    current_user_id,
    scoped_team_ids,
    target_search,
    target_page,
    target_page_size
  );
end;
$$;

revoke all on function public.get_showroom_lead_assignment_workspace(
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.get_showroom_lead_assignment_workspace(
  text,
  integer,
  integer
) to authenticated;

commit;
