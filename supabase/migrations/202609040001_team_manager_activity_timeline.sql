-- Team Manager activity oversight: a day-scoped view of what each managed
-- team member (Telecaller/BDC or Sales Consultant) actually did. This is a
-- brand-new function -- it never replaces get_telecaller_activity_timeline
-- or get_sales_consultant_activity_timeline, so their deployed bodies are
-- left untouched.
--
-- Two modes, one RPC:
--   * target_member_id is null   -> "overview": one row per managed member
--     with that day's activity tally (for the team roster table).
--   * target_member_id is set    -> "member": that member's own day timeline
--     (records + summary + upcoming follow-ups + recent notes), scoped to a
--     member of a team actually managed by the caller.
--
-- Access is bounded the same way as get_team_manager_performance: only teams
-- where public.teams.manager_id = auth.uid() (and app_private.can_access_team
-- confirms it) are ever visible.

begin;

create or replace function public.get_team_manager_activity_timeline(
  target_member_id uuid default null,
  target_date date default null,
  target_search text default '',
  target_kind text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'latest:desc',
  target_timezone text default 'Asia/Kolkata'
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
  normalized_kind text := upper(btrim(coalesce(target_kind, 'ALL')));
  search_phone_digits text;
  local_today date;
  effective_date date;
  range_start timestamptz;
  range_end timestamptz;
  permission_keys text[];
  can_view_calls boolean;
  can_view_messages boolean;
  can_view_followups boolean;
  can_view_test_drives boolean;
  can_view_quotations boolean;
  can_view_tasks boolean;
  can_view_appointments boolean;
  member_organization_id uuid;
  member_full_name text;
  member_type_value text;
  members_result jsonb := '[]'::jsonb;
  page_result jsonb := '[]'::jsonb;
  total_result bigint := 0;
  summary_result jsonb;
  upcoming_followups_result jsonb := '[]'::jsonb;
  recent_notes_result jsonb := '[]'::jsonb;
begin
  if normalized_kind not in (
      'ALL', 'CALL', 'MESSAGE', 'FOLLOW_UP', 'TEST_DRIVE',
      'QUOTATION', 'TASK', 'APPOINTMENT', 'NOTE', 'OTHER'
    )
    or target_page is null or target_page not between 1 and 1000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort not in ('latest:desc', 'oldest:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or char_length(normalized_search) > 160
  then
    raise exception using errcode = '22023', message = 'INVALID_TEAM_ACTIVITY_QUERY';
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
  if not app_private.has_permission(current_organization_id, 'lead.view') then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_LEAD_VIEW_REQUIRED';
  end if;

  select coalesce(array_agg(team_row.id order by team_row.id), array[]::uuid[])
  into managed_team_ids
  from public.teams team_row
  where team_row.organization_id = current_organization_id
    and team_row.active
    and team_row.manager_id = current_user_id
    and app_private.can_access_team(current_organization_id, team_row.id);

  if cardinality(managed_team_ids) = 0 then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_TEAM_REQUIRED';
  end if;

  select coalesce(array_agg(distinct permission_row.permission_key), array[]::text[])
  into permission_keys
  from public.user_role_assignments assignment_row
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = assignment_row.role_id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
  where assignment_row.organization_id = current_organization_id
    and assignment_row.user_id = current_user_id
    and assignment_row.active;

  can_view_calls := 'call.view' = any(permission_keys);
  can_view_messages := 'message.view' = any(permission_keys);
  can_view_followups := 'followup.view' = any(permission_keys);
  can_view_tasks := 'task.view' = any(permission_keys);
  can_view_appointments := 'appointment.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_quotations :=
    'quotation.view' = any(permission_keys) or 'quotation.manage' = any(permission_keys);

  local_today := timezone(target_timezone, now())::date;
  effective_date := least(coalesce(target_date, local_today), local_today);
  range_start := timezone(target_timezone, effective_date::timestamp);
  range_end := timezone(target_timezone, (effective_date + 1)::timestamp);

  if target_member_id is not null then
    select member_row.organization_id, profile_row.full_name, member_row.member_type
    into member_organization_id, member_full_name, member_type_value
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = current_organization_id
      and member_row.user_id = target_member_id
      and member_row.team_id = any(managed_team_ids)
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      and profile_row.active;

    if member_organization_id is null then
      raise exception using errcode = '42501', message = 'TEAM_MANAGER_MEMBER_ACCESS_REQUIRED';
    end if;

    search_phone_digits := app_private.normalize_phone_digits(normalized_search);

    with owned_leads as materialized (
      select lead_row.id, lead_row.customer_id,
        'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
        lead_row.interested_model
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = target_member_id
        and lead_row.team_id = any(managed_team_ids)
        and lead_row.deleted_at is null
    ), activity_base as materialized (
      select
        activity_row.id,
        activity_row.activity_type,
        activity_row.occurred_at,
        customer_row.full_name as customer_name,
        customer_row.primary_phone as customer_phone,
        lead_row.reference as lead_reference,
        lead_row.interested_model,
        actor_row.full_name as actor_name,
        case
          when activity_row.activity_type like 'CALL%' then 'CALL'
          when activity_row.activity_type like '%MESSAGE%'
            or activity_row.activity_type like '%WHATSAPP%' then 'MESSAGE'
          when activity_row.activity_type like '%FOLLOWUP%' then 'FOLLOW_UP'
          when activity_row.activity_type like '%TEST_DRIVE%' then 'TEST_DRIVE'
          when activity_row.activity_type like '%QUOTATION%' then 'QUOTATION'
          when activity_row.activity_type like '%TASK%' then 'TASK'
          when activity_row.activity_type like '%APPOINTMENT%' then 'APPOINTMENT'
          when activity_row.activity_type like '%NOTE%' then 'NOTE'
          else 'OTHER'
        end as activity_kind,
        coalesce(
          nullif(activity_row.metadata->>'title', ''),
          nullif(activity_row.metadata->>'reason', ''),
          nullif(activity_row.metadata->>'quotation_number', ''),
          nullif(activity_row.metadata->>'status', ''),
          nullif(activity_row.metadata->>'direction', '')
        ) as detail
      from public.activities activity_row
      join owned_leads lead_row on lead_row.id = activity_row.lead_id
      join public.customers customer_row
        on customer_row.organization_id = activity_row.organization_id
       and customer_row.id = activity_row.customer_id
       and customer_row.deleted_at is null
      left join public.profiles actor_row
        on actor_row.organization_id = activity_row.organization_id
       and actor_row.id = activity_row.actor_id
      where activity_row.organization_id = current_organization_id
        and activity_row.occurred_at >= range_start
        and activity_row.occurred_at < range_end
    ), filtered as materialized (
      select activity_row.* from activity_base activity_row
      where (normalized_kind = 'ALL' or activity_row.activity_kind = normalized_kind)
        and case activity_row.activity_kind
          when 'CALL' then can_view_calls
          when 'MESSAGE' then can_view_messages
          when 'FOLLOW_UP' then can_view_followups
          when 'TEST_DRIVE' then can_view_test_drives
          when 'QUOTATION' then can_view_quotations
          when 'TASK' then can_view_tasks
          when 'APPOINTMENT' then can_view_appointments
          else true
        end
        and (
          normalized_search = ''
          or position(normalized_search in lower(activity_row.customer_name)) > 0
          or position(normalized_search in lower(activity_row.lead_reference)) > 0
          or position(normalized_search in lower(coalesce(activity_row.interested_model, ''))) > 0
          or position(normalized_search in lower(coalesce(activity_row.detail, ''))) > 0
          or (
            search_phone_digits <> ''
            and app_private.normalize_phone_digits(activity_row.customer_phone) = search_phone_digits
          )
        )
    ), numbered as (
      select
        filtered_row.*,
        row_number() over (
          order by
            case when target_sort = 'latest:desc' then filtered_row.occurred_at end desc,
            case when target_sort = 'oldest:asc' then filtered_row.occurred_at end asc,
            filtered_row.id desc
        ) as page_order
      from filtered filtered_row
    ), page_rows as (
      select * from numbered
      order by page_order
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id,
          'activity_type', activity_type,
          'activity_kind', activity_kind,
          'detail', detail,
          'occurred_at', occurred_at,
          'customer_name', customer_name,
          'customer_phone', customer_phone,
          'lead_reference', lead_reference,
          'interested_model', interested_model,
          'actor_name', actor_name
        ) order by page_order)
        from page_rows
      ), '[]'::jsonb),
      (select count(*) from filtered)
    into page_result, total_result;

    select jsonb_build_object(
      'calls', count(*) filter (where activity_kind = 'CALL' and can_view_calls),
      'messages', count(*) filter (where activity_kind = 'MESSAGE' and can_view_messages),
      'followups', count(*) filter (where activity_kind = 'FOLLOW_UP' and can_view_followups),
      'test_drives', count(*) filter (where activity_kind = 'TEST_DRIVE' and can_view_test_drives),
      'quotations', count(*) filter (where activity_kind = 'QUOTATION' and can_view_quotations),
      'tasks', count(*) filter (where activity_kind = 'TASK' and can_view_tasks),
      'appointments', count(*) filter (where activity_kind = 'APPOINTMENT' and can_view_appointments),
      'notes', count(*) filter (where activity_kind = 'NOTE')
    )
    into summary_result
    from activity_base;

    with owned_leads as materialized (
      select lead_row.id, lead_row.interested_model
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = target_member_id
        and lead_row.team_id = any(managed_team_ids)
        and lead_row.deleted_at is null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', followup_source.id,
      'customer_name', followup_source.customer_name,
      'detail', coalesce(nullif(btrim(followup_source.reason), ''), followup_source.interested_model),
      'due_at', followup_source.due_at,
      'priority', followup_source.priority
    ) order by followup_source.due_at, followup_source.id), '[]'::jsonb)
    into upcoming_followups_result
    from (
      select followup_row.id, followup_row.reason, followup_row.due_at, followup_row.priority,
        lead_row.interested_model, customer_row.full_name as customer_name
      from public.followups followup_row
      join owned_leads lead_row on lead_row.id = followup_row.lead_id
      join public.customers customer_row
        on customer_row.organization_id = followup_row.organization_id
       and customer_row.id = followup_row.customer_id
       and customer_row.deleted_at is null
      where followup_row.organization_id = current_organization_id
        and followup_row.assigned_user_id = target_member_id
        and followup_row.team_id = any(managed_team_ids)
        and followup_row.status in ('OPEN', 'OVERDUE')
        and followup_row.due_at >= now()
      order by followup_row.due_at, followup_row.id
      limit 4
    ) followup_source;

    with owned_customers as materialized (
      select distinct lead_row.customer_id
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = target_member_id
        and lead_row.team_id = any(managed_team_ids)
        and lead_row.deleted_at is null
        and lead_row.customer_id is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', note_source.id,
      'body', note_source.body,
      'customer_name', note_source.customer_name,
      'created_at', note_source.created_at
    ) order by note_source.created_at desc, note_source.id desc), '[]'::jsonb)
    into recent_notes_result
    from (
      select note_row.id, note_row.body, note_row.created_at, customer_row.full_name as customer_name
      from public.notes note_row
      join owned_customers customer_scope on customer_scope.customer_id = note_row.resource_id
      join public.customers customer_row
        on customer_row.organization_id = note_row.organization_id
       and customer_row.id = note_row.resource_id
       and customer_row.deleted_at is null
      where note_row.organization_id = current_organization_id
        and lower(note_row.resource_type) = 'customer'
        and note_row.deleted_at is null
      order by note_row.created_at desc, note_row.id desc
      limit 4
    ) note_source;

    return jsonb_build_object(
      'organization_id', current_organization_id,
      'mode', 'member',
      'target_date', effective_date,
      'team_ids', to_jsonb(managed_team_ids),
      'member_id', target_member_id,
      'member_name', coalesce(member_full_name, 'Team member'),
      'member_type', member_type_value,
      'records', page_result,
      'total', total_result,
      'summary', summary_result,
      'upcoming_followups', upcoming_followups_result,
      'recent_notes', recent_notes_result
    );
  end if;

  -- Overview mode: one row per managed team member with that day's tally.
  with members as materialized (
    select distinct on (member_row.user_id)
      member_row.user_id, member_row.team_id, member_row.member_type, profile_row.full_name
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = any(managed_team_ids)
      and member_row.active
      and member_row.member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')
      and profile_row.active
    order by member_row.user_id, member_row.team_id
  ), owned_leads as materialized (
    select lead_row.id, lead_row.assigned_user_id
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.team_id = any(managed_team_ids)
      and lead_row.deleted_at is null
  ), activity_kinds as materialized (
    select
      lead_row.assigned_user_id as user_id,
      case
        when activity_row.activity_type like 'CALL%' then 'CALL'
        when activity_row.activity_type like '%MESSAGE%'
          or activity_row.activity_type like '%WHATSAPP%' then 'MESSAGE'
        when activity_row.activity_type like '%FOLLOWUP%' then 'FOLLOW_UP'
        when activity_row.activity_type like '%TEST_DRIVE%' then 'TEST_DRIVE'
        when activity_row.activity_type like '%QUOTATION%' then 'QUOTATION'
        when activity_row.activity_type like '%TASK%' then 'TASK'
        when activity_row.activity_type like '%APPOINTMENT%' then 'APPOINTMENT'
        when activity_row.activity_type like '%NOTE%' then 'NOTE'
        else 'OTHER'
      end as activity_kind
    from public.activities activity_row
    join owned_leads lead_row on lead_row.id = activity_row.lead_id
    where activity_row.organization_id = current_organization_id
      and activity_row.occurred_at >= range_start
      and activity_row.occurred_at < range_end
  ), member_counts as (
    select
      member_row.user_id, member_row.full_name, member_row.member_type,
      count(*) filter (
        where activity_row.activity_kind = 'CALL' and can_view_calls
      )::bigint as calls,
      count(*) filter (
        where activity_row.activity_kind = 'MESSAGE' and can_view_messages
      )::bigint as messages,
      count(*) filter (
        where activity_row.activity_kind = 'FOLLOW_UP' and can_view_followups
      )::bigint as followups,
      count(*) filter (
        where activity_row.activity_kind = 'TEST_DRIVE' and can_view_test_drives
      )::bigint as test_drives,
      count(*) filter (
        where activity_row.activity_kind = 'QUOTATION' and can_view_quotations
      )::bigint as quotations,
      count(*) filter (
        where activity_row.activity_kind = 'TASK' and can_view_tasks
      )::bigint as tasks,
      count(*) filter (
        where activity_row.activity_kind = 'APPOINTMENT' and can_view_appointments
      )::bigint as appointments,
      count(*) filter (where activity_row.activity_kind = 'NOTE')::bigint as notes,
      count(activity_row.activity_kind) filter (
        where case activity_row.activity_kind
          when 'CALL' then can_view_calls
          when 'MESSAGE' then can_view_messages
          when 'FOLLOW_UP' then can_view_followups
          when 'TEST_DRIVE' then can_view_test_drives
          when 'QUOTATION' then can_view_quotations
          when 'TASK' then can_view_tasks
          when 'APPOINTMENT' then can_view_appointments
          else true
        end
      )::bigint as total
    from members member_row
    left join activity_kinds activity_row on activity_row.user_id = member_row.user_id
    group by member_row.user_id, member_row.full_name, member_row.member_type
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', member_row.user_id,
    'full_name', member_row.full_name,
    'member_type', member_row.member_type,
    'calls', member_row.calls,
    'messages', member_row.messages,
    'followups', member_row.followups,
    'test_drives', member_row.test_drives,
    'quotations', member_row.quotations,
    'tasks', member_row.tasks,
    'appointments', member_row.appointments,
    'notes', member_row.notes,
    'total', member_row.total
  ) order by member_row.total desc, member_row.full_name), '[]'::jsonb)
  into members_result
  from member_counts member_row;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'mode', 'overview',
    'target_date', effective_date,
    'team_ids', to_jsonb(managed_team_ids),
    'members', members_result
  );
end;
$$;

revoke all on function public.get_team_manager_activity_timeline(
  uuid, date, text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.get_team_manager_activity_timeline(
  uuid, date, text, text, integer, integer, text, text
) to authenticated;

commit;
