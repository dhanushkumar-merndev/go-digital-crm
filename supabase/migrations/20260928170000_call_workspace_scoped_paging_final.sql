begin;

-- 20260928150000 was pushed from a concurrent session while its function was
-- still being tuned, so production received the first draft. That draft let
-- the planner push can_access_record under the DISTINCT (one plpgsql access
-- check per call instead of per scope), nested two large CTEs when searching,
-- and read the whole scope for org-wide viewers -- a telecaller with 7.5k
-- calls timed out and org-wide viewers could not load the page at 300k calls.
--
-- This replaces it with the verified version (identical to the final text of
-- 20260928150000): scope checked once per (branch, team, owner), indexed
-- lookups when resolving parties, and an index walk for org-wide viewers.
-- The function is new and owned only by these two migrations, so replacing
-- the whole body reverts nothing.

-- The org-wide page walks calls in started order; the org-wide counts are
-- answered from the narrow covering index without touching call rows.
create index if not exists calls_org_started_page_idx
  on public.calls (organization_id, started_at desc, id);
create index if not exists calls_org_branch_filter_idx
  on public.calls (organization_id, branch_id, status, outcome, call_source, started_at);

create or replace function app_private.get_scoped_call_workspace_page(
  target_search text,
  target_page integer,
  target_page_size integer,
  target_status text,
  target_outcome text,
  target_source text,
  target_sort text,
  target_view text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
  normalized_outcome text := upper(btrim(coalesce(target_outcome, 'ALL')));
  normalized_source text := upper(btrim(coalesce(target_source, 'ALL')));
  normalized_view text := upper(btrim(coalesce(target_view, 'HISTORY')));
  customer_access boolean;
  lead_access boolean;
  broad_scope boolean;
  scope_branch_ids uuid[];
  scope_team_ids uuid[];
  own_records boolean;
  needs_parties boolean;
  local_today date := pg_catalog.timezone('Asia/Kolkata', now())::date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  trend_start timestamptz;
  no_team constant uuid := '00000000-0000-0000-0000-000000000000';
  windowed boolean;
  visible_branch_ids uuid[];
  page_id_list uuid[];
  total_count bigint;
  kpi_json jsonb;
  trend_json jsonb;
  result jsonb;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in ('ALL', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_STATUS_FILTER';
  end if;
  if normalized_outcome not in (
    'ALL', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF',
    'CALLBACK_REQUIRED', 'WRONG_NUMBER', 'OTHER'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CALL_OUTCOME_FILTER';
  end if;
  if normalized_source not in ('ALL', 'PROVIDER', 'PERSONAL_MANUAL') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_SOURCE_FILTER';
  end if;
  if target_sort is null or target_sort not in (
    'started:desc', 'started:asc', 'duration:desc', 'duration:asc',
    'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CALL_SORT';
  end if;
  if normalized_view not in ('TODAY', 'HISTORY', 'MISSED', 'RECORDINGS', 'AI') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_VIEW';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = current_user_id
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  customer_access := app_private.has_permission(current_organization_id, 'customer.view');
  lead_access := app_private.has_permission(current_organization_id, 'lead.view');

  -- A superset of the calls can_access_record can admit, read from the
  -- viewer's own assignments so the scan touches only those calls: a
  -- telecaller reads their own calls, a team manager their teams', a branch
  -- manager their branches'. The exact rule is still applied below, once per
  -- distinct (branch, team, owner), so this only narrows what is read.
  select
    app_private.has_active_approved_support_session(current_organization_id)
      or coalesce(bool_or(assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')), false),
    coalesce(bool_or(assignment_row.data_scope = 'OWN_RECORDS'), false),
    coalesce(array_agg(distinct branch_id) filter (where branch_id is not null), '{}')
  into broad_scope, own_records, scope_branch_ids
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  left join lateral (
    select assignment_row.scope_branch_id as branch_id
    where assignment_row.data_scope = 'ONE_BRANCH'
    union all
    select unnest(assignment_row.selected_branch_ids)
    where assignment_row.data_scope = 'SELECTED_BRANCHES'
  ) branch_source on true
  where assignment_row.organization_id = current_organization_id
    and assignment_row.user_id = current_user_id
    and assignment_row.active;

  select coalesce(array_agg(distinct member_row.team_id), '{}')
  into scope_team_ids
  from public.team_members member_row
  where member_row.organization_id = current_organization_id
    and member_row.user_id = current_user_id
    and member_row.active
    and exists (
      select 1 from public.user_role_assignments assignment_row
      where assignment_row.organization_id = current_organization_id
        and assignment_row.user_id = current_user_id
        and assignment_row.active
        and assignment_row.data_scope = 'OWN_TEAM'
    );

  needs_parties := normalized_search <> '' or target_sort in ('customer:asc', 'customer:desc');
  today_start := pg_catalog.timezone('Asia/Kolkata', local_today::timestamp);
  tomorrow_start := pg_catalog.timezone('Asia/Kolkata', (local_today + 1)::timestamp);
  trend_start := pg_catalog.timezone('Asia/Kolkata', (local_today - 6)::timestamp);

  -- Org-wide and all-branches viewers on the default sort, without search:
  -- for them can_access_record depends only on the call's branch (their
  -- assignment admits any team and owner), so the page is read by walking
  -- calls_org_started_page_idx and stopping after one page, and the counts
  -- come from an index-only scan. Nothing reads the whole scope's rows.
  windowed := broad_scope and normalized_search = '' and target_sort = 'started:desc'
    and normalized_view in ('HISTORY', 'TODAY', 'MISSED');

  if windowed then
    select coalesce(array_agg(branch_row.id), '{}'::uuid[])
    into visible_branch_ids
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and app_private.can_access_record(current_organization_id, branch_row.id, null, null);

    select coalesce(array_agg(page_row.id order by page_row.started_at desc, page_row.id), '{}'::uuid[])
    into page_id_list
    from (
      select call_row.id, call_row.started_at
      from public.calls call_row
      where call_row.organization_id = current_organization_id
        and call_row.branch_id = any(visible_branch_ids)
        and (normalized_status = 'ALL' or upper(call_row.status) = normalized_status)
        and (normalized_outcome = 'ALL' or upper(call_row.outcome) = normalized_outcome)
        and (normalized_source = 'ALL' or upper(call_row.call_source) = normalized_source)
        and (
          normalized_view = 'HISTORY'
          or (normalized_view = 'TODAY'
            and call_row.started_at >= today_start
            and call_row.started_at < tomorrow_start)
          or (normalized_view = 'MISSED'
            and upper(coalesce(call_row.outcome, '')) in ('NO_ANSWER', 'BUSY', 'SWITCHED_OFF'))
        )
      order by call_row.started_at desc, call_row.id
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ) page_row;

    select count(*)
    into total_count
    from public.calls call_row
    where call_row.organization_id = current_organization_id
      and call_row.branch_id = any(visible_branch_ids)
      and (normalized_status = 'ALL' or upper(call_row.status) = normalized_status)
      and (normalized_outcome = 'ALL' or upper(call_row.outcome) = normalized_outcome)
      and (normalized_source = 'ALL' or upper(call_row.call_source) = normalized_source)
      and (
        normalized_view = 'HISTORY'
        or (normalized_view = 'TODAY'
          and call_row.started_at >= today_start
          and call_row.started_at < tomorrow_start)
        or (normalized_view = 'MISSED'
          and upper(coalesce(call_row.outcome, '')) in ('NO_ANSWER', 'BUSY', 'SWITCHED_OFF'))
      );

    with recent_calls as materialized (
      -- Only the last seven Asia/Kolkata days feed the KPIs and trend.
      select call_row.id, call_row.started_at, call_row.duration_seconds, call_row.outcome
      from public.calls call_row
      where call_row.organization_id = current_organization_id
        and call_row.branch_id = any(visible_branch_ids)
        and call_row.started_at >= trend_start
    ), today_kpis as (
      select
        count(*)::bigint as total_today,
        count(*) filter (
          where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
        )::bigint as connected_today,
        coalesce(sum(call_row.duration_seconds), 0)::bigint as talk_time_seconds,
        coalesce(round(avg(call_row.duration_seconds)), 0)::bigint as average_duration_seconds
      from recent_calls call_row
      where call_row.started_at >= today_start
        and call_row.started_at < tomorrow_start
    ), ready_recording_calls as (
      select distinct recording_row.call_id
      from public.call_recordings recording_row
      join recent_calls call_row on call_row.id = recording_row.call_id
      join public.object_files file_row
        on file_row.organization_id = recording_row.organization_id
       and file_row.id = recording_row.object_file_id
       and file_row.resource_type = 'call'
       and file_row.resource_id = recording_row.call_id
       and file_row.deleted_at is null
      where recording_row.organization_id = current_organization_id
        and call_row.started_at >= today_start
        and call_row.started_at < tomorrow_start
    ), trend_rows as (
      select
        day_source.metric_day,
        count(call_row.id)::integer as total,
        count(call_row.id) filter (
          where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
        )::integer as connected
      from (
        select generated_day::date as metric_day
        from pg_catalog.generate_series(local_today - 6, local_today, interval '1 day') generated_day
      ) day_source
      left join recent_calls call_row
        on call_row.started_at >= pg_catalog.timezone('Asia/Kolkata', day_source.metric_day::timestamp)
       and call_row.started_at < pg_catalog.timezone('Asia/Kolkata', (day_source.metric_day + 1)::timestamp)
       and call_row.started_at >= trend_start
      group by day_source.metric_day
    )
    select
    (
      select jsonb_build_object(
        'total_today', kpi_row.total_today,
        'connected_today', kpi_row.connected_today,
        'not_connected_today', greatest(kpi_row.total_today - kpi_row.connected_today, 0),
        'talk_time_seconds', kpi_row.talk_time_seconds,
        'connection_rate', case when kpi_row.total_today = 0 then 0
          else round(100.0 * kpi_row.connected_today / kpi_row.total_today, 1) end,
        'average_duration_seconds', kpi_row.average_duration_seconds,
        'callbacks_required', (
          select count(*) from public.calls callback_row
          where callback_row.organization_id = current_organization_id
            and callback_row.branch_id = any(visible_branch_ids)
            and upper(coalesce(callback_row.outcome, '')) = 'CALLBACK_REQUIRED'
        ),
        'recordings_ready', (select count(*) from ready_recording_calls)
      )
      from today_kpis kpi_row
    ),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', to_char(trend_row.metric_day, 'DD Mon'),
        'value', trend_row.total,
        'secondary', trend_row.connected
      ) order by trend_row.metric_day)
      from trend_rows trend_row
    ), '[]'::jsonb)
    into kpi_json, trend_json;
  else
    with candidate_calls as materialized (
      select
        call_row.id, call_row.branch_id, call_row.team_id, call_row.assigned_user_id,
        call_row.lead_id, call_row.customer_id, call_row.provider_call_id,
        call_row.call_source, call_row.started_at, call_row.duration_seconds,
        call_row.outcome, call_row.status
      from public.calls call_row
      where broad_scope
        and call_row.organization_id = current_organization_id
      union all
      select
        call_row.id, call_row.branch_id, call_row.team_id, call_row.assigned_user_id,
        call_row.lead_id, call_row.customer_id, call_row.provider_call_id,
        call_row.call_source, call_row.started_at, call_row.duration_seconds,
        call_row.outcome, call_row.status
      from public.calls call_row
      where not broad_scope
        and call_row.organization_id = current_organization_id
        and (
          call_row.branch_id = any(scope_branch_ids)
          or (own_records and call_row.assigned_user_id = current_user_id)
          or call_row.team_id = any(scope_team_ids)
        )
    ), candidate_scopes as materialized (
      -- Its own materialized CTE so the access check below cannot be pushed
      -- under the DISTINCT and run once per call instead of once per scope.
      select distinct
        call_row.branch_id,
        coalesce(call_row.team_id, no_team) as team_key,
        call_row.team_id,
        call_row.assigned_user_id
      from candidate_calls call_row
    ), visible_scopes as materialized (
      select scope_row.branch_id, scope_row.team_key, scope_row.assigned_user_id
      from candidate_scopes scope_row
      where app_private.can_access_record(
        current_organization_id,
        scope_row.branch_id,
        scope_row.team_id,
        scope_row.assigned_user_id
      )
    ), scoped_calls as materialized (
      select call_row.*
      from candidate_calls call_row
      join visible_scopes scope_row
        on scope_row.branch_id = call_row.branch_id
       and scope_row.team_key = coalesce(call_row.team_id, no_team)
       and scope_row.assigned_user_id = call_row.assigned_user_id
    ), view_recording_ids as materialized (
      select latest_recording.call_id
      from (
        select distinct on (recording_row.call_id)
          recording_row.call_id,
          recording_row.object_file_id
        from public.call_recordings recording_row
        join scoped_calls call_row on call_row.id = recording_row.call_id
        where normalized_view = 'RECORDINGS'
          and recording_row.organization_id = current_organization_id
        order by recording_row.call_id, recording_row.created_at desc, recording_row.id
      ) latest_recording
      join public.object_files file_row
        on file_row.organization_id = current_organization_id
       and file_row.id = latest_recording.object_file_id
       and file_row.resource_type = 'call'
       and file_row.resource_id = latest_recording.call_id
       and file_row.deleted_at is null
    ), view_ai_ids as materialized (
      select distinct summary_row.call_id
      from public.ai_call_summaries summary_row
      join scoped_calls call_row on call_row.id = summary_row.call_id
      where normalized_view = 'AI'
        and summary_row.organization_id = current_organization_id
    ), prefiltered_calls as materialized (
      -- The tab sets are probed with IN, which becomes a hashed lookup, rather
      -- than joined: the planner cannot size scoped_calls and would loop.
      select call_row.*
      from scoped_calls call_row
      where (normalized_status = 'ALL' or upper(call_row.status) = normalized_status)
        and (normalized_outcome = 'ALL' or upper(call_row.outcome) = normalized_outcome)
        and (normalized_source = 'ALL' or upper(call_row.call_source) = normalized_source)
        and (
          normalized_view = 'HISTORY'
          or (normalized_view = 'TODAY'
            and call_row.started_at >= today_start
            and call_row.started_at < tomorrow_start)
          or (normalized_view = 'MISSED'
            and upper(coalesce(call_row.outcome, '')) in ('NO_ANSWER', 'BUSY', 'SWITCHED_OFF'))
          or (normalized_view = 'RECORDINGS'
            and call_row.id in (select view_recording.call_id from view_recording_ids view_recording))
          or (normalized_view = 'AI'
            and call_row.id in (select view_ai.call_id from view_ai_ids view_ai))
        )
    ), party_lead_rows as materialized (
      select lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
      from public.leads lead_row
      where needs_parties
        and lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and lead_row.id in (
          select call_row.lead_id from prefiltered_calls call_row where call_row.lead_id is not null
        )
    ), party_lead_scopes as materialized (
      select distinct
        lead_row.branch_id,
        coalesce(lead_row.team_id, no_team) as team_key,
        lead_row.team_id,
        lead_row.assigned_user_id
      from party_lead_rows lead_row
    ), visible_party_lead_scopes as materialized (
      -- Lead visibility is decided once per distinct (branch, team, owner).
      select scope_row.branch_id, scope_row.team_key, scope_row.assigned_user_id
      from party_lead_scopes scope_row
      where app_private.can_access_record(
        current_organization_id,
        scope_row.branch_id,
        scope_row.team_id,
        scope_row.assigned_user_id
      )
    ), filter_parties as materialized (
      select
        call_row.*,
        case
          when party_row.customer_ok then customer_row.full_name
          when party_row.lead_ok then lead_row.customer_name
          else null
        end as customer_name,
        case
          when party_row.customer_ok
            then app_private.normalize_phone_digits(customer_row.normalized_phone)
          when party_row.lead_ok
            then app_private.normalize_phone_digits(lead_row.normalized_phone)
          else ''
        end as search_phone
      from prefiltered_calls call_row
      -- Indexed lookups against the base tables plus a join to the handful of
      -- visible lead scopes: never a join between two large CTEs, which the
      -- planner sizes at one row each and nests.
      left join public.leads lead_row
        on lead_row.organization_id = current_organization_id
       and lead_row.id = call_row.lead_id
       and lead_row.deleted_at is null
      left join visible_party_lead_scopes lead_scope
        on lead_row.id is not null
       and lead_scope.branch_id is not distinct from lead_row.branch_id
       and lead_scope.team_key = coalesce(lead_row.team_id, no_team)
       and lead_scope.assigned_user_id is not distinct from lead_row.assigned_user_id
      left join public.customers customer_row
        on customer_row.organization_id = current_organization_id
       and customer_row.id = coalesce(call_row.customer_id, lead_row.customer_id)
       and customer_row.deleted_at is null
      cross join lateral (
        select
          lead_access and lead_scope.team_key is not null as lead_ok,
          case
            when not customer_access or customer_row.id is null then false
            when lead_scope.team_key is not null
              and lead_row.customer_id = customer_row.id then true
            else app_private.can_access_customer(current_organization_id, customer_row.id)
          end as customer_ok
      ) party_row
      where needs_parties
    ), filtered_calls as materialized (
      -- Either every prefiltered call with its resolved party, or -- when no
      -- party is needed -- the prefiltered calls as they are. Never a join of
      -- the two, which the planner would size at one row and nest.
      select
        party_row.id, party_row.started_at, party_row.duration_seconds,
        party_row.customer_name as sort_customer_name
      from filter_parties party_row
      where needs_parties
        and (
          normalized_search = ''
          or party_row.id = search_uuid
          or lower(coalesce(party_row.customer_name, '')) like '%' || normalized_search || '%'
          or (
            search_phone_digits <> ''
            and party_row.search_phone like '%' || search_phone_digits || '%'
          )
          or lower(coalesce(party_row.provider_call_id, '')) like '%' || normalized_search || '%'
        )
      union all
      select call_row.id, call_row.started_at, call_row.duration_seconds, null::text
      from prefiltered_calls call_row
      where not needs_parties
    ), page_ids as materialized (
      select call_row.id, call_row.started_at, call_row.duration_seconds,
        call_row.sort_customer_name
      from filtered_calls call_row
      order by
        case when target_sort = 'started:desc' then call_row.started_at end desc,
        case when target_sort = 'started:asc' then call_row.started_at end asc,
        case when target_sort = 'duration:desc' then call_row.duration_seconds end desc nulls last,
        case when target_sort = 'duration:asc' then call_row.duration_seconds end asc nulls last,
        case when target_sort = 'customer:asc'
          then lower(call_row.sort_customer_name) end asc nulls last,
        case when target_sort = 'customer:desc'
          then lower(call_row.sort_customer_name) end desc nulls last,
        call_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), today_kpis as (
      select
        count(*)::bigint as total_today,
        count(*) filter (
          where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
        )::bigint as connected_today,
        coalesce(sum(call_row.duration_seconds), 0)::bigint as talk_time_seconds,
        coalesce(round(avg(call_row.duration_seconds)), 0)::bigint as average_duration_seconds
      from scoped_calls call_row
      where call_row.started_at >= today_start
        and call_row.started_at < tomorrow_start
    ), ready_recording_calls as (
      select distinct recording_row.call_id
      from public.call_recordings recording_row
      join scoped_calls call_row on call_row.id = recording_row.call_id
      join public.object_files file_row
        on file_row.organization_id = recording_row.organization_id
       and file_row.id = recording_row.object_file_id
       and file_row.resource_type = 'call'
       and file_row.resource_id = recording_row.call_id
       and file_row.deleted_at is null
      where recording_row.organization_id = current_organization_id
        and call_row.started_at >= today_start
        and call_row.started_at < tomorrow_start
    ), trend_rows as (
      select
        day_source.metric_day,
        count(call_row.id)::integer as total,
        count(call_row.id) filter (
          where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
        )::integer as connected
      from (
        select generated_day::date as metric_day
        from pg_catalog.generate_series(local_today - 6, local_today, interval '1 day') generated_day
      ) day_source
      left join scoped_calls call_row
        on call_row.started_at >= pg_catalog.timezone('Asia/Kolkata', day_source.metric_day::timestamp)
       and call_row.started_at < pg_catalog.timezone('Asia/Kolkata', (day_source.metric_day + 1)::timestamp)
       and call_row.started_at >= trend_start
      group by day_source.metric_day
    )
    select
      coalesce((
        select array_agg(page_id.id order by
          case when target_sort = 'started:desc' then page_id.started_at end desc,
          case when target_sort = 'started:asc' then page_id.started_at end asc,
          case when target_sort = 'duration:desc' then page_id.duration_seconds end desc nulls last,
          case when target_sort = 'duration:asc' then page_id.duration_seconds end asc nulls last,
          case when target_sort = 'customer:asc'
            then lower(page_id.sort_customer_name) end asc nulls last,
          case when target_sort = 'customer:desc'
            then lower(page_id.sort_customer_name) end desc nulls last,
          page_id.id asc
        )
        from page_ids page_id
      ), '{}'::uuid[]),
      (select count(*) from filtered_calls),
      (
        select jsonb_build_object(
          'total_today', kpi_row.total_today,
          'connected_today', kpi_row.connected_today,
          'not_connected_today', greatest(kpi_row.total_today - kpi_row.connected_today, 0),
          'talk_time_seconds', kpi_row.talk_time_seconds,
          'connection_rate', case when kpi_row.total_today = 0 then 0
            else round(100.0 * kpi_row.connected_today / kpi_row.total_today, 1) end,
          'average_duration_seconds', kpi_row.average_duration_seconds,
          'callbacks_required', (
            select count(*) from scoped_calls call_row
            where upper(coalesce(call_row.outcome, '')) = 'CALLBACK_REQUIRED'
          ),
          'recordings_ready', (select count(*) from ready_recording_calls)
        )
        from today_kpis kpi_row
      ),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', to_char(trend_row.metric_day, 'DD Mon'),
          'value', trend_row.total,
          'secondary', trend_row.connected
        ) order by trend_row.metric_day)
        from trend_rows trend_row
      ), '[]'::jsonb)
    into page_id_list, total_count, kpi_json, trend_json;
  end if;

  -- Names, access and enrichment for the page rows only, shared by both paths.
  with page_ids as materialized (
    select page_id.id, page_id.ord
    from unnest(page_id_list) with ordinality page_id(id, ord)
  ), page_base as materialized (
    select
      call_row.id, call_row.organization_id, call_row.branch_id, call_row.team_id,
      call_row.assigned_user_id, call_row.connection_id, call_row.lead_id as linked_lead_id,
      call_row.customer_id as linked_customer_id, call_row.provider_call_id,
      call_row.direction, call_row.call_source, call_row.started_at, call_row.ended_at,
      call_row.duration_seconds, call_row.outcome, call_row.status, call_row.version,
      call_row.updated_at, page_id.ord
    from page_ids page_id
    join public.calls call_row
      on call_row.organization_id = current_organization_id
     and call_row.id = page_id.id
  ), page_parties as materialized (
    select
      call_row.id,
      case when party_row.lead_ok then lead_row.id end as lead_id,
      case when party_row.customer_ok then customer_row.id end as customer_id,
      case
        when party_row.customer_ok then customer_row.full_name
        when party_row.lead_ok then lead_row.customer_name
        else null
      end as customer_name,
      case
        when party_row.customer_ok then customer_row.primary_phone
        when party_row.lead_ok then lead_row.phone
        else null
      end as phone
    from page_base call_row
    left join public.leads lead_row
      on lead_row.organization_id = current_organization_id
     and lead_row.id = call_row.linked_lead_id
     and lead_row.deleted_at is null
    left join public.customers customer_row
      on customer_row.organization_id = current_organization_id
     and customer_row.id = coalesce(call_row.linked_customer_id, lead_row.customer_id)
     and customer_row.deleted_at is null
    cross join lateral (
      select
        lead_row.id is not null
          and app_private.can_access_record(
            current_organization_id, lead_row.branch_id, lead_row.team_id,
            lead_row.assigned_user_id
          ) as lead_scope_ok
    ) scope_row
    cross join lateral (
      select
        lead_access and scope_row.lead_scope_ok as lead_ok,
        case
          when not customer_access or customer_row.id is null then false
          when scope_row.lead_scope_ok and lead_row.customer_id = customer_row.id then true
          else app_private.can_access_customer(current_organization_id, customer_row.id)
        end as customer_ok
    ) party_row
  ), page_rows as materialized (
    select
      page_row.*,
      party_row.lead_id,
      party_row.customer_id,
      party_row.customer_name,
      party_row.phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as caller_name,
      caller_role.role_name as caller_role,
      connection_row.display_name as provider_name,
      recording_row.status as recording_status,
      recording_row.object_file_id,
      transcript_row.status as transcript_status,
      summary_row.has_summary
    from page_base page_row
    join page_parties party_row on party_row.id = page_row.id
    join public.branches branch_row
      on branch_row.organization_id = page_row.organization_id
     and branch_row.id = page_row.branch_id
    left join public.teams team_row
      on team_row.organization_id = page_row.organization_id
     and team_row.branch_id = page_row.branch_id
     and team_row.id = page_row.team_id
    join public.profiles profile_row
      on profile_row.organization_id = page_row.organization_id
     and profile_row.id = page_row.assigned_user_id
    left join public.connected_accounts connection_row
      on connection_row.organization_id = page_row.organization_id
     and connection_row.id = page_row.connection_id
     and connection_row.deleted_at is null
    left join lateral (
      select role_row.name as role_name
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.organization_id = assignment_row.organization_id
       and role_row.id = assignment_row.role_id
      where assignment_row.organization_id = page_row.organization_id
        and assignment_row.user_id = page_row.assigned_user_id
        and assignment_row.active
      order by role_row.authority_level desc, role_row.id
      limit 1
    ) caller_role on true
    left join lateral (
      select
        recording_source.status,
        case when file_row.id is not null then recording_source.object_file_id end
          as object_file_id
      from public.call_recordings recording_source
      left join public.object_files file_row
        on file_row.organization_id = recording_source.organization_id
       and file_row.id = recording_source.object_file_id
       and file_row.resource_type = 'call'
       and file_row.resource_id = recording_source.call_id
       and file_row.deleted_at is null
      where recording_source.organization_id = page_row.organization_id
        and recording_source.call_id = page_row.id
      order by recording_source.created_at desc, recording_source.id
      limit 1
    ) recording_row on true
    left join lateral (
      select transcript_source.status
      from public.call_transcripts transcript_source
      where transcript_source.organization_id = page_row.organization_id
        and transcript_source.call_id = page_row.id
      order by transcript_source.created_at desc, transcript_source.id
      limit 1
    ) transcript_row on true
    left join lateral (
      select true as has_summary
      from public.ai_call_summaries summary_source
      where summary_source.organization_id = page_row.organization_id
        and summary_source.call_id = page_row.id
      limit 1
    ) summary_row on true
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', page_row.id,
        'organization_id', page_row.organization_id,
        'branch_id', page_row.branch_id,
        'team_id', page_row.team_id,
        'lead_id', page_row.lead_id,
        'customer_id', page_row.customer_id,
        'customer_name', page_row.customer_name,
        'phone', page_row.phone,
        'branch_name', page_row.branch_name,
        'team_name', page_row.team_name,
        'caller_name', page_row.caller_name,
        'caller_role', page_row.caller_role,
        'provider_name', page_row.provider_name,
        'provider_call_id', page_row.provider_call_id,
        'direction', page_row.direction,
        'call_source', page_row.call_source,
        'started_at', page_row.started_at,
        'ended_at', page_row.ended_at,
        'duration_seconds', page_row.duration_seconds,
        'outcome', page_row.outcome,
        'status', page_row.status,
        'recording_status', page_row.recording_status,
        'recording_available', page_row.object_file_id is not null,
        'transcript_status', page_row.transcript_status,
        'ai_summary_available', coalesce(page_row.has_summary, false),
        'version', page_row.version,
        'updated_at', page_row.updated_at
      ) order by page_row.ord)
      from page_rows page_row
    ), '[]'::jsonb),
    'total', total_count,
    'kpis', kpi_json,
    'trend', trend_json
  ) into result;

  return result;
end;
$function$;

revoke all on function app_private.get_scoped_call_workspace_page(
  text, integer, integer, text, text, text, text, text
) from public, anon, authenticated;

commit;
