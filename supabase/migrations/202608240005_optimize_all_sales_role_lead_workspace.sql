-- The owner and organization-wide updated-order paths already have matching
-- indexes. These are the two missing manager paths used by the shared lead
-- workspace when the default updated:desc sort is selected.
create index concurrently if not exists leads_team_updated_active_idx
  on public.leads (organization_id, team_id, updated_at desc, id desc)
  where deleted_at is null;

create index concurrently if not exists leads_branch_updated_active_idx
  on public.leads (organization_id, branch_id, updated_at desc, id desc)
  where deleted_at is null;

begin;

-- Resolve the permission union and the complete assignment-scope union once
-- per request. Keep branch-wide access separate from branch membership:
-- user_branch_access and team membership validate OWN_RECORDS, but must never
-- grant access to every record in that branch.
create or replace function app_private.resolve_sales_lead_workspace_scope(
  target_organization_id uuid
)
returns table (
  permission_keys text[],
  organization_wide boolean,
  branch_scope_ids uuid[],
  team_scope_ids uuid[],
  owner_scope boolean,
  owner_branch_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with active_assignments as materialized (
    select
      assignment_row.role_id,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and exists (
        select 1
        from public.role_permissions lead_role_permission_row
        join public.permissions lead_permission_row
          on lead_permission_row.id = lead_role_permission_row.permission_id
        where lead_role_permission_row.role_id = assignment_row.role_id
          and lead_permission_row.permission_key = 'lead.view'
      )
  ), active_branches as materialized (
    select branch_row.id
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ), permission_union as (
    select distinct permission_row.permission_key
    from active_assignments assignment_row
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = assignment_row.role_id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
  ), branch_scope as (
    select distinct branch_row.id
    from active_assignments assignment_row
    join active_branches branch_row
      on (
        assignment_row.data_scope = 'ONE_BRANCH'
        and branch_row.id = assignment_row.scope_branch_id
      ) or (
        assignment_row.data_scope = 'SELECTED_BRANCHES'
        and branch_row.id = any(assignment_row.selected_branch_ids)
      )
  ), team_scope as (
    select distinct member_row.team_id
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
    join active_branches branch_row on branch_row.id = team_row.branch_id
    where member_row.organization_id = target_organization_id
      and member_row.user_id = auth.uid()
      and member_row.active
      and exists (
        select 1
        from active_assignments assignment_row
        where assignment_row.data_scope = 'OWN_TEAM'
      )
  ), owner_branch_candidates as (
    select access_row.branch_id
    from public.user_branch_access access_row
    where access_row.organization_id = target_organization_id
      and access_row.user_id = auth.uid()
      and access_row.active
    union
    select team_row.branch_id
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
    where member_row.organization_id = target_organization_id
      and member_row.user_id = auth.uid()
      and member_row.active
  ), owner_branches as (
    select distinct branch_row.id
    from owner_branch_candidates candidate_row
    join active_branches branch_row on branch_row.id = candidate_row.branch_id
    where exists (
      select 1
      from active_assignments assignment_row
      where assignment_row.data_scope = 'OWN_RECORDS'
    )
  )
  select
    coalesce(
      (select array_agg(permission_key order by permission_key) from permission_union),
      array[]::text[]
    ),
    exists (
      select 1
      from active_assignments assignment_row
      where assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
    ),
    coalesce(
      (select array_agg(id order by id) from branch_scope),
      array[]::uuid[]
    ),
    coalesce(
      (select array_agg(team_id order by team_id) from team_scope),
      array[]::uuid[]
    ),
    exists (
      select 1
      from active_assignments assignment_row
      where assignment_row.data_scope = 'OWN_RECORDS'
    ),
    coalesce(
      (select array_agg(id order by id) from owner_branches),
      array[]::uuid[]
    );
$$;

revoke all on function app_private.resolve_sales_lead_workspace_scope(uuid)
  from public, anon, authenticated;

create or replace function app_private.get_sales_role_lead_workspace_page(
  target_organization_id uuid,
  target_actor_id uuid,
  target_organization_wide boolean,
  target_branch_scope_ids uuid[],
  target_team_scope_ids uuid[],
  target_owner_scope boolean,
  target_owner_branch_ids uuid[],
  target_page integer,
  target_page_size integer,
  target_search text,
  target_status text,
  target_sort text,
  target_model text,
  target_source text,
  target_stage text,
  target_temperature text,
  target_followup_from date,
  target_followup_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text;
  search_phone_digits text;
  search_lead_id uuid;
  normalized_model text;
  normalized_source text;
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  query_now timestamptz := now();
begin
  if target_organization_id is null
    or target_actor_id is null
    or target_actor_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;
  if target_page is null or target_page < 1
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_status is null or target_status not in (
      'all', 'hot', 'warm', 'cold', 'follow-up', 'test-drive', 'quotation', 'booking',
      'new', 'contacted', 'qualified', 'appointment-scheduled', 'transferred-to-sales',
      'lost', 'new-today', 'pending', 'sla-risk'
    )
    or target_stage is null or target_stage not in (
      'all', 'New', 'Contacted', 'Qualified', 'Appointment Scheduled',
      'Transferred to Sales', 'Lost', 'Test Drive', 'Quotation', 'Booking'
    )
    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD')
    or target_sort is null or target_sort not in (
      'updated:desc', 'updated:asc', 'created:desc', 'created:asc',
      'customer:asc', 'customer:desc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)
  then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_WORKSPACE_QUERY';
  end if;

  normalized_search := left(
    btrim(regexp_replace(coalesce(target_search, ''), '[^[:alnum:] @+_-]+', '', 'g')),
    160
  );
  search_phone_digits := coalesce(
    app_private.normalize_phone_digits(normalized_search),
    ''
  );
  normalized_model := nullif(left(btrim(coalesce(target_model, '')), 160), '');
  normalized_source := nullif(left(btrim(coalesce(target_source, '')), 100), '');
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_lead_id := normalized_search::uuid;
  end if;
  if target_followup_from is not null then
    followup_from_at := pg_catalog.timezone(
      'Asia/Kolkata',
      target_followup_from::timestamp
    );
  end if;
  if target_followup_to is not null then
    followup_to_exclusive_at := pg_catalog.timezone(
      'Asia/Kolkata',
      (target_followup_to + 1)::timestamp
    );
  end if;

  return (
    with scoped_leads as materialized (
      select
        lead_row.id,
        lead_row.source,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        lead_row.first_contacted_at,
        lead_row.sla_due_at,
        lead_row.created_at,
        lead_row.updated_at,
        lead_row.next_followup_at,
        case
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and query_now > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and query_now >= lead_row.created_at + interval '24 hours' then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
        and (
          target_organization_wide
          or lead_row.branch_id = any(target_branch_scope_ids)
          or (
            lead_row.team_id is not null
            and lead_row.team_id = any(target_team_scope_ids)
          )
          or (
            target_owner_scope
            and lead_row.assigned_user_id = target_actor_id
            and lead_row.branch_id = any(target_owner_branch_ids)
          )
        )
    ), test_drive_leads as materialized (
      select distinct drive_row.lead_id
      from public.test_drive_appointments drive_row
      join scoped_leads lead_row on lead_row.id = drive_row.lead_id
      where drive_row.organization_id = target_organization_id
        and drive_row.lead_id is not null
    ), quotation_leads as materialized (
      select distinct quotation_row.lead_id
      from public.quotations quotation_row
      join scoped_leads lead_row on lead_row.id = quotation_row.lead_id
      where quotation_row.organization_id = target_organization_id
        and quotation_row.lead_id is not null
        and quotation_row.deleted_at is null
    ), booking_leads as materialized (
      select distinct booking_row.lead_id
      from public.bookings booking_row
      join scoped_leads lead_row on lead_row.id = booking_row.lead_id
      where booking_row.organization_id = target_organization_id
        and booking_row.lead_id is not null
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
    ), lead_flags as materialized (
      select
        lead_row.*,
        drive_row.lead_id is not null as has_test_drive,
        quotation_row.lead_id is not null as has_quotation,
        booking_row.lead_id is not null as has_booking
      from scoped_leads lead_row
      left join test_drive_leads drive_row on drive_row.lead_id = lead_row.id
      left join quotation_leads quotation_row on quotation_row.lead_id = lead_row.id
      left join booking_leads booking_row on booking_row.lead_id = lead_row.id
    ), staged_leads as materialized (
      select
        lead_row.*,
        case
          when lead_row.has_booking then 'Booking'
          when lead_row.has_quotation then 'Quotation'
          when lead_row.has_test_drive then 'Test Drive'
          else lead_row.lifecycle_status::text
        end as lead_stage
      from lead_flags lead_row
    ), filtered_lead_ids as materialized (
      select
        lead_row.id,
        lead_row.updated_at,
        lead_row.created_at,
        lead_row.customer_name
      from staged_leads lead_row
      where (
        target_status = 'all'
        or (target_status = 'hot' and lead_row.temperature = 'HOT')
        or (target_status = 'warm' and lead_row.temperature = 'WARM')
        or (target_status = 'cold' and lead_row.temperature = 'COLD')
        or (target_status = 'follow-up' and lead_row.next_followup_at is not null)
        or (target_status = 'test-drive' and lead_row.has_test_drive)
        or (target_status = 'quotation' and lead_row.has_quotation)
        or (target_status = 'booking' and lead_row.has_booking)
        or (target_status = 'new' and lead_row.lifecycle_status = 'New')
        or (target_status = 'contacted' and lead_row.lifecycle_status = 'Contacted')
        or (target_status = 'qualified' and lead_row.lifecycle_status = 'Qualified')
        or (target_status = 'appointment-scheduled'
          and lead_row.lifecycle_status = 'Appointment Scheduled')
        or (target_status = 'transferred-to-sales'
          and lead_row.lifecycle_status = 'Transferred to Sales')
        or (target_status = 'lost' and lead_row.lifecycle_status = 'Lost')
        or (target_status = 'new-today' and lead_row.work_state = 'NEW_TODAY')
        or (target_status = 'pending' and lead_row.work_state = 'PENDING')
        or (target_status = 'sla-risk' and lead_row.work_state = 'SLA_RISK')
      )
      and (normalized_model is null or lead_row.interested_model = normalized_model)
      and (normalized_source is null or lead_row.source = normalized_source)
      and (target_stage = 'all' or lead_row.lead_stage = target_stage)
      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
      and (followup_from_at is null or lead_row.next_followup_at >= followup_from_at)
      and (
        followup_to_exclusive_at is null
        or lead_row.next_followup_at < followup_to_exclusive_at
      )
      and (
        normalized_search = ''
        or lead_row.id = search_lead_id
        -- `_` is valid sanitized input but is also a LIKE wildcard. Escape it so
        -- a literal underscore cannot turn a narrow name search into an
        -- accidental full-scope match.
        or lower(lead_row.customer_name) like
          '%' || replace(lower(normalized_search), '_', E'\\_') || '%'
          escape E'\\'
        or (
          search_phone_digits <> ''
          and (
            lead_row.normalized_phone = search_phone_digits
            or lead_row.normalized_phone like search_phone_digits || '%'
          )
        )
      )
    ), page_ids as materialized (
      select lead_row.id
      from filtered_lead_ids lead_row
      order by
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,
        case when target_sort = 'updated:desc' then lead_row.updated_at end desc nulls last,
        case when target_sort = 'created:asc' then lead_row.created_at end asc nulls last,
        case when target_sort = 'created:desc' then lead_row.created_at end desc nulls last,
        case when target_sort = 'customer:asc' then lead_row.customer_name end asc nulls last,
        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        lead_row.id desc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        lead_row.id,
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.customer_id,
        lead_row.source,
        lead_row.customer_name,
        lead_row.phone,
        lead_row.normalized_phone,
        lead_row.email,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        lead_row.lost_reason,
        lead_row.assigned_user_id,
        stage_row.work_state,
        stage_row.lead_stage,
        lead_row.first_contacted_at,
        lead_row.sla_due_at,
        lead_row.next_followup_at,
        lead_row.created_at,
        lead_row.updated_at,
        profile_row.full_name as assigned_user_name
      from page_ids page_id
      join staged_leads stage_row on stage_row.id = page_id.id
      join public.leads lead_row
        on lead_row.organization_id = target_organization_id
       and lead_row.id = page_id.id
       and lead_row.deleted_at is null
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
       and profile_row.active
       and profile_row.deleted_at is null
    ), kpis as (
      select
        count(*)::bigint as total,
        count(*) filter (where temperature = 'HOT')::bigint as hot,
        count(*) filter (where temperature = 'WARM')::bigint as warm,
        count(*) filter (where temperature = 'COLD')::bigint as cold,
        count(*) filter (where next_followup_at is not null)::bigint as follow_up,
        count(*) filter (where has_test_drive)::bigint as test_drive,
        count(*) filter (where has_quotation)::bigint as quotation,
        count(*) filter (where has_booking)::bigint as booking,
        count(*) filter (where work_state = 'NEW_TODAY')::bigint as new_today,
        count(*) filter (where work_state = 'PENDING')::bigint as pending,
        count(*) filter (where work_state = 'SLA_RISK')::bigint as sla_risk,
        count(*) filter (where lifecycle_status = 'Qualified')::bigint as qualified,
        count(*) filter (where lifecycle_status = 'New')::bigint as new_count,
        count(*) filter (where lifecycle_status = 'Contacted')::bigint as contacted_count,
        count(*) filter (
          where lifecycle_status = 'Appointment Scheduled'
        )::bigint as appointment_scheduled_count,
        count(*) filter (
          where lifecycle_status = 'Transferred to Sales'
        )::bigint as transferred_to_sales_count,
        count(*) filter (where lifecycle_status = 'Lost')::bigint as lost_count
      from staged_leads
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id,
          'organization_id', organization_id,
          'branch_id', branch_id,
          'team_id', team_id,
          'customer_id', customer_id,
          'source', source,
          'customer_name', customer_name,
          'phone', phone,
          'normalized_phone', normalized_phone,
          'email', email,
          'interested_model', interested_model,
          'lifecycle_status', lifecycle_status,
          'temperature', temperature,
          'lost_reason', lost_reason,
          'work_state', work_state,
          'lead_stage', lead_stage,
          'assigned_user_id', assigned_user_id,
          'assigned_user_name', assigned_user_name,
          'first_contacted_at', first_contacted_at,
          'sla_due_at', sla_due_at,
          'next_followup_at', next_followup_at,
          'created_at', created_at,
          'updated_at', updated_at
        ) order by
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,
          case when target_sort = 'updated:desc' then updated_at end desc nulls last,
          case when target_sort = 'created:asc' then created_at end asc nulls last,
          case when target_sort = 'created:desc' then created_at end desc nulls last,
          case when target_sort = 'customer:asc' then customer_name end asc nulls last,
          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          id desc
        )
        from page_rows
      ), '[]'::jsonb),
      'total', (select count(*) from filtered_lead_ids),
      'kpis', (select to_jsonb(kpis) from kpis),
      'filters', jsonb_build_object(
        'models', coalesce((
          select jsonb_agg(model_name order by model_name)
          from (
            select distinct interested_model as model_name
            from scoped_leads
            where nullif(btrim(interested_model), '') is not null
            order by interested_model
            limit 100
          ) model_options
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(source_name order by source_name)
          from (
            select distinct source as source_name
            from scoped_leads
            where nullif(btrim(source), '') is not null
            order by source
            limit 100
          ) source_options
        ), '[]'::jsonb)
      )
    )
  );
