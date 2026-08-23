begin;

-- Preserve the existing implementations byte-for-byte for every non-Sales role.
-- The public wrappers below are the only executable entry points for authenticated users.
alter function public.get_lead_workspace_page_v2(
  integer, integer, text, text, text, text, text, text, text, date, date
) rename to get_lead_workspace_page_v2_legacy;
revoke all on function public.get_lead_workspace_page_v2_legacy(
  integer, integer, text, text, text, text, text, text, text, date, date
) from public, anon, authenticated;

alter function public.get_call_workspace_page(
  text, integer, integer, text, text, text, text
) rename to get_call_workspace_page_legacy;
revoke all on function public.get_call_workspace_page_legacy(
  text, integer, integer, text, text, text, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_lead_workspace_page(
  target_organization_id uuid,
  target_branch_ids uuid[],
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
    or auth.uid() is null
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
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
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
    with owned_leads as materialized (
      select
        lead_row.id,
        lead_row.source,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        lead_row.assigned_user_id,
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
      where lead_row.organization_id = target_organization_id
        and lead_row.assigned_user_id = auth.uid()
        and lead_row.branch_id = any(target_branch_ids)
        and lead_row.deleted_at is null
    ), test_drive_leads as materialized (
      select distinct drive_row.lead_id
      from public.test_drive_appointments drive_row
      join owned_leads lead_row on lead_row.id = drive_row.lead_id
      where drive_row.organization_id = target_organization_id
        and drive_row.lead_id is not null
    ), quotation_leads as materialized (
      select distinct quotation_row.lead_id
      from public.quotations quotation_row
      join owned_leads lead_row on lead_row.id = quotation_row.lead_id
      where quotation_row.organization_id = target_organization_id
        and quotation_row.lead_id is not null
        and quotation_row.deleted_at is null
    ), booking_leads as materialized (
      select distinct booking_row.lead_id
      from public.bookings booking_row
      join owned_leads lead_row on lead_row.id = booking_row.lead_id
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
      from owned_leads lead_row
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
    ), filtered_leads as materialized (
      select lead_row.*
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
        or lower(lead_row.customer_name) like '%' || lower(normalized_search) || '%'
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
      from filtered_leads lead_row
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
       and lead_row.assigned_user_id = auth.uid()
       and lead_row.branch_id = any(target_branch_ids)
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
      'total', (select count(*) from filtered_leads),
      'kpis', (select to_jsonb(kpis) from kpis),
      'filters', jsonb_build_object(
        'models', coalesce((
          select jsonb_agg(model_name order by model_name)
          from (
            select distinct interested_model as model_name
            from owned_leads
            where nullif(btrim(interested_model), '') is not null
            order by interested_model
            limit 100
          ) model_options
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(source_name order by source_name)
          from (
            select distinct source as source_name
            from owned_leads
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

revoke all on function app_private.get_sales_consultant_lead_workspace_page(
  uuid, uuid[], integer, integer, text, text, text, text, text, text, text, date, date
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_call_workspace_page(
  target_organization_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_lead_access boolean,
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
as $$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
  normalized_outcome text := upper(btrim(coalesce(target_outcome, 'ALL')));
  normalized_source text := upper(btrim(coalesce(target_source, 'ALL')));
  normalized_view text := upper(btrim(coalesce(target_view, 'HISTORY')));
  local_today date := pg_catalog.timezone('Asia/Kolkata', now())::date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  trend_start timestamptz;
  result jsonb;
begin
  if target_organization_id is null or auth.uid() is null then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
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

  today_start := pg_catalog.timezone('Asia/Kolkata', local_today::timestamp);
  tomorrow_start := pg_catalog.timezone('Asia/Kolkata', (local_today + 1)::timestamp);
  trend_start := pg_catalog.timezone('Asia/Kolkata', (local_today - 6)::timestamp);

  with sales_leads as not materialized (
    select
      lead_row.id,
      lead_row.customer_id
    from public.leads lead_row
    where lead_row.organization_id = target_organization_id
      and lead_row.assigned_user_id = auth.uid()
      and lead_row.branch_id = any(target_branch_ids)
      and lead_row.deleted_at is null
  ), accessible_customer_ids as not materialized (
    select distinct lead_row.customer_id
    from sales_leads lead_row
    where target_customer_access
      and lead_row.customer_id is not null
  ), owned_calls as materialized (
    select
      call_row.id,
      call_row.lead_id as linked_lead_id,
      call_row.customer_id as linked_customer_id,
      call_row.provider_call_id,
      call_row.call_source,
      call_row.started_at,
      call_row.duration_seconds,
      call_row.outcome,
      call_row.status
    from public.calls call_row
    where call_row.organization_id = target_organization_id
      and call_row.assigned_user_id = auth.uid()
      and call_row.branch_id = any(target_branch_ids)
  ), view_recording_ids as materialized (
    select latest_recording.call_id
    from (
      select distinct on (recording_row.call_id)
        recording_row.call_id,
        recording_row.object_file_id
      from public.call_recordings recording_row
      join owned_calls call_row on call_row.id = recording_row.call_id
      where normalized_view = 'RECORDINGS'
        and recording_row.organization_id = target_organization_id
      order by recording_row.call_id, recording_row.created_at desc, recording_row.id
    ) latest_recording
    join public.object_files file_row
      on file_row.organization_id = target_organization_id
     and file_row.id = latest_recording.object_file_id
     and file_row.resource_type = 'call'
     and file_row.resource_id = latest_recording.call_id
     and file_row.deleted_at is null
  ), view_ai_ids as materialized (
    select distinct summary_row.call_id
    from public.ai_call_summaries summary_row
    join owned_calls call_row on call_row.id = summary_row.call_id
    where normalized_view = 'AI'
      and summary_row.organization_id = target_organization_id
  ), filter_parties as materialized (
    select
      call_row.id,
      case
        when customer_row.id is not null then customer_row.full_name
        when target_lead_access and accessible_lead.id is not null
          then linked_lead.customer_name
        else null
      end as customer_name,
      case
        when customer_row.id is not null
          then customer_row.normalized_phone
        when target_lead_access and accessible_lead.id is not null
          then linked_lead.normalized_phone
        else ''
      end as search_phone
    from owned_calls call_row
    left join public.leads linked_lead
      on linked_lead.organization_id = target_organization_id
     and linked_lead.id = call_row.linked_lead_id
     and linked_lead.deleted_at is null
    left join sales_leads accessible_lead
      on accessible_lead.id = linked_lead.id
    left join accessible_customer_ids accessible_customer
      on accessible_customer.customer_id = coalesce(
        call_row.linked_customer_id,
        linked_lead.customer_id
      )
    left join public.customers customer_row
      on customer_row.organization_id = target_organization_id
     and customer_row.id = accessible_customer.customer_id
     and customer_row.deleted_at is null
    where normalized_search <> ''
      or target_sort in ('customer:asc', 'customer:desc')
  ), filtered_calls as materialized (
    select
      call_row.*,
      party_row.customer_name as sort_customer_name
    from owned_calls call_row
    left join filter_parties party_row on party_row.id = call_row.id
    left join view_recording_ids view_recording on view_recording.call_id = call_row.id
    left join view_ai_ids view_ai on view_ai.call_id = call_row.id
    where (normalized_status = 'ALL' or upper(call_row.status) = normalized_status)
      and (normalized_outcome = 'ALL' or upper(call_row.outcome) = normalized_outcome)
      and (normalized_source = 'ALL' or upper(call_row.call_source) = normalized_source)
      and (
        normalized_view = 'HISTORY'
        or (normalized_view = 'TODAY'
          and call_row.started_at >= today_start
          and call_row.started_at < tomorrow_start)
        or (normalized_view = 'MISSED'
          and upper(coalesce(call_row.outcome, '')) in (
            'NO_ANSWER', 'BUSY', 'SWITCHED_OFF'
          ))
        or (normalized_view = 'RECORDINGS' and view_recording.call_id is not null)
        or (normalized_view = 'AI' and view_ai.call_id is not null)
      )
      and (
        normalized_search = ''
        or call_row.id = search_uuid
        or lower(coalesce(party_row.customer_name, '')) like '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and (
            party_row.search_phone = search_phone_digits
            or party_row.search_phone like search_phone_digits || '%'
          )
        )
        or lower(coalesce(call_row.provider_call_id, '')) like '%' || normalized_search || '%'
      )
  ), page_ids as materialized (
    select call_row.id
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
  ), page_base as materialized (
    select
      call_row.id,
      call_row.organization_id,
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id,
      call_row.connection_id,
      call_row.lead_id as linked_lead_id,
      call_row.customer_id as linked_customer_id,
      call_row.provider_call_id,
      call_row.direction,
      call_row.call_source,
      call_row.started_at,
      call_row.ended_at,
      call_row.duration_seconds,
      call_row.outcome,
      call_row.status,
      call_row.version,
      call_row.updated_at
    from page_ids page_id
    join public.calls call_row
      on call_row.organization_id = target_organization_id
     and call_row.id = page_id.id
     and call_row.assigned_user_id = auth.uid()
     and call_row.branch_id = any(target_branch_ids)
  ), page_parties as materialized (
    select
      call_row.id,
      case when target_lead_access and accessible_lead.id is not null
        then accessible_lead.id else null end as lead_id,
      customer_row.id as customer_id,
      case
        when customer_row.id is not null then customer_row.full_name
        when target_lead_access and accessible_lead.id is not null
          then linked_lead.customer_name
        else null
      end as customer_name,
      case
        when customer_row.id is not null then customer_row.primary_phone
        when target_lead_access and accessible_lead.id is not null
          then linked_lead.phone
        else null
      end as phone
    from page_base call_row
    left join public.leads linked_lead
      on linked_lead.organization_id = call_row.organization_id
     and linked_lead.id = call_row.linked_lead_id
     and linked_lead.deleted_at is null
    left join sales_leads accessible_lead
      on accessible_lead.id = linked_lead.id
    left join accessible_customer_ids accessible_customer
      on accessible_customer.customer_id = coalesce(
        call_row.linked_customer_id,
        linked_lead.customer_id
      )
    left join public.customers customer_row
      on customer_row.organization_id = call_row.organization_id
     and customer_row.id = accessible_customer.customer_id
     and customer_row.deleted_at is null
  ), page_recordings as materialized (
    select distinct on (recording_row.call_id)
      recording_row.call_id,
      recording_row.status,
      case when file_row.id is not null then recording_row.object_file_id else null end
        as object_file_id
    from public.call_recordings recording_row
    join page_ids page_id on page_id.id = recording_row.call_id
    left join public.object_files file_row
      on file_row.organization_id = recording_row.organization_id
     and file_row.id = recording_row.object_file_id
     and file_row.resource_type = 'call'
     and file_row.resource_id = recording_row.call_id
     and file_row.deleted_at is null
    where recording_row.organization_id = target_organization_id
    order by recording_row.call_id, recording_row.created_at desc, recording_row.id
  ), page_transcripts as materialized (
    select distinct on (transcript_row.call_id)
      transcript_row.call_id,
      transcript_row.status
    from public.call_transcripts transcript_row
    join page_ids page_id on page_id.id = transcript_row.call_id
    where transcript_row.organization_id = target_organization_id
    order by transcript_row.call_id, transcript_row.created_at desc, transcript_row.id
  ), page_summaries as materialized (
    select distinct summary_row.call_id, true as has_summary
    from public.ai_call_summaries summary_row
    join page_ids page_id on page_id.id = summary_row.call_id
    where summary_row.organization_id = target_organization_id
  ), caller_identity as materialized (
    select
      profile_row.full_name as caller_name,
      role_result.role_name as caller_role
    from public.profiles profile_row
    left join lateral (
      select role_row.name as role_name
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.organization_id = assignment_row.organization_id
       and role_row.id = assignment_row.role_id
      where assignment_row.organization_id = target_organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
      order by role_row.authority_level desc, role_row.id
      limit 1
    ) role_result on true
    where profile_row.organization_id = target_organization_id
      and profile_row.id = auth.uid()
      and profile_row.active
      and profile_row.deleted_at is null
  ), page_rows as materialized (
    select
      page_row.*,
      party_row.lead_id,
      party_row.customer_id,
      party_row.customer_name,
      party_row.phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      caller_identity.caller_name,
      caller_identity.caller_role,
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
    cross join caller_identity
    left join public.connected_accounts connection_row
      on connection_row.organization_id = page_row.organization_id
     and connection_row.id = page_row.connection_id
     and connection_row.deleted_at is null
    left join page_recordings recording_row on recording_row.call_id = page_row.id
    left join page_transcripts transcript_row on transcript_row.call_id = page_row.id
    left join page_summaries summary_row on summary_row.call_id = page_row.id
  ), today_kpis as (
    select
      count(*)::bigint as total_today,
      count(*) filter (
        where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
      )::bigint as connected_today,
      count(*) filter (
        where upper(coalesce(call_row.outcome, '')) <> 'CONNECTED'
      )::bigint as not_connected_today,
      coalesce(sum(call_row.duration_seconds), 0)::bigint as talk_time_seconds,
      coalesce(round(avg(call_row.duration_seconds)), 0)::bigint
        as average_duration_seconds
    from owned_calls call_row
    where call_row.started_at >= today_start
      and call_row.started_at < tomorrow_start
  ), ready_recording_calls as materialized (
    select distinct recording_row.call_id
    from public.call_recordings recording_row
    join owned_calls call_row on call_row.id = recording_row.call_id
    join public.object_files file_row
      on file_row.organization_id = recording_row.organization_id
     and file_row.id = recording_row.object_file_id
     and file_row.resource_type = 'call'
     and file_row.resource_id = recording_row.call_id
     and file_row.deleted_at is null
    where recording_row.organization_id = target_organization_id
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
      from pg_catalog.generate_series(
        local_today - 6,
        local_today,
        interval '1 day'
      ) generated_day
    ) day_source
    left join owned_calls call_row
      on call_row.started_at >= pg_catalog.timezone(
        'Asia/Kolkata',
        day_source.metric_day::timestamp
      )
     and call_row.started_at < pg_catalog.timezone(
        'Asia/Kolkata',
        (day_source.metric_day + 1)::timestamp
      )
     and call_row.started_at >= trend_start
    group by day_source.metric_day
    order by day_source.metric_day
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
      ) order by
        case when target_sort = 'started:desc' then page_row.started_at end desc,
        case when target_sort = 'started:asc' then page_row.started_at end asc,
        case when target_sort = 'duration:desc'
          then page_row.duration_seconds end desc nulls last,
        case when target_sort = 'duration:asc'
          then page_row.duration_seconds end asc nulls last,
        case when target_sort = 'customer:asc'
          then lower(page_row.customer_name) end asc nulls last,
        case when target_sort = 'customer:desc'
          then lower(page_row.customer_name) end desc nulls last,
        page_row.id asc
      )
      from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_calls),
    'kpis', jsonb_build_object(
      'total_today', (select total_today from today_kpis),
      'connected_today', (select connected_today from today_kpis),
      'not_connected_today', (select not_connected_today from today_kpis),
      'talk_time_seconds', (select talk_time_seconds from today_kpis),
      'connection_rate', (
        select case when total_today = 0 then 0
          else round(100.0 * connected_today / total_today, 1)
        end
        from today_kpis
      ),
      'average_duration_seconds', (select average_duration_seconds from today_kpis),
      'callbacks_required', (
        select count(*)
        from owned_calls call_row
        where upper(coalesce(call_row.outcome, '')) = 'CALLBACK_REQUIRED'
      ),
      'recordings_ready', (select count(*) from ready_recording_calls)
    ),
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', to_char(trend_row.metric_day, 'DD Mon'),
        'value', trend_row.total,
        'secondary', trend_row.connected
      ) order by trend_row.metric_day)
      from trend_rows trend_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function app_private.get_sales_consultant_call_workspace_page(
  uuid, uuid[], boolean, boolean, text, integer, integer, text, text, text, text, text
) from public, anon, authenticated;

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
  allowed_branch_ids uuid[];
  permission_keys text[];
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('lead.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_lead_workspace_page(
      current_organization_id,
      allowed_branch_ids,
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

create or replace function public.get_call_workspace_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL',
  target_outcome text default 'ALL',
  target_source text default 'ALL',
  target_sort text default 'started:desc',
  target_view text default 'HISTORY'
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
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
  lead_access boolean;
  normalized_view text := upper(btrim(coalesce(target_view, 'HISTORY')));
begin
  if normalized_view not in ('TODAY', 'HISTORY', 'MISSED', 'RECORDINGS', 'AI') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_VIEW';
  end if;

  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('call.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    lead_access := 'lead.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_call_workspace_page(
      current_organization_id,
      allowed_branch_ids,
      customer_access,
      lead_access,
      target_search,
      target_page,
      target_page_size,
      target_status,
      target_outcome,
      target_source,
      target_sort,
      normalized_view
    );
  end if;

  return public.get_call_workspace_page_legacy(
    target_search,
    target_page,
    target_page_size,
    target_status,
    target_outcome,
    target_source,
    target_sort
  );
end;
$$;

revoke all on function public.get_call_workspace_page(
  text, integer, integer, text, text, text, text, text
) from public, anon;
grant execute on function public.get_call_workspace_page(
  text, integer, integer, text, text, text, text, text
) to authenticated;

commit;
