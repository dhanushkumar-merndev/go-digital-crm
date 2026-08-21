-- A compact activity workspace for Sales Consultants. Events are always
-- constrained to leads assigned to the signed-in consultant, rather than using
-- client-side filtering over a tenant-wide activity feed.
create or replace function public.get_sales_consultant_activity_timeline(
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_kind text := upper(btrim(coalesce(target_kind, 'ALL')));
  result jsonb;
begin
  if char_length(normalized_search) > 160
    or normalized_kind not in (
      'ALL', 'CALL', 'MESSAGE', 'FOLLOW_UP', 'TEST_DRIVE', 'QUOTATION', 'TASK', 'APPOINTMENT', 'NOTE', 'OTHER'
    )
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort not in ('latest:desc', 'oldest:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_SALES_ACTIVITY_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'SALES_ACTIVITY_VIEW_PERMISSION_REQUIRED';
  end if;

  with owned_leads as materialized (
    select
      lead_row.id,
      lead_row.customer_id,
      'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
      lead_row.interested_model
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.assigned_user_id = auth.uid()
      and lead_row.deleted_at is null
      and app_private.can_access_lead(lead_row.id)
  ), raw_activities as materialized (
    select
      activity_row.id,
      activity_row.activity_type,
      activity_row.metadata,
      activity_row.occurred_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as customer_phone,
      lead_row.reference as lead_reference,
      lead_row.interested_model,
      actor_row.full_name as actor_name,
      case
        when activity_row.activity_type like 'CALL%' then 'CALL'
        when activity_row.activity_type like '%MESSAGE%' or activity_row.activity_type like '%WHATSAPP%' then 'MESSAGE'
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
  ), filtered as materialized (
    select * from raw_activities activity_row
    where (normalized_kind = 'ALL' or activity_row.activity_kind = normalized_kind)
      and (
        normalized_search = ''
        or position(normalized_search in lower(activity_row.customer_name)) > 0
        or position(normalized_search in lower(activity_row.lead_reference)) > 0
        or position(normalized_search in lower(coalesce(activity_row.interested_model, ''))) > 0
        or position(normalized_search in lower(coalesce(activity_row.detail, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(activity_row.customer_phone)
            = app_private.normalize_phone_digits(normalized_search)
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
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'consultant_name', coalesce((
      select profile_row.full_name
      from public.profiles profile_row
      where profile_row.organization_id = current_organization_id and profile_row.id = auth.uid()
    ), 'Sales Consultant'),
    'records', coalesce((
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
    'total', (select count(*) from filtered),
    'summary', jsonb_build_object(
      'calls', (select count(*) from raw_activities where activity_kind = 'CALL'
        and timezone(target_timezone, occurred_at)::date >= timezone(target_timezone, now())::date - 6),
      'messages', (select count(*) from raw_activities where activity_kind = 'MESSAGE'
        and timezone(target_timezone, occurred_at)::date >= timezone(target_timezone, now())::date - 6),
      'followups', (select count(*) from raw_activities where activity_kind = 'FOLLOW_UP'
        and timezone(target_timezone, occurred_at)::date >= timezone(target_timezone, now())::date - 6),
      'test_drives', (select count(*) from raw_activities where activity_kind = 'TEST_DRIVE'
        and timezone(target_timezone, occurred_at)::date >= timezone(target_timezone, now())::date - 6),
      'quotations', (select count(*) from raw_activities where activity_kind = 'QUOTATION'
        and timezone(target_timezone, occurred_at)::date >= timezone(target_timezone, now())::date - 6),
      'notes', (select count(*) from raw_activities where activity_kind = 'NOTE'
        and timezone(target_timezone, occurred_at)::date >= timezone(target_timezone, now())::date - 6)
    ),
    'upcoming_followups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', followup_row.id,
        'customer_name', followup_row.customer_name,
        'detail', coalesce(nullif(btrim(followup_row.reason), ''), followup_row.interested_model),
        'due_at', followup_row.due_at,
        'priority', followup_row.priority
      ) order by followup_row.due_at asc, followup_row.id)
      from (
        select followup_row.*, lead_row.interested_model, customer_row.full_name as customer_name
        from public.followups followup_row
        join owned_leads lead_row on lead_row.id = followup_row.lead_id
        join public.customers customer_row
          on customer_row.organization_id = followup_row.organization_id
         and customer_row.id = followup_row.customer_id
         and customer_row.deleted_at is null
        where followup_row.organization_id = current_organization_id
          and followup_row.assigned_user_id = auth.uid()
          and followup_row.status in ('OPEN', 'OVERDUE')
          and followup_row.due_at >= now()
        order by followup_row.due_at asc, followup_row.id
        limit 4
      ) followup_row
    ), '[]'::jsonb),
    'recent_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', note_row.id,
        'body', note_row.body,
        'customer_name', note_row.customer_name,
        'created_at', note_row.created_at
      ) order by note_row.created_at desc, note_row.id desc)
      from (
        select note_row.*, customer_row.full_name as customer_name
        from public.notes note_row
        join public.customers customer_row
          on customer_row.organization_id = note_row.organization_id
         and customer_row.id = note_row.resource_id
         and lower(note_row.resource_type) = 'customer'
         and customer_row.deleted_at is null
        where note_row.organization_id = current_organization_id
          and note_row.deleted_at is null
          and exists (
            select 1 from owned_leads lead_row where lead_row.customer_id = customer_row.id
          )
        order by note_row.created_at desc, note_row.id desc
        limit 4
      ) note_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_sales_consultant_activity_timeline(text, text, integer, integer, text, text)
  from public, anon;
grant execute on function public.get_sales_consultant_activity_timeline(text, text, integer, integer, text, text)
  to authenticated;
