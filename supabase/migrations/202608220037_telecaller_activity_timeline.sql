begin;

-- The Sales Consultant timeline is intentionally role-gated. Telecaller/BDC
-- needs the same working surface, but it must never inherit a consultant's
-- broader APIs or see anything outside its own assigned leads. Existing
-- concurrent hot-path indexes cover these queries; do not create indexes in a
-- transaction on a live high-volume table.

create or replace function app_private.telecaller_activity_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  organization_id_value uuid;
begin
  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'telecaller'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'TELECALLER_ACCESS_REQUIRED';
  end if;

  organization_id_value := (access_context->>'organization_id')::uuid;
  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
    where assignment_row.organization_id = organization_id_value
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
      and permission_row.permission_key in ('lead.view', 'customer.view')
    group by assignment_row.id
    having count(distinct permission_row.permission_key) = 2
  ) then
    raise exception using errcode = '42501', message = 'TELECALLER_ACTIVITY_PERMISSION_REQUIRED';
  end if;
  return organization_id_value;
end;
$$;

revoke all on function app_private.telecaller_activity_organization()
  from public, anon, authenticated;

create or replace function public.get_telecaller_activity_timeline(
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
  current_organization_id uuid;
  current_user_id uuid := auth.uid();
  allowed_branch_ids uuid[];
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_kind text := upper(btrim(coalesce(target_kind, 'ALL')));
  search_phone_digits text;
  summary_start timestamptz;
  permission_keys text[];
  page_result jsonb := '[]'::jsonb;
  total_result bigint := 0;
  calls_count bigint := 0;
  messages_count bigint := 0;
  followups_count bigint := 0;
  test_drives_count bigint := 0;
  quotations_count bigint := 0;
  notes_count bigint := 0;
  upcoming_followups_result jsonb := '[]'::jsonb;
  recent_notes_result jsonb := '[]'::jsonb;
  telecaller_name_value text;
begin
  if char_length(normalized_search) > 160
    or normalized_kind not in (
      'ALL', 'CALL', 'MESSAGE', 'FOLLOW_UP', 'TEST_DRIVE',
      'QUOTATION', 'TASK', 'APPOINTMENT', 'NOTE', 'OTHER'
    )
    -- This is an operational own-record timeline, not an unbounded audit log.
    -- Keep ordinary server-side offset pagination, but hard-cap deep offsets.
    or target_page is null or target_page not between 1 and 100
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort not in ('latest:desc', 'oldest:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_TELECALLER_ACTIVITY_QUERY';
  end if;

  current_organization_id := app_private.telecaller_activity_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  summary_start := timezone(
    target_timezone,
    (timezone(target_timezone, now())::date - 6)::timestamp
  );

  select profile_row.full_name into telecaller_name_value
  from public.profiles profile_row
  where profile_row.organization_id = current_organization_id
    and profile_row.id = current_user_id;

  if cardinality(allowed_branch_ids) > 0 then
    with owned_leads as materialized (
      select lead_row.id, lead_row.customer_id, lead_row.customer_name, lead_row.phone,
        lead_row.normalized_phone,
        'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
        lead_row.interested_model
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
    ), activity_base as (
      select
        activity_row.id, activity_row.activity_type, activity_row.occurred_at,
        coalesce(customer_row.full_name, lead_row.customer_name) as customer_name,
        coalesce(customer_row.primary_phone, lead_row.phone) as customer_phone,
        coalesce(customer_row.normalized_phone, lead_row.normalized_phone) as customer_normalized_phone,
        lead_row.reference as lead_reference, lead_row.interested_model,
        activity_row.actor_id, actor_row.full_name as actor_name,
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
      left join public.customers customer_row
        on customer_row.organization_id = activity_row.organization_id
       and customer_row.id = activity_row.customer_id
       and customer_row.deleted_at is null
      left join public.profiles actor_row
        on actor_row.organization_id = activity_row.organization_id
       and actor_row.id = activity_row.actor_id
      where activity_row.organization_id = current_organization_id
    ), filtered as (
      select activity_row.* from activity_base activity_row
      where (normalized_kind = 'ALL' or activity_row.activity_kind = normalized_kind)
        and case activity_row.activity_kind
          when 'CALL' then 'call.view' = any(permission_keys)
          when 'MESSAGE' then 'message.view' = any(permission_keys)
          when 'FOLLOW_UP' then 'followup.view' = any(permission_keys)
          when 'TEST_DRIVE' then (
            'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys)
          )
          when 'QUOTATION' then (
            'quotation.view' = any(permission_keys) or 'quotation.manage' = any(permission_keys)
          )
          when 'TASK' then 'task.view' = any(permission_keys)
          when 'APPOINTMENT' then 'appointment.view' = any(permission_keys)
          when 'NOTE' then activity_row.actor_id = current_user_id
          else false
        end
        and (
          normalized_search = ''
          or position(normalized_search in lower(activity_row.customer_name)) > 0
          or position(normalized_search in lower(activity_row.lead_reference)) > 0
          or position(normalized_search in lower(coalesce(activity_row.interested_model, ''))) > 0
          or position(normalized_search in lower(coalesce(activity_row.detail, ''))) > 0
          or (
            search_phone_digits <> ''
            and activity_row.customer_normalized_phone = search_phone_digits
          )
        )
    ), page_rows as (
      select filtered_row.* from filtered filtered_row
      order by
        case when target_sort = 'latest:desc' then filtered_row.occurred_at end desc,
        case when target_sort = 'oldest:asc' then filtered_row.occurred_at end asc,
        filtered_row.id desc
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', page_row.id, 'activity_type', page_row.activity_type,
          'activity_kind', page_row.activity_kind, 'detail', page_row.detail,
          'occurred_at', page_row.occurred_at, 'customer_name', page_row.customer_name,
          'customer_phone', page_row.customer_phone, 'lead_reference', page_row.lead_reference,
          'interested_model', page_row.interested_model, 'actor_name', page_row.actor_name
        ) order by
          case when target_sort = 'latest:desc' then page_row.occurred_at end desc,
          case when target_sort = 'oldest:asc' then page_row.occurred_at end asc,
          page_row.id desc) from page_rows page_row
      ), '[]'::jsonb),
      (select count(*) from filtered)
    into page_result, total_result;

    with owned_leads as materialized (
      select lead_row.id from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
    ), recent_activity_base as (
      select activity_row.actor_id, case
        when activity_row.activity_type like 'CALL%' then 'CALL'
        when activity_row.activity_type like '%MESSAGE%'
          or activity_row.activity_type like '%WHATSAPP%' then 'MESSAGE'
        when activity_row.activity_type like '%FOLLOWUP%' then 'FOLLOW_UP'
        when activity_row.activity_type like '%TEST_DRIVE%' then 'TEST_DRIVE'
        when activity_row.activity_type like '%QUOTATION%' then 'QUOTATION'
        when activity_row.activity_type like '%NOTE%' then 'NOTE'
        else 'OTHER'
      end as activity_kind
      from public.activities activity_row
      join owned_leads lead_row on lead_row.id = activity_row.lead_id
      where activity_row.organization_id = current_organization_id
        and activity_row.occurred_at >= summary_start
        and activity_row.occurred_at < now() + interval '1 second'
    ), recent_activity as (
      select activity_row.activity_kind
      from recent_activity_base activity_row
      where case activity_row.activity_kind
        when 'CALL' then 'call.view' = any(permission_keys)
        when 'MESSAGE' then 'message.view' = any(permission_keys)
        when 'FOLLOW_UP' then 'followup.view' = any(permission_keys)
        when 'TEST_DRIVE' then (
          'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys)
        )
        when 'QUOTATION' then (
          'quotation.view' = any(permission_keys) or 'quotation.manage' = any(permission_keys)
        )
        when 'NOTE' then activity_row.actor_id = current_user_id
        else false
      end
    )
    select
      count(*) filter (where activity_row.activity_kind = 'CALL'),
      count(*) filter (where activity_row.activity_kind = 'MESSAGE'),
      count(*) filter (where activity_row.activity_kind = 'FOLLOW_UP'),
      count(*) filter (where activity_row.activity_kind = 'TEST_DRIVE'),
      count(*) filter (where activity_row.activity_kind = 'QUOTATION'),
      count(*) filter (where activity_row.activity_kind = 'NOTE')
    into calls_count, messages_count, followups_count, test_drives_count, quotations_count, notes_count
    from recent_activity activity_row;

    if 'followup.view' = any(permission_keys) then
      with owned_leads as materialized (
        select lead_row.id, lead_row.interested_model, lead_row.customer_name
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.assigned_user_id = current_user_id
          and lead_row.branch_id = any(allowed_branch_ids)
          and lead_row.deleted_at is null
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', followup_source.id, 'customer_name', followup_source.customer_name,
        'detail', coalesce(nullif(btrim(followup_source.reason), ''), followup_source.interested_model),
        'due_at', followup_source.due_at, 'priority', followup_source.priority
      ) order by followup_source.due_at, followup_source.id), '[]'::jsonb)
      into upcoming_followups_result
      from (
        select followup_row.id, followup_row.reason, followup_row.due_at, followup_row.priority,
          lead_row.interested_model,
          coalesce(customer_row.full_name, lead_row.customer_name) as customer_name
        from public.followups followup_row
        join owned_leads lead_row on lead_row.id = followup_row.lead_id
        left join public.customers customer_row
          on customer_row.organization_id = followup_row.organization_id
         and customer_row.id = followup_row.customer_id and customer_row.deleted_at is null
        where followup_row.organization_id = current_organization_id
          and followup_row.assigned_user_id = current_user_id
          and followup_row.branch_id = any(allowed_branch_ids)
          and followup_row.status in ('OPEN', 'OVERDUE') and followup_row.due_at >= now()
        order by followup_row.due_at, followup_row.id limit 4
      ) followup_source;
    end if;

    with owned_customers as materialized (
      select distinct lead_row.customer_id from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null and lead_row.customer_id is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', note_source.id, 'body', note_source.body,
      'customer_name', note_source.customer_name, 'created_at', note_source.created_at
    ) order by note_source.created_at desc, note_source.id desc), '[]'::jsonb)
    into recent_notes_result
    from (
      select note_row.id, note_row.body, note_row.created_at, customer_row.full_name as customer_name
      from public.notes note_row
      join owned_customers customer_scope on customer_scope.customer_id = note_row.resource_id
      join public.customers customer_row
        on customer_row.organization_id = note_row.organization_id
       and customer_row.id = note_row.resource_id and customer_row.deleted_at is null
      where note_row.organization_id = current_organization_id
        and lower(note_row.resource_type) = 'customer' and note_row.deleted_at is null
        and note_row.created_by = current_user_id
      order by note_row.created_at desc, note_row.id desc limit 4
    ) note_source;
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'consultant_name', coalesce(telecaller_name_value, 'Telecaller'),
    'records', page_result, 'total', total_result,
    'summary', jsonb_build_object(
      'calls', calls_count, 'messages', messages_count, 'followups', followups_count,
      'test_drives', test_drives_count, 'quotations', quotations_count, 'notes', notes_count
    ),
    'upcoming_followups', upcoming_followups_result, 'recent_notes', recent_notes_result
  );
end;
$$;

revoke all on function public.get_telecaller_activity_timeline(
  text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.get_telecaller_activity_timeline(
  text, text, integer, integer, text, text
) to authenticated;

commit;
