-- Deployed definitions of assign_lead and build_lead_assignment_workspace as of
-- 2026-10-21 (pg_get_functiondef), so 202610210012 can be patched over them.

CREATE OR REPLACE FUNCTION public.assign_lead(target_lead_id uuid, target_user_id uuid, assignment_kind text, assignment_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target_lead public.leads%rowtype;
  team_mode public.assignment_mode;
  prior_owner uuid;
  selected_user_id uuid;
  assignment_id uuid;
begin
  if assignment_kind not in ('FRESH', 'QUALIFIED') then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_KIND';
  end if;
  select * into target_lead
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(target_lead.organization_id, 'lead.assign')
    or not app_private.can_access_record(
      target_lead.organization_id,
      target_lead.branch_id,
      target_lead.team_id,
      target_lead.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;

  select case
      when assignment_kind = 'FRESH' then team_row.fresh_assignment_mode
      else team_row.qualified_assignment_mode
    end
    into team_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = target_lead.organization_id
    and team_row.branch_id = target_lead.branch_id
    and team_row.active
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'LEAD_TEAM_NOT_AVAILABLE';
  end if;

  if team_mode = 'LEAST_ASSIGNED' then
    selected_user_id := app_private.claim_least_assigned_member(
      target_lead.organization_id, target_lead.team_id, assignment_kind
    );
  elsif team_mode = 'ROUND_ROBIN' then
    select member_row.user_id into selected_user_id
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    left join lateral (
      select max(history_row.created_at) as last_assigned_at
      from public.lead_assignment_history history_row
      where history_row.organization_id = target_lead.organization_id
        and history_row.team_id = target_lead.team_id
        and history_row.new_owner_id = member_row.user_id
        and (
          (assignment_kind = 'FRESH' and history_row.method = 'ROUND_ROBIN')
          or assignment_kind = 'QUALIFIED'
        )
    ) assignment_history on true
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.active
      and profile_row.active
      and (
        (assignment_kind = 'FRESH' and member_row.eligible_for_fresh_leads)
        or (assignment_kind = 'QUALIFIED' and member_row.eligible_for_qualified_leads)
      )
    order by assignment_history.last_assigned_at nulls first, member_row.joined_at, member_row.user_id
    limit 1;
  else
    selected_user_id := target_user_id;
  end if;
  if selected_user_id is null or not exists (
    select 1
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.user_id = selected_user_id
      and member_row.active
      and profile_row.active
      and (
        (assignment_kind = 'FRESH' and member_row.eligible_for_fresh_leads)
        or (assignment_kind = 'QUALIFIED' and member_row.eligible_for_qualified_leads)
      )
  ) then
    raise exception using errcode = '23514', message = 'ASSIGNEE_NOT_ELIGIBLE';
  end if;

  prior_owner := target_lead.assigned_user_id;
  if prior_owner is not null and prior_owner <> selected_user_id
    and nullif(btrim(assignment_reason), '') is null
  then
    raise exception using errcode = '22023', message = 'REASSIGNMENT_REASON_REQUIRED';
  end if;
  select active_assignment.id into assignment_id
  from public.lead_assignments active_assignment
  where active_assignment.lead_id = target_lead_id
    and active_assignment.assigned_user_id = selected_user_id
    and active_assignment.assignment_type = assignment_kind
    and active_assignment.active
  limit 1;
  if found then
    return assignment_id;
  end if;

  update public.lead_assignments
  set active = false
  where lead_id = target_lead_id and active;
  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    target_lead.organization_id, target_lead.id, target_lead.branch_id,
    target_lead.team_id, selected_user_id, assignment_kind, team_mode,
    auth.uid(), assignment_reason
  ) returning id into assignment_id;
  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    target_lead.organization_id, target_lead.id, target_lead.branch_id,
    target_lead.team_id, prior_owner, selected_user_id, auth.uid(),
    team_mode, assignment_reason
  );
  perform set_config('app.assign_lead_rpc', 'on', true);
  update public.leads
  set assigned_user_id = selected_user_id, updated_at = now()
  where id = target_lead_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    target_lead.organization_id,
    auth.uid(),
    case when prior_owner is null then 'lead.assigned' else 'lead.reassigned' end,
    'lead',
    target_lead.id::text,
    target_lead.branch_id,
    jsonb_build_object(
      'previous_owner_id', prior_owner,
      'new_owner_id', selected_user_id,
      'method', team_mode,
      'assignment_type', assignment_kind,
      'reason', assignment_reason
    )
  );
  return assignment_id;
end;
$function$

;

CREATE OR REPLACE FUNCTION app_private.build_lead_assignment_workspace(target_organization_id uuid, target_actor_id uuid, target_team_ids uuid[], target_search text, target_page integer, target_page_size integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  search_phone_digits := app_private.phone_search_digits(normalized_search);

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
$function$

;
