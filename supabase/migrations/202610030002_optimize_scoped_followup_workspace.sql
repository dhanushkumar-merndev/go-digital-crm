-- The generic Follow-ups workspace evaluated three SECURITY DEFINER access
-- helpers for every row before applying the viewer's team/branch scope. On a
-- Team Manager account this made the first page take more than four seconds.
-- Resolve each permission-bound scope once, then perform ordinary set-based
-- predicates over the indexed organization/branch/team/owner columns.

begin;

create or replace function app_private.get_scoped_followup_workspace_filtered_page(
  target_organization_id uuid,
  target_search text,
  target_status text,
  target_priority text,
  target_branch_id uuid,
  target_team_id uuid,
  target_owner_id uuid,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_timezone text,
  target_model text default '',
  target_source text default '',
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  search_phone_digits text := app_private.phone_search_digits(normalized_search);
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  followup_scope record;
begin
  select * into followup_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['followup.view']
  );
  if followup_scope is null or not followup_scope.granted then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(target_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if target_team_id is not null
    and not app_private.can_access_team(target_organization_id, target_team_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  if target_followup_from is not null then
    followup_from_at := target_followup_from::timestamp at time zone target_timezone;
  end if;
  if target_followup_to is not null then
    followup_to_exclusive_at := (target_followup_to + 1)::timestamp
      at time zone target_timezone;
  end if;

  return (
    with lead_scope as materialized (
      select *
      from app_private.resolve_permission_record_scope(
        target_organization_id,
        array['lead.view']
      )
    ), customer_scope as materialized (
      select *
      from app_private.resolve_permission_record_scope(
        target_organization_id,
        array['customer.view']
      )
    ), visible_customer_ids as materialized (
      select distinct lead_row.customer_id
      from public.leads lead_row
      cross join customer_scope scope_row
      where scope_row.granted
        and lead_row.organization_id = target_organization_id
        and lead_row.customer_id is not null
        and lead_row.deleted_at is null
        and (
          scope_row.organization_wide
          or lead_row.branch_id = any(scope_row.branch_scope_ids)
          or lead_row.team_id = any(scope_row.team_scope_ids)
          or (
            scope_row.own_records
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(scope_row.own_record_branch_ids)
          )
        )
    ), accessible_records as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer')
          as customer_name,
        coalesce(customer_row.primary_phone, lead_row.phone) as phone,
        lead_row.interested_model,
        lead_row.source::text as lead_source,
        lead_row.temperature::text as lead_temperature,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        case
          when followup_row.status = 'OPEN' and followup_row.due_at < query_now
            then 'OVERDUE'
          else followup_row.status
        end as display_status,
        followup_row.status,
        followup_row.assigned_user_id,
        assigned_profile.full_name as assigned_user_name,
        followup_row.created_by,
        creator_profile.full_name as created_by_name,
        followup_row.branch_id,
        branch_row.name as branch_name,
        followup_row.team_id,
        team_row.name as team_name,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.followups followup_row
      cross join lead_scope lead_scope_row
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = followup_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      left join public.teams team_row
        on team_row.id = followup_row.team_id
       and team_row.organization_id = followup_row.organization_id
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = followup_row.organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on customer_row.id = followup_row.customer_id
       and customer_row.organization_id = followup_row.organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = followup_row.assigned_user_id
       and assigned_profile.organization_id = followup_row.organization_id
      left join public.profiles creator_profile
        on creator_profile.id = followup_row.created_by
       and creator_profile.organization_id = followup_row.organization_id
      where followup_row.organization_id = target_organization_id
        and (
          followup_scope.organization_wide
          or followup_row.branch_id = any(followup_scope.branch_scope_ids)
          or followup_row.team_id = any(followup_scope.team_scope_ids)
          or (
            followup_scope.own_records
            and followup_row.assigned_user_id = auth.uid()
            and followup_row.branch_id = any(followup_scope.own_record_branch_ids)
          )
        )
        and (
          followup_row.lead_id is null
          or (
            lead_scope_row.granted
            and lead_row.id is not null
            and (
              lead_scope_row.organization_wide
              or lead_row.branch_id = any(lead_scope_row.branch_scope_ids)
              or lead_row.team_id = any(lead_scope_row.team_scope_ids)
              or (
                lead_scope_row.own_records
                and lead_row.assigned_user_id = auth.uid()
                and lead_row.branch_id = any(lead_scope_row.own_record_branch_ids)
              )
            )
          )
        )
        and (
          followup_row.customer_id is null
          or followup_row.customer_id in (select customer_id from visible_customer_ids)
        )
    ), scope_filtered as materialized (
      select record_row.*
      from accessible_records record_row
      where (target_branch_id is null or record_row.branch_id = target_branch_id)
        and (target_team_id is null or record_row.team_id = target_team_id)
        and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or record_row.priority = target_priority)
        and (
          nullif(btrim(coalesce(target_model, '')), '') is null
          or record_row.interested_model = btrim(target_model)
        )
        and (
          nullif(btrim(coalesce(target_source, '')), '') is null
          or record_row.lead_source = btrim(target_source)
        )
        and (
          target_temperature = 'all'
          or record_row.lead_temperature = target_temperature
        )
        and (followup_from_at is null or record_row.due_at >= followup_from_at)
        and (
          followup_to_exclusive_at is null
          or record_row.due_at < followup_to_exclusive_at
        )
    ), searched_records as materialized (
      select record_row.*
      from scope_filtered record_row
      where normalized_search = ''
        or record_row.id = search_uuid
        or record_row.lead_id = search_uuid
        or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(record_row.phone)
            like search_phone_digits || '%'
        )
    ), filtered_records as materialized (
      select record_row.*
      from searched_records record_row
      where case target_status
        when 'overdue' then record_row.status = 'OPEN' and record_row.due_at < query_now
        when 'today' then record_row.status = 'OPEN'
          and record_row.due_at >= day_start and record_row.due_at < day_end
        when 'upcoming' then record_row.status = 'OPEN' and record_row.due_at >= day_end
        when 'completed' then record_row.status = 'COMPLETED'
        when 'cancelled' then record_row.status = 'CANCELLED'
        else true
      end
    ), page_rows as materialized (
      select record_row.*
      from filtered_records record_row
      order by
        case when target_sort = 'scheduled:asc' then record_row.due_at end asc,
        case when target_sort = 'scheduled:desc' then record_row.due_at end desc,
        case when target_sort = 'updated:desc' then record_row.updated_at end desc,
        case when target_sort = 'updated:asc' then record_row.updated_at end asc,
        case when target_sort = 'customer:asc' then lower(record_row.customer_name) end asc,
        case when target_sort = 'customer:desc' then lower(record_row.customer_name) end desc,
        record_row.id asc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'records', coalesce(
        (select jsonb_agg(to_jsonb(page_row)) from page_rows page_row),
        '[]'::jsonb
      ),
      'total', (select count(*) from filtered_records),
      'kpis', jsonb_build_object(
        'overdue', (select count(*) from scope_filtered where status = 'OPEN' and due_at < query_now),
        'today', (select count(*) from scope_filtered where status = 'OPEN' and due_at >= day_start and due_at < day_end),
        'upcoming', (select count(*) from scope_filtered where status = 'OPEN' and due_at >= day_end),
        'completed_today', (select count(*) from scope_filtered where status = 'COMPLETED' and completed_at >= day_start and completed_at < day_end)
      ),
      'status_counts', jsonb_build_object(
        'all', (select count(*) from searched_records),
        'overdue', (select count(*) from searched_records where status = 'OPEN' and due_at < query_now),
        'today', (select count(*) from searched_records where status = 'OPEN' and due_at >= day_start and due_at < day_end),
        'upcoming', (select count(*) from searched_records where status = 'OPEN' and due_at >= day_end),
        'completed', (select count(*) from searched_records where status = 'COMPLETED'),
        'cancelled', (select count(*) from searched_records where status = 'CANCELLED')
      ),
      'filters', jsonb_build_object(
        'branches', coalesce((select jsonb_agg(jsonb_build_object('id', branch_id, 'name', branch_name) order by branch_name) from (select distinct branch_id, branch_name from accessible_records) values_row), '[]'::jsonb),
        'teams', coalesce((select jsonb_agg(jsonb_build_object('id', team_id, 'name', team_name, 'branch_id', branch_id) order by team_name) from (select distinct team_id, team_name, branch_id from accessible_records where team_id is not null) values_row), '[]'::jsonb),
        'owners', coalesce((select jsonb_agg(jsonb_build_object('id', assigned_user_id, 'name', assigned_user_name) order by assigned_user_name) from (select distinct assigned_user_id, assigned_user_name from accessible_records) values_row), '[]'::jsonb),
        'models', coalesce((select jsonb_agg(model order by model) from (select distinct interested_model as model from accessible_records where interested_model is not null) values_row), '[]'::jsonb),
        'sources', coalesce((select jsonb_agg(source order by source) from (select distinct lead_source as source from accessible_records where lead_source is not null) values_row), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$$;

revoke all on function app_private.get_scoped_followup_workspace_filtered_page(
  uuid, text, text, text, uuid, uuid, uuid, integer, integer, text, text,
  text, text, text, date, date
) from public, anon, authenticated;

-- Preserve the already-deployed Sales Consultant and Telecaller fast paths.
-- Insert the resolved-scope path at the exact guarded anchor that precedes the
-- old generic query, rather than re-emitting the live dispatcher body.
do $migration$
declare
  function_definition text;
  old_anchor constant text := E'  -- (unchanged logic from 202608290009)';
  new_dispatch constant text := $body$  -- Resolved-scope fast path for manager/admin roles.
  if access_context->>'destination' is distinct from 'CRM'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  return app_private.get_scoped_followup_workspace_filtered_page(
    current_organization_id,
    target_search,
    target_status,
    target_priority,
    target_branch_id,
    target_team_id,
    target_owner_id,
    target_page,
    target_page_size,
    target_sort,
    target_timezone,
    target_model,
    target_source,
    target_temperature,
    target_followup_from,
    target_followup_to
  );

  -- (unchanged logic from 202608290009)$body$;
begin
  select pg_get_functiondef(
    'public.get_followup_workspace_filtered_page(text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date)'::regprocedure
  ) into function_definition;
  if function_definition is null
    or position(old_anchor in function_definition) = 0
    or (
      char_length(function_definition)
      - char_length(replace(function_definition, old_anchor, ''))
    ) / char_length(old_anchor) <> 1
  then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_SCOPE_PATCH_MISMATCH';
  end if;
  execute replace(function_definition, old_anchor, new_dispatch);
end;
$migration$;

commit;