end;
$$;

revoke all on function app_private.get_sales_role_lead_workspace_page(
  uuid, uuid, boolean, uuid[], uuid[], boolean, uuid[], integer, integer,
  text, text, text, text, text, text, text, date, date
) from public, anon, authenticated;

-- Route keys are the values returned by get_access_context(), not database role
-- keys. All five sales CRM routes use the same scope-aware implementation.
create or replace function public.get_lead_workspace_page_v2(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default '',
  target_status text default 'all',
  target_sort text default 'updated:desc',
  target_model text default null,
  target_source text default null,
  target_stage text default 'all',
  target_temperature text default 'all',
  target_followup_from date default null,
  target_followup_to date default null
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
  workspace_scope record;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = any(array[
    'telecaller',
    'sales-consultant',
    'team-manager',
    'showroom-manager',
    'gm-sales'
  ]::text[]) then
    if access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
    end if;

    current_organization_id := (access_context->>'organization_id')::uuid;
    select * into workspace_scope
    from app_private.resolve_sales_lead_workspace_scope(current_organization_id);

    if not ('lead.view' = any(workspace_scope.permission_keys)) then
      raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
    end if;

    return app_private.get_sales_role_lead_workspace_page(
      current_organization_id,
      auth.uid(),
      workspace_scope.organization_wide,
      workspace_scope.branch_scope_ids,
      workspace_scope.team_scope_ids,
      workspace_scope.owner_scope,
      workspace_scope.owner_branch_ids,
      target_page,
      target_page_size,
      target_search,
      target_status,
      target_sort,
      target_model,
      target_source,
      target_stage,
      target_temperature,
      target_followup_from,
      target_followup_to
    );
  end if;

  return public.get_lead_workspace_page_v2_legacy(
    target_page,
    target_page_size,
    target_search,
    target_status,
    target_sort,
    target_model,
    target_source,
    target_stage,
    target_temperature,
    target_followup_from,
    target_followup_to
  );
end;
$$;

revoke all on function public.get_lead_workspace_page_v2(
  integer, integer, text, text, text, text, text, text, text, date, date
) from public, anon;
grant execute on function public.get_lead_workspace_page_v2(
  integer, integer, text, text, text, text, text, text, text, date, date
) to authenticated;

commit;
