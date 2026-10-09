begin;

-- 1. Same-mobile context for Sales Consultants.
--
-- A customer can hold several opportunities at once -- a second model, a
-- separate purchase -- and each must be workable on its own. A consultant only
-- ever saw their own leads, so another enquiry on the same mobile (with a
-- Telecaller, or another consultant) was invisible and the group badge never
-- appeared for them.
--
-- get_lead_phone_history: for a consultant, also return the same-mobile leads in
-- their branches that fall outside their workspace scope, flagged context_only
-- with a reduced field set (no email, notes, customer link or provider ids).
-- In-scope rows are unchanged apart from context_only = false; other roles are
-- unaffected. get_sales_role_lead_workspace_page: a consultant's
-- phone_lead_count counts the same set, so the badge matches what expands.
--
-- 2. Mobile search.
--
-- Leads store mobiles as +91XXXXXXXXXX and customers mostly as 91XXXXXXXXXX,
-- but these searches compared the typed digits as-is: "8593939234" never
-- equalled or prefixed either form, so searching a 10-digit mobile found almost
-- nothing. Each phone arm now also tries the digits behind +91 and 91 (a typed
-- trunk 0 dropped; a search of only zeros adds no arm). The shared
-- phone_search_digits helper is left alone: it has 35 callers, some matching
-- staff phones stored without a country code.
--
-- Every body is text-patched from the deployed pg_get_functiondef output.

CREATE OR REPLACE FUNCTION app_private.get_sales_consultant_lead_workspace_page(target_organization_id uuid, target_branch_ids uuid[], target_page integer, target_page_size integer, target_search text, target_status text, target_sort text, target_model text, target_source text, target_stage text, target_temperature text, target_followup_from date, target_followup_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  search_phone_digits := app_private.phone_search_digits(normalized_search);
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
            and lead_row.created_at < pg_catalog.timezone('Asia/Kolkata', date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))) then 'PENDING'
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
            or lead_row.normalized_phone like search_phone_digits || '%' or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
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
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_consultant_followup_workspace_filtered_page(target_organization_id uuid, target_user_id uuid, target_branch_ids uuid[], target_customer_access boolean, target_search text, target_status text, target_priority text, target_branch_id uuid, target_team_id uuid, target_owner_id uuid, target_page integer, target_page_size integer, target_sort text, target_timezone text, target_model text DEFAULT ''::text, target_source text DEFAULT ''::text, target_temperature text DEFAULT 'all'::text, target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  has_lead_filters boolean;
begin
  -- Validation is performed by the public router; this function trusts its
  -- caller to have validated all inputs.

  normalized_search := lower(btrim(coalesce(target_search, '')));
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  if target_followup_from is not null then
    followup_from_at := target_followup_from::timestamp at time zone target_timezone;
  end if;
  if target_followup_to is not null then
    followup_to_exclusive_at := (target_followup_to + 1)::timestamp at time zone target_timezone;
  end if;

  has_lead_filters :=
       nullif(btrim(coalesce(target_model, '')), '') is not null
    or nullif(btrim(coalesce(target_source, '')), '') is not null
    or target_temperature is distinct from 'all';

  return (
    -- UNION so each arm keeps its index: the first rides
    -- followups(organization_id, assigned_user_id, …), the second walks
    -- leads(organization_id, assigned_user_id, …) into followups via lead_id.
    with owned_followups as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.followups followup_row
      where followup_row.organization_id = target_organization_id
        and (followup_row.lead_id is null or exists (
          select 1 from public.leads active_work_lead
          where active_work_lead.id = followup_row.lead_id
            and active_work_lead.organization_id = followup_row.organization_id
            and active_work_lead.deleted_at is null
        ))
        and followup_row.assigned_user_id = target_user_id
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      union
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.leads lead_row
      join public.followups followup_row
        on followup_row.lead_id = lead_row.id
       and followup_row.organization_id = target_organization_id
      where lead_row.organization_id = target_organization_id
        and lead_row.assigned_user_id = target_user_id
        and lead_row.deleted_at is null
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))

    -- Scope + lead filters. The left-join to leads is only needed when a lead
    -- filter is active or we need model/source/temperature for the output; the
    -- planner short-circuits the join conditions when has_lead_filters is false
    -- because every filter predicate starts with a null/all guard.
    ), scoped_followups as materialized (
      select
        followup_row.*,
        lead_row.interested_model as lead_interested_model,
        lead_row.source::text as lead_source,
        lead_row.temperature::text as lead_temperature
      from owned_followups followup_row
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
        and (nullif(btrim(coalesce(target_model, '')), '') is null
          or lead_row.interested_model = btrim(target_model))
        and (nullif(btrim(coalesce(target_source, '')), '') is null
          or lead_row.source::text = btrim(target_source))
        and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
        and (followup_from_at is null or followup_row.due_at >= followup_from_at)
        and (followup_to_exclusive_at is null or followup_row.due_at < followup_to_exclusive_at)

    -- Search (customer name / phone / UUID)
    ), searched_followups as materialized (
      select
        followup_row.*,
        case when target_customer_access then
          coalesce(
            customer_row.normalized_name,
            lower(lead_row.customer_name),
            'unlinked customer'
          )
        else null end as customer_sort
      from scoped_followups followup_row
      left join public.leads lead_row
        on target_customer_access
       and lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (
        normalized_search = ''
        or followup_row.id = search_uuid
        or followup_row.lead_id = search_uuid
        or (
          target_customer_access
          and (
            customer_row.normalized_name ilike '%' || normalized_search || '%'
            or lower(lead_row.customer_name) ilike '%' || normalized_search || '%'
            or (
              search_phone_digits <> ''
              and (
                customer_row.normalized_phone like search_phone_digits || '%'
                or customer_row.normalized_phone like '+' || search_phone_digits || '%' or customer_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or customer_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
                or lead_row.normalized_phone like search_phone_digits || '%'
                or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
              )
            )
          )
        )
      )

    -- Status tab filter
    ), searchable_followups as not materialized (
      select followup_row.*
      from searched_followups followup_row
      where case target_status
        when 'overdue' then followup_row.status = 'OPEN' and followup_row.due_at < query_now
        when 'today' then followup_row.status = 'OPEN'
          and followup_row.due_at >= day_start and followup_row.due_at < day_end
        when 'upcoming' then followup_row.status = 'OPEN' and followup_row.due_at >= day_end
        when 'completed' then followup_row.status = 'COMPLETED'
        when 'cancelled' then followup_row.status = 'CANCELLED'
        else true
      end

    -- KPI cards (scope-level, search-blind)
    ), followup_scope_stats as materialized (
      select
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= day_start and completed_at < day_end
        )::bigint as completed_today
      from scoped_followups

    -- Tab badge counts (search-aware, status-blind)
    ), followup_tab_stats as materialized (
      select
        count(*)::bigint as all_count,
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (where status = 'CANCELLED')::bigint as cancelled
      from searched_followups

    ), followup_filtered_stats as materialized (
      select count(*)::bigint as total from searchable_followups

    -- Pagination
    ), page_ids as materialized (
      select
        followup_row.id,
        followup_row.due_at,
        followup_row.updated_at,
        followup_row.customer_sort
      from searchable_followups followup_row
      order by
        case when target_sort = 'scheduled:asc' then followup_row.due_at end asc,
        case when target_sort = 'scheduled:desc' then followup_row.due_at end desc,
        case when target_sort = 'updated:desc' then followup_row.updated_at end desc,
        case when target_sort = 'updated:asc' then followup_row.updated_at end asc,
        case when target_sort = 'customer:asc' then followup_row.customer_sort end asc,
        case when target_sort = 'customer:desc' then followup_row.customer_sort end desc,
        followup_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)

    -- Hydrate display columns for the page slice only
    ), page_rows as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer')
        else 'Restricted' end as customer_name,
        case when target_customer_access then
          coalesce(customer_row.primary_phone, lead_row.phone)
        else null end as phone,
        lead_row.interested_model,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        case
          when followup_row.status = 'OPEN' and followup_row.due_at < query_now then 'OVERDUE'
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
        followup_row.updated_at,
        page_id.customer_sort
      from page_ids page_id
      join owned_followups followup_row on followup_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = followup_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = followup_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = followup_row.created_by
       and creator_profile.organization_id = target_organization_id
    )

    -- Assemble response
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'version', page_row.version,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model,
            'reason', page_row.reason,
            'priority', page_row.priority,
            'due_at', page_row.due_at,
            'display_status', page_row.display_status,
            'status', page_row.status,
            'assigned_user_id', page_row.assigned_user_id,
            'assigned_user_name', page_row.assigned_user_name,
            'created_by', page_row.created_by,
            'created_by_name', page_row.created_by_name,
            'branch_id', page_row.branch_id,
            'branch_name', page_row.branch_name,
            'team_id', page_row.team_id,
            'team_name', page_row.team_name,
            'completed_at', page_row.completed_at,
            'cancelled_at', page_row.cancelled_at,
            'updated_at', page_row.updated_at
          ) order by
            case when target_sort = 'scheduled:asc' then page_row.due_at end asc,
            case when target_sort = 'scheduled:desc' then page_row.due_at end desc,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'updated:asc' then page_row.updated_at end asc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            case when target_sort = 'customer:desc' then page_row.customer_sort end desc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from followup_filtered_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from followup_scope_stats),
        'today', (select today from followup_scope_stats),
        'upcoming', (select upcoming from followup_scope_stats),
        'completed_today', (select completed_today from followup_scope_stats)
      ),
      'status_counts', jsonb_build_object(
        'all', (select all_count from followup_tab_stats),
        'overdue', (select overdue from followup_tab_stats),
        'today', (select today from followup_tab_stats),
        'upcoming', (select upcoming from followup_tab_stats),
        'completed', (select completed from followup_tab_stats),
        'cancelled', (select cancelled from followup_tab_stats)
      ),
      'filters', jsonb_build_object(
        'branches', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', bf.branch_id, 'name', bf.branch_name)
            order by bf.branch_name
          )
          from (
            select distinct f.branch_id, b.name as branch_name
            from owned_followups f
            join public.branches b
              on b.id = f.branch_id
             and b.organization_id = target_organization_id
          ) bf
        ), '[]'::jsonb),
        'teams', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', tf.team_id, 'name', tf.team_name, 'branch_id', tf.branch_id)
            order by tf.team_name
          )
          from (
            select distinct f.team_id, t.name as team_name, f.branch_id
            from owned_followups f
            join public.teams t
              on t.id = f.team_id
             and t.organization_id = target_organization_id
            where f.team_id is not null
          ) tf
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', of_row.assigned_user_id, 'name', of_row.assigned_user_name)
            order by of_row.assigned_user_name
          )
          from (
            select distinct f.assigned_user_id, p.full_name as assigned_user_name
            from owned_followups f
            join public.profiles p
              on p.id = f.assigned_user_id
             and p.organization_id = target_organization_id
          ) of_row
        ), '[]'::jsonb),
        'models', coalesce((
          select jsonb_agg(mv.model order by mv.model)
          from (
            select distinct l.interested_model as model
            from owned_followups f
            join public.leads l
              on l.id = f.lead_id
             and l.organization_id = target_organization_id
             and l.deleted_at is null
            where l.interested_model is not null
          ) mv
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(sv.source order by sv.source)
          from (
            select distinct l.source::text as source
            from owned_followups f
            join public.leads l
              on l.id = f.lead_id
             and l.organization_id = target_organization_id
             and l.deleted_at is null
            where l.source is not null
          ) sv
        ), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_role_lead_workspace_page(target_organization_id uuid, target_actor_id uuid, target_organization_wide boolean, target_branch_scope_ids uuid[], target_team_scope_ids uuid[], target_owner_scope boolean, target_owner_branch_ids uuid[], target_page integer, target_page_size integer, target_search text, target_status text, target_sort text, target_model text, target_source text, target_stage text, target_temperature text, target_followup_from date, target_followup_to date, target_include_records boolean DEFAULT true, target_include_kpis boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_lead_id uuid;
  normalized_model text;
  normalized_source text;
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  query_now timestamptz := now();
  actor_is_sales_consultant boolean := false;
  actor_is_telecaller boolean := false;
  -- Personal pins for this viewer, most recently pinned first. Capped so the
  -- ordering join below stays a tiny hash probe even for heavy pinners.
  pinned_lead_ids uuid[];
  -- Leads this Telecaller handed to Sales; resolved once, not per row.
  telecaller_handoff_lead_ids uuid[] := array[]::uuid[];
  -- Windowed paging: records-only requests without search walk the scope in
  -- sort order and evaluate only a window of it (plus pins and phone-group
  -- siblings). candidate_lead_ids null means the whole scope.
  candidate_lead_ids uuid[];
  walk_ids uuid[];
  walk_sql text;
  walk_order text;
  walk_scope text;
  window_size integer;
  window_rows integer;
  window_last_id uuid;
  window_last_updated timestamptz;
  window_last_created timestamptz;
  window_last_name text;
  window_exhausted boolean := true;
  window_needed bigint;
  result jsonb;
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
      'lost', 'new-today', 'pending', 'sla-risk',
      'sales-new', 'sales-pending', 'sales-contacted',
      'starred'
    )
    or target_stage is null or target_stage not in (
      'all', 'New', 'Contacted', 'Qualified', 'Appointment Scheduled',
      'Transferred to Sales', 'Lost', 'Test Drive', 'Quotation', 'Booking'
    )
    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD', 'DORMANT')
    or target_sort is null or target_sort not in (
      'updated:desc', 'updated:asc', 'created:desc', 'created:asc',
      'customer:asc', 'customer:desc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)
  then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_WORKSPACE_QUERY';
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into actor_is_sales_consultant;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) into actor_is_telecaller;

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

  if actor_is_telecaller then
    select coalesce(array_agg(distinct history_row.lead_id), array[]::uuid[])
      into telecaller_handoff_lead_ids
    from public.lead_assignment_history history_row
    where history_row.organization_id = target_organization_id
      and history_row.previous_owner_id = target_actor_id
      and history_row.new_owner_id is not null
      and exists (
        select 1
        from public.lead_stage_history stage_row
        where stage_row.organization_id = target_organization_id
          and stage_row.lead_id = history_row.lead_id
          and stage_row.to_status = 'Transferred to Sales'
      );
  end if;

  select coalesce(array_agg(preference_row.lead_id order by preference_row.pinned_at desc), '{}'::uuid[])
  into pinned_lead_ids
  from (
    select preference_row.lead_id, preference_row.pinned_at
    from public.user_lead_preferences preference_row
    where preference_row.organization_id = target_organization_id
      and preference_row.user_id = target_actor_id
      and preference_row.pinned
    order by preference_row.pinned_at desc
    limit 200
  ) preference_row;

  window_needed := target_page::bigint * target_page_size;
  if target_include_records and not target_include_kpis
    and window_needed <= 5000
  then
    window_size := greatest(window_needed * 4, 200)::integer;
    window_exhausted := false;
    walk_order := case target_sort
      when 'updated:desc' then 'lead_row.updated_at desc, lead_row.id desc'
      when 'updated:asc' then 'lead_row.updated_at asc, lead_row.id desc'
      when 'created:desc' then 'lead_row.created_at desc, lead_row.id desc'
      when 'created:asc' then 'lead_row.created_at asc, lead_row.id desc'
      when 'customer:asc' then 'lead_row.customer_name asc, lead_row.id desc'
      when 'customer:desc' then 'lead_row.customer_name desc, lead_row.id desc'
    end;
    -- The walk may cover more leads than the workspace scope -- scoped_leads
    -- re-applies the exact predicate -- but never fewer: every in-scope lead
    -- that sorts before the window's last lead must be in the window.
    walk_scope := case when target_organization_wide then 'true' else concat_ws(' or ',
      case when cardinality(coalesce(target_branch_scope_ids, '{}')) > 0
        then 'lead_row.branch_id = any($5)' end,
      case when cardinality(coalesce(target_team_scope_ids, '{}')) > 0
        then 'lead_row.team_id = any($6)' end,
      case when target_owner_scope then
        '(lead_row.branch_id = any($8) and (lead_row.assigned_user_id = $3'
        || case when cardinality(telecaller_handoff_lead_ids) > 0
          then ' or lead_row.id = any($9)' else '' end
        || '))' end,
      'false'
    ) end;
    -- Column filters every matching lead must satisfy, so the walk skips leads
    -- that can never be paged. Each is implied by the exact filter applied later.
    walk_scope := '(' || walk_scope || ')'
      || case when target_status in ('hot', 'warm', 'cold')
        then ' and lead_row.temperature::text = ' || quote_literal(upper(target_status)) else '' end
      || case when target_temperature <> 'all'
        then ' and lead_row.temperature::text = ' || quote_literal(target_temperature) else '' end
      || case target_status
        when 'new' then ' and lead_row.lifecycle_status::text = ''New'''
        when 'contacted' then ' and lead_row.lifecycle_status::text = ''Contacted'''
        when 'qualified' then ' and lead_row.lifecycle_status::text = ''Qualified'''
        when 'appointment-scheduled' then ' and lead_row.lifecycle_status::text = ''Appointment Scheduled'''
        when 'transferred-to-sales' then ' and lead_row.lifecycle_status::text = ''Transferred to Sales'''
        when 'lost' then ' and lead_row.lifecycle_status::text = ''Lost'''
        else '' end
      || case when normalized_model is not null
        then ' and lead_row.interested_model = ' || quote_literal(normalized_model) else '' end
      || case when normalized_source is not null
        then ' and lead_row.source = ' || quote_literal(normalized_source) else '' end
      || case when followup_from_at is not null
        then ' and lead_row.next_followup_at >= ' || quote_literal(followup_from_at::text) || '::timestamptz' else '' end
      || case when followup_to_exclusive_at is not null
        then ' and lead_row.next_followup_at < ' || quote_literal(followup_to_exclusive_at::text) || '::timestamptz' else '' end
      -- The same search predicate filtered_lead_ids applies; the name arm can
      -- use the trigram index, so a search no longer reads the whole scope.
      || case when normalized_search <> '' then
        ' and (lead_row.id = $10'
        || ' or lower(lead_row.customer_name) like $11 escape ' || quote_literal(chr(92))
        || case when search_phone_digits <> ''
          then ' or lead_row.normalized_phone = $12 or lead_row.normalized_phone like $12 || ''%'' or lead_row.normalized_phone like ''+'' || $12 || ''%'' or lead_row.normalized_phone like ''+91'' || nullif(ltrim($12, ''0''), '''') || ''%'' or lead_row.normalized_phone like ''91'' || nullif(ltrim($12, ''0''), '''') || ''%''' else '' end
        || ')' else '' end;
    walk_sql := format($walk$
      select
        coalesce(array_agg(walk.id order by walk.rn), '{}'::uuid[]),
        count(*)::integer,
        (array_agg(walk.id order by walk.rn desc))[1],
        (array_agg(walk.updated_at order by walk.rn desc))[1],
        (array_agg(walk.created_at order by walk.rn desc))[1],
        (array_agg(walk.customer_name order by walk.rn desc))[1]
      from (
        select lead_row.id, lead_row.updated_at, lead_row.created_at, lead_row.customer_name,
          row_number() over (order by %1$s) as rn
        from public.leads lead_row
        where lead_row.organization_id = $1
          and lead_row.deleted_at is null
          and (%2$s)
          and (
            not $2
            or (
              lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
              and (
                lead_row.assigned_user_id = $3
                or exists (
                  select 1 from app_private.lead_sales_facts fact_row
                  where fact_row.lead_id = lead_row.id
                    and fact_row.sales_handoff_at is not null
                )
              )
            )
          )
        order by %1$s
        limit $4
      ) walk
    $walk$, walk_order, walk_scope);
  end if;

  loop
    if not window_exhausted then
      execute walk_sql
        into walk_ids, window_rows, window_last_id,
          window_last_updated, window_last_created, window_last_name
        using target_organization_id, actor_is_sales_consultant, target_actor_id,
          window_size, target_branch_scope_ids, target_team_scope_ids,
          target_owner_scope, target_owner_branch_ids, telecaller_handoff_lead_ids,
          search_lead_id,
          '%' || replace(lower(normalized_search), '_', E'\\_') || '%',
          search_phone_digits;
      if window_rows < window_size then
        -- The walk reached the end of the scope: the window is the scope.
        window_exhausted := true;
        window_last_id := null;
      end if;
      -- Pins always page first, and every phone group touched by the window
      -- must be complete for group heads and phone_lead_count to be exact.
      select coalesce(array_agg(distinct member_id), '{}'::uuid[])
        into candidate_lead_ids
      from (
        select unnest(walk_ids || pinned_lead_ids) as member_id
        union
        select sibling_row.id
        from public.leads sibling_row
        where sibling_row.organization_id = target_organization_id
          and sibling_row.deleted_at is null
          and sibling_row.normalized_phone <> ''
          and sibling_row.normalized_phone in (
            select member_row.normalized_phone
            from public.leads member_row
            where member_row.id = any(walk_ids || pinned_lead_ids)
              and member_row.organization_id = target_organization_id
              and member_row.normalized_phone <> ''
          )
      ) members;
    end if;

    result := (
    with pinned_leads as materialized (
      select
        pin_id as lead_id,
        pin_rank
      from unnest(pinned_lead_ids) with ordinality as pins(pin_id, pin_rank)
    ), scoped_leads as materialized (
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
        count(*) over (partition by coalesce(
          nullif(lead_row.normalized_phone, ''),
          lead_row.id::text
        )) as phone_lead_count,
        lead_row.next_followup_at,
        actor_is_telecaller and (lead_row.id = any(telecaller_handoff_lead_ids) and lead_row.assigned_user_id is distinct from target_actor_id) as is_handoff_read_only,
        fact_row.sales_handoff_at,
        fact_row.sales_contacted_at,
        coalesce(fact_row.has_test_drive, false) as has_test_drive,
        coalesce(fact_row.has_quotation, false) as has_quotation,
        coalesce(fact_row.has_booking, false) as has_booking,
        case
          when lead_row.lifecycle_status = 'Lost' then null
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and query_now > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and lead_row.created_at < pg_catalog.timezone('Asia/Kolkata', date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))) then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      -- Two branches gated by one-time filters: a window is fetched by primary
      -- key, the full scope by the usual scan. A single OR here would scan the
      -- whole scope even for a 200-lead window.
      from (
        select window_row.* from public.leads window_row
        where candidate_lead_ids is not null and window_row.id = any(candidate_lead_ids)
        union all
        select scope_row.* from public.leads scope_row
        where candidate_lead_ids is null and scope_row.organization_id = target_organization_id
      ) lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      left join app_private.lead_sales_facts fact_row on fact_row.lead_id = lead_row.id
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
        and (
          not actor_is_sales_consultant
          or (
            lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
            and (
              lead_row.assigned_user_id = target_actor_id
              or fact_row.sales_handoff_at is not null
            )
          )
        )
        and (
          target_organization_wide
          or lead_row.branch_id = any(target_branch_scope_ids)
          or (
            lead_row.team_id is not null
            and lead_row.team_id = any(target_team_scope_ids)
          )
          or (
            target_owner_scope
            and lead_row.branch_id = any(target_owner_branch_ids)
            and (
              lead_row.assigned_user_id = target_actor_id
              or (
                actor_is_telecaller
                and (lead_row.id = any(telecaller_handoff_lead_ids) and lead_row.assigned_user_id is distinct from target_actor_id)
              )
            )
          )
        )
    ), staged_leads as materialized (
      select
        lead_row.*,
        case
          when lead_row.lifecycle_status = 'Lost' then 'Lost'
          when lead_row.has_booking then 'Booking'
          when lead_row.has_quotation then 'Quotation'
          when lead_row.has_test_drive then 'Test Drive'
          when actor_is_sales_consultant
            and lead_row.lifecycle_status = 'Transferred to Sales'
            and lead_row.sales_contacted_at >= lead_row.sales_handoff_at then 'Sales Contacted'
          else lead_row.lifecycle_status::text
        end as lead_stage
      from scoped_leads lead_row
    ), filtered_lead_ids as materialized (
      select
        lead_row.id,
        lead_row.updated_at,
        lead_row.created_at,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.lifecycle_status
      from staged_leads lead_row
      where (
        not lead_row.is_handoff_read_only
        or target_status in ('all', 'transferred-to-sales', 'starred')
      )
      and (
        target_status = 'all'
        or (target_status = 'hot' and lead_row.temperature = 'HOT')
        or (target_status = 'starred' and exists (
          select 1
          from public.user_lead_preferences starred_row
          where starred_row.organization_id = target_organization_id
            and starred_row.user_id = target_actor_id
            and starred_row.lead_id = lead_row.id
            and starred_row.starred
        ))
        or (target_status = 'warm' and lead_row.temperature = 'WARM')
        or (target_status = 'cold' and lead_row.temperature = 'COLD')
        or (target_status = 'follow-up' and lead_row.next_followup_at is not null
          and lead_row.lifecycle_status <> 'Lost'
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking)
        or (target_status = 'test-drive' and lead_row.has_test_drive and not lead_row.has_quotation and not lead_row.has_booking and lead_row.lifecycle_status <> 'Lost')
        or (target_status = 'quotation' and lead_row.has_quotation and not lead_row.has_booking and lead_row.lifecycle_status <> 'Lost')
        or (target_status = 'booking' and lead_row.has_booking and lead_row.lifecycle_status <> 'Lost')
        or (target_status = 'new' and lead_row.lifecycle_status = 'New')
        or (target_status = 'contacted' and lead_row.lifecycle_status = 'Contacted'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.next_followup_at is null)
        or (target_status = 'qualified' and lead_row.lifecycle_status = 'Qualified')
        or (target_status = 'appointment-scheduled'
          and lead_row.lifecycle_status = 'Appointment Scheduled'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking)
        or (target_status = 'transferred-to-sales'
          and lead_row.lifecycle_status = 'Transferred to Sales')
        or (target_status = 'lost' and lead_row.lifecycle_status = 'Lost')
        or (
          target_status = 'new-today'
          and (
            (
              actor_is_sales_consultant
              and lead_row.sales_handoff_at >= pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
              and lead_row.sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now)) + interval '1 day'
              )
            )
            or (not actor_is_sales_consultant and lead_row.work_state = 'NEW_TODAY')
          )
        )
        or (target_status = 'pending' and lead_row.work_state = 'PENDING')
        or (target_status = 'sla-risk' and lead_row.work_state = 'SLA_RISK')
        or (
          target_status = 'sales-new'
          and actor_is_sales_consultant
          and lead_row.lifecycle_status <> 'Lost'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and lead_row.next_followup_at is null
          and lead_row.sales_handoff_at >= pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and lead_row.sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              ) + interval '1 day'
          and (lead_row.sales_contacted_at is null or lead_row.sales_contacted_at < lead_row.sales_handoff_at)
        )
        or (
          target_status = 'sales-pending'
          and actor_is_sales_consultant
          and lead_row.lifecycle_status <> 'Lost'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and lead_row.next_followup_at is null
          and lead_row.sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and (lead_row.sales_contacted_at is null or lead_row.sales_contacted_at < lead_row.sales_handoff_at)
        )
        or (
          target_status = 'sales-contacted'
          and actor_is_sales_consultant
          and lead_row.lifecycle_status <> 'Lost'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and lead_row.next_followup_at is null
          and lead_row.sales_contacted_at >= lead_row.sales_handoff_at
        )
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
            or lead_row.normalized_phone like search_phone_digits || '%' or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
          )
        )
      )
    ), phone_group_lead_ids as materialized (
      select distinct on (
        coalesce(nullif(lead_row.normalized_phone, ''), lead_row.id::text)
      )
        lead_row.id,
        lead_row.updated_at,
        lead_row.created_at,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.lifecycle_status
      from filtered_lead_ids lead_row
      order by
        coalesce(nullif(lead_row.normalized_phone, ''), lead_row.id::text),
        case
          when lead_row.lifecycle_status = 'Lost' then 2
          when lead_row.lifecycle_status = 'Transferred to Sales'
            and not actor_is_sales_consultant then 1
          else 0
        end,
        lead_row.created_at desc,
        lead_row.id desc
    ), page_ids as materialized (
      select lead_row.id
      from phone_group_lead_ids lead_row
      left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
      where target_include_records
        and (
        window_last_id is null
        or pin_row.lead_id is not null
        or case target_sort
          when 'updated:desc' then lead_row.updated_at > window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'updated:asc' then lead_row.updated_at < window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'created:desc' then lead_row.created_at > window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'created:asc' then lead_row.created_at < window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'customer:asc' then lead_row.customer_name < window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end
      )
      order by
        pin_row.pin_rank asc nulls last,
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
        stage_row.is_handoff_read_only,
        stage_row.work_state,
        stage_row.lead_stage,
        lead_row.first_contacted_at,
        lead_row.sla_due_at,
        lead_row.next_followup_at,
        stage_row.sales_handoff_at,
        stage_row.sales_contacted_at,
        lead_row.created_at,
        lead_row.updated_at,
        profile_row.full_name as assigned_user_name,
        case when exists (
          select 1
          from public.user_role_assignments consultant_assignment
          join public.roles consultant_role
            on consultant_role.id = consultant_assignment.role_id
           and consultant_role.organization_id = consultant_assignment.organization_id
          where consultant_assignment.organization_id = lead_row.organization_id
            and consultant_assignment.user_id = lead_row.assigned_user_id
            and consultant_assignment.active
            and consultant_role.role_key = 'sales_consultant'
        ) then profile_row.full_name end as assigned_consultant_name,
        -- A consultant's group badge counts the same-mobile leads that
        -- get_lead_phone_history returns to them, so it matches what expands.
        case
          when actor_is_sales_consultant and lead_row.normalized_phone <> '' then greatest(
            stage_row.phone_lead_count,
            (
              select count(*)
              from public.leads sibling_row
              where sibling_row.organization_id = target_organization_id
                and sibling_row.normalized_phone = lead_row.normalized_phone
                and sibling_row.deleted_at is null
                and (
                  target_organization_wide
                  or sibling_row.branch_id = any(target_branch_scope_ids)
                  or sibling_row.branch_id = any(target_owner_branch_ids)
                )
            )
          )
          else stage_row.phone_lead_count
        end as phone_lead_count
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
        count(*) filter (where next_followup_at is not null
          and lifecycle_status <> 'Lost'
          and lifecycle_status <> 'Appointment Scheduled'
          and not has_test_drive
          and not has_quotation
          and not has_booking)::bigint as follow_up,
        count(*) filter (where has_test_drive and not has_quotation and not has_booking and lifecycle_status <> 'Lost')::bigint as test_drive,
        count(*) filter (where has_quotation and not has_booking and lifecycle_status <> 'Lost')::bigint as quotation,
        count(*) filter (where has_booking and lifecycle_status <> 'Lost')::bigint as booking,
        count(*) filter (where (
          actor_is_sales_consultant
          and sales_handoff_at >= pg_catalog.timezone(
            'Asia/Kolkata',
            date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
          )
          and sales_handoff_at < pg_catalog.timezone(
            'Asia/Kolkata',
            date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now)) + interval '1 day'
          )
        ) or (not actor_is_sales_consultant and work_state = 'NEW_TODAY'))::bigint as new_today,
        count(*) filter (where work_state = 'PENDING')::bigint as pending,
        count(*) filter (where work_state = 'SLA_RISK')::bigint as sla_risk,
        count(*) filter (where lifecycle_status = 'Qualified')::bigint as qualified,
        count(*) filter (where lifecycle_status = 'New')::bigint as new_count,
        count(*) filter (
          where lifecycle_status = 'Contacted'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and next_followup_at is null
        )::bigint as contacted_count,
        count(*) filter (
          where lifecycle_status = 'Appointment Scheduled'
            and not has_test_drive
            and not has_quotation
            and not has_booking
        )::bigint as appointment_scheduled_count,
        count(*) filter (
          where lifecycle_status = 'Transferred to Sales'
        )::bigint as transferred_to_sales_count,
        count(*) filter (where lifecycle_status = 'Lost')::bigint as lost_count,
        count(*) filter (where actor_is_sales_consultant
          and lifecycle_status <> 'Lost'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and lifecycle_status <> 'Appointment Scheduled'
          and next_followup_at is null
          and sales_handoff_at >= pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              ) + interval '1 day'
          and (sales_contacted_at is null or sales_contacted_at < sales_handoff_at))::bigint as sales_new_today,
        count(*) filter (where actor_is_sales_consultant
          and lifecycle_status <> 'Lost'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and lifecycle_status <> 'Appointment Scheduled'
          and next_followup_at is null
          and sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and (sales_contacted_at is null or sales_contacted_at < sales_handoff_at))::bigint as sales_pending,
        count(*) filter (where actor_is_sales_consultant
          and lifecycle_status <> 'Lost'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and lifecycle_status <> 'Appointment Scheduled'
          and next_followup_at is null
          and sales_contacted_at >= sales_handoff_at)::bigint as sales_contacted,
        count(*) filter (where exists (
          select 1
          from public.user_lead_preferences starred_kpi_row
          where starred_kpi_row.organization_id = target_organization_id
            and starred_kpi_row.user_id = target_actor_id
            and starred_kpi_row.lead_id = staged_leads.id
            and starred_kpi_row.starred
        ))::bigint as starred_count
      from staged_leads
      where target_include_kpis
    )
    select jsonb_build_object(
      'window_eligible', case when window_last_id is null then null else (
        select count(*)
        from phone_group_lead_ids lead_row
        left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
        where (
        window_last_id is null
        or pin_row.lead_id is not null
        or case target_sort
          when 'updated:desc' then lead_row.updated_at > window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'updated:asc' then lead_row.updated_at < window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'created:desc' then lead_row.created_at > window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'created:asc' then lead_row.created_at < window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'customer:asc' then lead_row.customer_name < window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end
      )
      ) end,
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
          'assigned_consultant_name', assigned_consultant_name,
          'read_only', is_handoff_read_only,
          'phone_lead_count', phone_lead_count,
          'first_contacted_at', first_contacted_at,
          'sla_due_at', sla_due_at,
          'next_followup_at', next_followup_at,
          'created_at', created_at,
          'updated_at', updated_at
        ) order by
          (select pin_row.pin_rank from pinned_leads pin_row where pin_row.lead_id = page_rows.id)
            asc nulls last,
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
      'total', case
        when target_include_kpis then (select count(*) from phone_group_lead_ids)
        else null
      end,
      'lead_total', case
        when target_include_kpis then (select count(*) from filtered_lead_ids)
        else null
      end,
      'kpis', case when target_include_kpis then (select to_jsonb(kpis) from kpis) else null end,
      'filters', case when not target_include_kpis then null else jsonb_build_object(
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
      ) end
    )
    );
    exit when window_exhausted
      or (result->>'window_eligible')::bigint >= window_needed;
    -- Not enough heads before the window's end: widen it, and past a bound
    -- evaluate the whole scope instead.
    window_size := window_size * 4;
    if window_size > 20000 then
      window_exhausted := true;
      window_last_id := null;
      candidate_lead_ids := null;
    end if;
  end loop;
  return result - 'window_eligible';
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_consultant_appointment_workspace_page(target_organization_id uuid, target_user_id uuid, target_branch_ids uuid[], target_customer_access boolean, target_search text, target_status text, target_appointment_type text, target_branch_id uuid, target_team_id uuid, target_owner_id uuid, target_page integer, target_page_size integer, target_sort text, target_timezone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_user_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_page is null
    or target_page not between 1 and 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_status is null or target_status not in (
    'all', 'today', 'upcoming', 'confirmed', 'arrived', 'completed',
    'no-show', 'rescheduled', 'cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type is null
    or target_appointment_type not in (
      'all', 'Showroom Visit', 'Video Call', 'Test Drive', 'Consultant Call'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE_FILTER';
  end if;
  if target_sort is null or target_sort not in (
    'scheduled:asc', 'scheduled:desc', 'updated:desc',
    'updated:asc', 'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_WORK_SORT';
  end if;
  if target_timezone is null or not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';

  return (
    with owned_appointments as not materialized (
      select
        appointment_row.id,
        appointment_row.version,
        appointment_row.lead_id,
        appointment_row.customer_id,
        appointment_row.appointment_type,
        appointment_row.scheduled_at,
        appointment_row.status,
        coalesce(appointment_row.attendance_status, 'NOT_ARRIVED') as attendance_status,
        appointment_row.notes,
        appointment_row.assigned_user_id,
        appointment_row.created_by,
        appointment_row.branch_id,
        appointment_row.team_id,
        appointment_row.confirmed_at,
        appointment_row.arrived_at,
        appointment_row.completed_at,
        appointment_row.cancelled_at,
        appointment_row.updated_at
      from public.appointments appointment_row
      where appointment_row.organization_id = target_organization_id
        and appointment_row.assigned_user_id = target_user_id
        and appointment_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
    ), scoped_appointments as not materialized (
      select appointment_row.*
      from owned_appointments appointment_row
      where (target_branch_id is null or appointment_row.branch_id = target_branch_id)
        and (target_team_id is null or appointment_row.team_id = target_team_id)
        and (target_owner_id is null or appointment_row.assigned_user_id = target_owner_id)
        and (
          target_appointment_type = 'all'
          or appointment_row.appointment_type = target_appointment_type
        )
    ), searchable_appointments as not materialized (
      select
        appointment_row.*,
        case when target_customer_access then customer_row.normalized_name else null end
          as customer_sort
      from scoped_appointments appointment_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = appointment_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (
        normalized_search = ''
        or appointment_row.id = search_uuid
        or appointment_row.lead_id = search_uuid
        or (
          target_customer_access
          and (
            customer_row.normalized_name ilike '%' || normalized_search || '%'
            or (
              search_phone_digits <> ''
              and (
                customer_row.normalized_phone like search_phone_digits || '%'
                or customer_row.normalized_phone like '+' || search_phone_digits || '%' or customer_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or customer_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
              )
            )
          )
        )
      )
      and case target_status
        when 'today' then appointment_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
          and appointment_row.scheduled_at >= day_start
          and appointment_row.scheduled_at < day_end
        when 'upcoming' then appointment_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
          and appointment_row.scheduled_at >= day_end
        when 'confirmed' then appointment_row.status = 'CONFIRMED'
        when 'arrived' then appointment_row.attendance_status = 'ARRIVED'
        when 'completed' then appointment_row.status = 'COMPLETED'
        when 'no-show' then appointment_row.status = 'NO_SHOW'
        when 'rescheduled' then appointment_row.status = 'RESCHEDULED'
        when 'cancelled' then appointment_row.status = 'CANCELLED'
        else true
      end
    ), appointment_scope_stats as materialized (
      select
        count(*) filter (
          where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
            and scheduled_at >= day_start and scheduled_at < day_end
        )::bigint as today,
        count(*) filter (
          where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
            and scheduled_at >= day_end
        )::bigint as upcoming,
        count(*) filter (where status = 'CONFIRMED')::bigint as confirmed,
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (where status = 'NO_SHOW')::bigint as no_show,
        count(*) filter (where attendance_status = 'ARRIVED')::bigint as arrived
      from scoped_appointments
    ), appointment_filtered_stats as materialized (
      select count(*)::bigint as total from searchable_appointments
    ), page_ids as materialized (
      select
        appointment_row.id,
        appointment_row.scheduled_at,
        appointment_row.updated_at,
        appointment_row.customer_sort
      from searchable_appointments appointment_row
      order by
        case when target_sort = 'scheduled:asc' then appointment_row.scheduled_at end asc,
        case when target_sort = 'scheduled:desc' then appointment_row.scheduled_at end desc,
        case when target_sort = 'updated:desc' then appointment_row.updated_at end desc,
        case when target_sort = 'updated:asc' then appointment_row.updated_at end asc,
        case when target_sort = 'customer:asc' then appointment_row.customer_sort end asc,
        case when target_sort = 'customer:desc' then appointment_row.customer_sort end desc,
        appointment_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        appointment_row.id,
        appointment_row.version,
        appointment_row.lead_id,
        appointment_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, 'Restricted')
        else 'Restricted' end
          as customer_name,
        case when target_customer_access then customer_row.primary_phone else null end
          as phone,
        lead_row.interested_model,
        appointment_row.appointment_type,
        appointment_row.scheduled_at,
        appointment_row.status,
        appointment_row.attendance_status,
        appointment_row.notes,
        appointment_row.assigned_user_id,
        assigned_profile.full_name as assigned_user_name,
        appointment_row.created_by,
        creator_profile.full_name as created_by_name,
        appointment_row.branch_id,
        branch_row.name as branch_name,
        appointment_row.team_id,
        team_row.name as team_name,
        appointment_row.confirmed_at,
        appointment_row.arrived_at,
        appointment_row.completed_at,
        appointment_row.cancelled_at,
        appointment_row.updated_at,
        page_id.customer_sort
      from page_ids page_id
      join owned_appointments appointment_row on appointment_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = appointment_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = appointment_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = appointment_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = appointment_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = appointment_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = appointment_row.created_by
       and creator_profile.organization_id = target_organization_id
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'version', page_row.version,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model,
            'appointment_type', page_row.appointment_type,
            'scheduled_at', page_row.scheduled_at,
            'status', page_row.status,
            'attendance_status', page_row.attendance_status,
            'notes', page_row.notes,
            'assigned_user_id', page_row.assigned_user_id,
            'assigned_user_name', page_row.assigned_user_name,
            'created_by', page_row.created_by,
            'created_by_name', page_row.created_by_name,
            'branch_id', page_row.branch_id,
            'branch_name', page_row.branch_name,
            'team_id', page_row.team_id,
            'team_name', page_row.team_name,
            'confirmed_at', page_row.confirmed_at,
            'arrived_at', page_row.arrived_at,
            'completed_at', page_row.completed_at,
            'cancelled_at', page_row.cancelled_at,
            'updated_at', page_row.updated_at
          ) order by
            case when target_sort = 'scheduled:asc' then page_row.scheduled_at end asc,
            case when target_sort = 'scheduled:desc' then page_row.scheduled_at end desc,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'updated:asc' then page_row.updated_at end asc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            case when target_sort = 'customer:desc' then page_row.customer_sort end desc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from appointment_filtered_stats),
      'kpis', jsonb_build_object(
        'today', (select today from appointment_scope_stats),
        'upcoming', (select upcoming from appointment_scope_stats),
        'confirmed', (select confirmed from appointment_scope_stats),
        'completed', (select completed from appointment_scope_stats),
        'no_show', (select no_show from appointment_scope_stats),
        'arrived', (select arrived from appointment_scope_stats)
      ),
      'filters', jsonb_build_object(
        'branches', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', branch_filter.branch_id, 'name', branch_filter.branch_name)
            order by branch_filter.branch_name
          )
          from (
            select distinct appointment_row.branch_id, branch_row.name as branch_name
            from owned_appointments appointment_row
            join public.branches branch_row
              on branch_row.id = appointment_row.branch_id
             and branch_row.organization_id = target_organization_id
          ) branch_filter
        ), '[]'::jsonb),
        'teams', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', team_filter.team_id,
              'name', team_filter.team_name,
              'branch_id', team_filter.branch_id
            ) order by team_filter.team_name
          )
          from (
            select distinct appointment_row.team_id, team_row.name as team_name, appointment_row.branch_id
            from owned_appointments appointment_row
            join public.teams team_row
              on team_row.id = appointment_row.team_id
             and team_row.organization_id = target_organization_id
            where appointment_row.team_id is not null
          ) team_filter
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', owner_filter.assigned_user_id,
              'name', owner_filter.assigned_user_name
            ) order by owner_filter.assigned_user_name
          )
          from (
            select distinct
              appointment_row.assigned_user_id,
              profile_row.full_name as assigned_user_name
            from owned_appointments appointment_row
            join public.profiles profile_row
              on profile_row.id = appointment_row.assigned_user_id
             and profile_row.organization_id = target_organization_id
          ) owner_filter
        ), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_consultant_followup_workspace_page(target_organization_id uuid, target_user_id uuid, target_branch_ids uuid[], target_customer_access boolean, target_search text, target_status text, target_priority text, target_branch_id uuid, target_team_id uuid, target_owner_id uuid, target_page integer, target_page_size integer, target_sort text, target_timezone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_user_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_page is null
    or target_page not between 1 and 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if target_status is null
    or target_status not in ('all', 'overdue', 'today', 'upcoming', 'completed', 'cancelled')
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_FILTER';
  end if;
  if target_priority is null
    or target_priority not in ('all', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY_FILTER';
  end if;
  if target_sort is null or target_sort not in (
    'scheduled:asc', 'scheduled:desc', 'updated:desc',
    'updated:asc', 'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_WORK_SORT';
  end if;
  if target_timezone is null or not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';

  return (
    -- Written as a UNION rather than an OR so each arm keeps its index: the
    -- first rides followups(organization_id, assigned_user_id, due_at, id),
    -- the second walks leads(organization_id, assigned_user_id, ...) into
    -- followups(organization_id, lead_id, due_at, id). An OR across the two
    -- collapses both into a sequential scan of the tenant's follow-ups.
    with owned_followups as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.followups followup_row
      where followup_row.organization_id = target_organization_id
        and (followup_row.lead_id is null or exists (
          select 1 from public.leads active_work_lead
          where active_work_lead.id = followup_row.lead_id
            and active_work_lead.organization_id = followup_row.organization_id
            and active_work_lead.deleted_at is null
        ))
        and followup_row.assigned_user_id = target_user_id
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      union
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.leads lead_row
      join public.followups followup_row
        on followup_row.lead_id = lead_row.id
       and followup_row.organization_id = target_organization_id
      where lead_row.organization_id = target_organization_id
        and lead_row.assigned_user_id = target_user_id
        and lead_row.deleted_at is null
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
    ), scoped_followups as materialized (
      select followup_row.*
      from owned_followups followup_row
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
    ), searched_followups as materialized (
      select
        followup_row.*,
        case when target_customer_access then
          coalesce(
            customer_row.normalized_name,
            lower(lead_row.customer_name),
            'unlinked customer'
          )
        else null end as customer_sort
      from scoped_followups followup_row
      left join public.leads lead_row
        on target_customer_access
       and lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (
        normalized_search = ''
        or followup_row.id = search_uuid
        or followup_row.lead_id = search_uuid
        or (
          target_customer_access
          and (
            customer_row.normalized_name ilike '%' || normalized_search || '%'
            or lower(lead_row.customer_name) ilike '%' || normalized_search || '%'
            or (
              search_phone_digits <> ''
              and (
                customer_row.normalized_phone like search_phone_digits || '%'
                or customer_row.normalized_phone like '+' || search_phone_digits || '%' or customer_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or customer_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
                or lead_row.normalized_phone like search_phone_digits || '%'
                or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
              )
            )
          )
        )
      )
    ), searchable_followups as not materialized (
      select followup_row.*
      from searched_followups followup_row
      where case target_status
        when 'overdue' then followup_row.status = 'OPEN' and followup_row.due_at < query_now
        when 'today' then followup_row.status = 'OPEN'
          and followup_row.due_at >= day_start and followup_row.due_at < day_end
        when 'upcoming' then followup_row.status = 'OPEN' and followup_row.due_at >= day_end
        when 'completed' then followup_row.status = 'COMPLETED'
        when 'cancelled' then followup_row.status = 'CANCELLED'
        else true
      end
    ), followup_scope_stats as materialized (
      select
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= day_start and completed_at < day_end
        )::bigint as completed_today
      from scoped_followups
    ), followup_tab_stats as materialized (
      select
        count(*)::bigint as all_count,
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (where status = 'CANCELLED')::bigint as cancelled
      from searched_followups
    ), followup_filtered_stats as materialized (
      select count(*)::bigint as total from searchable_followups
    ), page_ids as materialized (
      select
        followup_row.id,
        followup_row.due_at,
        followup_row.updated_at,
        followup_row.customer_sort
      from searchable_followups followup_row
      order by
        case when target_sort = 'scheduled:asc' then followup_row.due_at end asc,
        case when target_sort = 'scheduled:desc' then followup_row.due_at end desc,
        case when target_sort = 'updated:desc' then followup_row.updated_at end desc,
        case when target_sort = 'updated:asc' then followup_row.updated_at end asc,
        case when target_sort = 'customer:asc' then followup_row.customer_sort end asc,
        case when target_sort = 'customer:desc' then followup_row.customer_sort end desc,
        followup_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer')
        else 'Restricted' end as customer_name,
        case when target_customer_access then
          coalesce(customer_row.primary_phone, lead_row.phone)
        else null end as phone,
        lead_row.interested_model,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        case
          when followup_row.status = 'OPEN' and followup_row.due_at < query_now then 'OVERDUE'
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
        followup_row.updated_at,
        page_id.customer_sort
      from page_ids page_id
      join owned_followups followup_row on followup_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = followup_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = followup_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = followup_row.created_by
       and creator_profile.organization_id = target_organization_id
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'version', page_row.version,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model,
            'reason', page_row.reason,
            'priority', page_row.priority,
            'due_at', page_row.due_at,
            'display_status', page_row.display_status,
            'status', page_row.status,
            'assigned_user_id', page_row.assigned_user_id,
            'assigned_user_name', page_row.assigned_user_name,
            'created_by', page_row.created_by,
            'created_by_name', page_row.created_by_name,
            'branch_id', page_row.branch_id,
            'branch_name', page_row.branch_name,
            'team_id', page_row.team_id,
            'team_name', page_row.team_name,
            'completed_at', page_row.completed_at,
            'cancelled_at', page_row.cancelled_at,
            'updated_at', page_row.updated_at
          ) order by
            case when target_sort = 'scheduled:asc' then page_row.due_at end asc,
            case when target_sort = 'scheduled:desc' then page_row.due_at end desc,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'updated:asc' then page_row.updated_at end asc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            case when target_sort = 'customer:desc' then page_row.customer_sort end desc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from followup_filtered_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from followup_scope_stats),
        'today', (select today from followup_scope_stats),
        'upcoming', (select upcoming from followup_scope_stats),
        'completed_today', (select completed_today from followup_scope_stats)
      ),
      'status_counts', jsonb_build_object(
        'all', (select all_count from followup_tab_stats),
        'overdue', (select overdue from followup_tab_stats),
        'today', (select today from followup_tab_stats),
        'upcoming', (select upcoming from followup_tab_stats),
        'completed', (select completed from followup_tab_stats),
        'cancelled', (select cancelled from followup_tab_stats)
      ),
      'filters', jsonb_build_object(
        'branches', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', branch_filter.branch_id, 'name', branch_filter.branch_name)
            order by branch_filter.branch_name
          )
          from (
            select distinct followup_row.branch_id, branch_row.name as branch_name
            from owned_followups followup_row
            join public.branches branch_row
              on branch_row.id = followup_row.branch_id
             and branch_row.organization_id = target_organization_id
          ) branch_filter
        ), '[]'::jsonb),
        'teams', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', team_filter.team_id,
              'name', team_filter.team_name,
              'branch_id', team_filter.branch_id
            ) order by team_filter.team_name
          )
          from (
            select distinct followup_row.team_id, team_row.name as team_name, followup_row.branch_id
            from owned_followups followup_row
            join public.teams team_row
              on team_row.id = followup_row.team_id
             and team_row.organization_id = target_organization_id
            where followup_row.team_id is not null
          ) team_filter
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', owner_filter.assigned_user_id,
              'name', owner_filter.assigned_user_name
            ) order by owner_filter.assigned_user_name
          )
          from (
            select distinct
              followup_row.assigned_user_id,
              profile_row.full_name as assigned_user_name
            from owned_followups followup_row
            join public.profiles profile_row
              on profile_row.id = followup_row.assigned_user_id
             and profile_row.organization_id = target_organization_id
          ) owner_filter
        ), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_consultant_appointment_calendar(target_organization_id uuid, target_user_id uuid, target_branch_ids uuid[], target_customer_access boolean, target_month date, target_day date, target_search text, target_status text, target_appointment_type text, target_branch_id uuid, target_team_id uuid, target_owner_id uuid, target_timezone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  local_today date;
  month_start timestamptz;
  month_end timestamptz;
  day_start timestamptz;
  day_end timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_user_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_timezone is null or not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  if target_status is null or target_status not in (
    'all', 'today', 'upcoming', 'confirmed', 'arrived', 'completed',
    'no-show', 'rescheduled', 'cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type is null or target_appointment_type not in (
    'all', 'Showroom Visit', 'Video Call', 'Consultant Call'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE_FILTER';
  end if;

  local_today := (query_now at time zone target_timezone)::date;
  if target_month is null
    or target_month < (date_trunc('month', local_today)::date - interval '1 year')::date
    or target_month > (date_trunc('month', local_today)::date + interval '2 years')::date
  then
    raise exception using errcode = '22023', message = 'APPOINTMENT_MONTH_OUT_OF_RANGE';
  end if;
  if target_day is not null
    and (target_day < target_month or target_day >= (target_month + interval '1 month')::date)
  then
    raise exception using errcode = '22023', message = 'APPOINTMENT_DAY_OUT_OF_RANGE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  month_start := target_month::timestamp at time zone target_timezone;
  month_end := (target_month + interval '1 month')::timestamp at time zone target_timezone;
  day_start := local_today::timestamp at time zone target_timezone;
  day_end := (local_today + 1)::timestamp at time zone target_timezone;

  return (
    with owned_appointments as materialized (
      select
        appointment_row.id,
        appointment_row.version,
        appointment_row.lead_id,
        appointment_row.customer_id,
        appointment_row.appointment_type,
        appointment_row.scheduled_at,
        appointment_row.status,
        coalesce(appointment_row.attendance_status, 'NOT_ARRIVED') as attendance_status,
        appointment_row.notes,
        appointment_row.assigned_user_id,
        appointment_row.created_by,
        appointment_row.branch_id,
        appointment_row.team_id,
        appointment_row.confirmed_at,
        appointment_row.arrived_at,
        appointment_row.completed_at,
        appointment_row.cancelled_at,
        appointment_row.updated_at
      from public.appointments appointment_row
      where appointment_row.organization_id = target_organization_id
        and appointment_row.assigned_user_id = target_user_id
        and appointment_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
        and appointment_row.scheduled_at >= month_start
        and appointment_row.scheduled_at < month_end
    ), filtered_appointments as materialized (
      select appointment_row.*
      from owned_appointments appointment_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = appointment_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (target_branch_id is null or appointment_row.branch_id = target_branch_id)
        and (target_team_id is null or appointment_row.team_id = target_team_id)
        and (target_owner_id is null or appointment_row.assigned_user_id = target_owner_id)
        and (
          target_appointment_type = 'all'
          or appointment_row.appointment_type = target_appointment_type
        )
        and (
          normalized_search = ''
          or appointment_row.id = search_uuid
          or appointment_row.lead_id = search_uuid
          or (
            target_customer_access
            and (
              customer_row.normalized_name ilike '%' || normalized_search || '%'
              or (
                search_phone_digits <> ''
                and (
                  customer_row.normalized_phone like search_phone_digits || '%'
                  or customer_row.normalized_phone like '+' || search_phone_digits || '%' or customer_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or customer_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
                )
              )
            )
          )
        )
        and case target_status
          when 'today' then appointment_row.scheduled_at >= day_start
            and appointment_row.scheduled_at < day_end
          when 'upcoming' then appointment_row.scheduled_at >= day_end
            and appointment_row.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
          when 'confirmed' then appointment_row.status = 'CONFIRMED'
          when 'arrived' then appointment_row.attendance_status = 'ARRIVED'
          when 'completed' then appointment_row.status = 'COMPLETED'
          when 'no-show' then appointment_row.status = 'NO_SHOW'
            or appointment_row.attendance_status = 'NO_SHOW'
          when 'rescheduled' then appointment_row.status = 'RESCHEDULED'
          when 'cancelled' then appointment_row.status = 'CANCELLED'
          else true
        end
    ), month_records as materialized (
      select
        appointment_row.id,
        appointment_row.version,
        appointment_row.lead_id,
        appointment_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, 'Restricted')
        else 'Restricted' end
          as customer_name,
        case when target_customer_access then customer_row.primary_phone else null end
          as phone,
        lead_row.interested_model,
        appointment_row.appointment_type,
        appointment_row.scheduled_at,
        appointment_row.status,
        appointment_row.attendance_status,
        appointment_row.notes,
        appointment_row.assigned_user_id,
        assigned_profile.full_name as assigned_user_name,
        appointment_row.created_by,
        creator_profile.full_name as created_by_name,
        appointment_row.branch_id,
        branch_row.name as branch_name,
        appointment_row.team_id,
        team_row.name as team_name,
        appointment_row.confirmed_at,
        appointment_row.arrived_at,
        appointment_row.completed_at,
        appointment_row.cancelled_at,
        appointment_row.updated_at,
        (appointment_row.scheduled_at at time zone target_timezone)::date as local_date
      from filtered_appointments appointment_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = appointment_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      left join public.leads lead_row
        on lead_row.id = appointment_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = appointment_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = appointment_row.created_by
       and creator_profile.organization_id = target_organization_id
      join public.branches branch_row
        on branch_row.id = appointment_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = appointment_row.team_id
       and team_row.organization_id = target_organization_id
    ), ranked_records as materialized (
      select
        appointment_row.*,
        row_number() over (
          partition by appointment_row.local_date
          order by appointment_row.scheduled_at, appointment_row.id
        ) as day_rank,
        count(*) over (partition by appointment_row.local_date) as day_total
      from month_records appointment_row
    ), day_rows as (
      select
        appointment_row.local_date,
        max(appointment_row.day_total)::integer as total,
        jsonb_agg(
          to_jsonb(appointment_row) - 'local_date' - 'day_rank' - 'day_total'
          order by appointment_row.scheduled_at, appointment_row.id
        ) filter (where target_day is not null or appointment_row.day_rank <= 3) as items
      from ranked_records appointment_row
      where target_day is null or appointment_row.local_date = target_day
      group by appointment_row.local_date
    )
    select jsonb_build_object(
      'month', target_month,
      'month_total', (select count(*) from filtered_appointments),
      'days', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'date', day_row.local_date,
            'total', day_row.total,
            'items', day_row.items
          ) order by day_row.local_date
        )
        from day_rows day_row
      ), '[]'::jsonb),
      'timezone', target_timezone
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_consultant_followup_calendar(target_organization_id uuid, target_user_id uuid, target_branch_ids uuid[], target_customer_access boolean, target_month date, target_day date, target_search text, target_status text, target_priority text, target_branch_id uuid, target_team_id uuid, target_owner_id uuid, target_timezone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  local_today date;
  current_month date;
  next_month date;
  month_start timestamptz;
  month_end timestamptz;
  day_start timestamptz;
  day_end timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_user_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_timezone is null or not app_private.is_valid_timezone(target_timezone) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  if target_status is null
    or target_status not in ('all', 'overdue', 'today', 'upcoming', 'completed', 'cancelled')
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_FILTER';
  end if;
  if target_priority is null
    or target_priority not in ('all', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
  then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY_FILTER';
  end if;

  local_today := (query_now at time zone target_timezone)::date;
  current_month := date_trunc('month', local_today)::date;
  next_month := (current_month + interval '1 month')::date;
  if target_month is null or target_month not in (current_month, next_month) then
    raise exception using errcode = '22023', message = 'FOLLOWUP_MONTH_OUT_OF_RANGE';
  end if;
  if target_day is not null
    and (target_day < target_month or target_day >= (target_month + interval '1 month')::date)
  then
    raise exception using errcode = '22023', message = 'FOLLOWUP_DAY_OUT_OF_RANGE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  month_start := target_month::timestamp at time zone target_timezone;
  month_end := (target_month + interval '1 month')::timestamp at time zone target_timezone;
  day_start := local_today::timestamp at time zone target_timezone;
  day_end := (local_today + 1)::timestamp at time zone target_timezone;

  return (
    with owned_followups as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.followups followup_row
      where followup_row.organization_id = target_organization_id
        and (followup_row.lead_id is null or exists (
          select 1 from public.leads active_work_lead
          where active_work_lead.id = followup_row.lead_id
            and active_work_lead.organization_id = followup_row.organization_id
            and active_work_lead.deleted_at is null
        ))
        and followup_row.assigned_user_id = target_user_id
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      union
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.leads lead_row
      join public.followups followup_row
        on followup_row.lead_id = lead_row.id
       and followup_row.organization_id = target_organization_id
      where lead_row.organization_id = target_organization_id
        and lead_row.assigned_user_id = target_user_id
        and lead_row.deleted_at is null
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
    ), scope_filtered as not materialized (
      select followup_row.*
      from owned_followups followup_row
      left join public.leads lead_row
        on target_customer_access
       and lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
        and (
          normalized_search = ''
          or followup_row.id = search_uuid
          or followup_row.lead_id = search_uuid
          or (
            target_customer_access
            and (
              customer_row.normalized_name ilike '%' || normalized_search || '%'
              or lower(lead_row.customer_name) ilike '%' || normalized_search || '%'
              or (
                search_phone_digits <> ''
                and (
                  customer_row.normalized_phone like search_phone_digits || '%'
                  or customer_row.normalized_phone like '+' || search_phone_digits || '%' or customer_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or customer_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
                  or lead_row.normalized_phone like search_phone_digits || '%'
                  or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
                )
              )
            )
          )
        )
    ), status_filtered as not materialized (
      select followup_row.*
      from scope_filtered followup_row
      where case target_status
        when 'overdue' then followup_row.status = 'OPEN' and followup_row.due_at < query_now
        when 'today' then followup_row.status = 'OPEN'
          and followup_row.due_at >= day_start and followup_row.due_at < day_end
        when 'upcoming' then followup_row.status = 'OPEN' and followup_row.due_at >= day_end
        when 'completed' then followup_row.status = 'COMPLETED'
        when 'cancelled' then followup_row.status = 'CANCELLED'
        else true
      end
    ), month_facts as not materialized (
      select followup_row.*
      from status_filtered followup_row
      where followup_row.due_at >= month_start and followup_row.due_at < month_end
    ), month_records as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer')
        else 'Restricted' end as customer_name,
        case when target_customer_access then
          coalesce(customer_row.primary_phone, lead_row.phone)
        else null end as phone,
        lead_row.interested_model,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        case
          when followup_row.status = 'OPEN' and followup_row.due_at < query_now then 'OVERDUE'
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
        followup_row.updated_at,
        (followup_row.due_at at time zone target_timezone)::date as local_date
      from month_facts followup_row
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = followup_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = followup_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = followup_row.created_by
       and creator_profile.organization_id = target_organization_id
    ), ranked_records as materialized (
      select
        followup_row.*,
        row_number() over (
          partition by followup_row.local_date
          order by followup_row.due_at, followup_row.id
        ) as day_rank,
        count(*) over (partition by followup_row.local_date) as day_total
      from month_records followup_row
    ), day_rows as (
      select
        followup_row.local_date,
        max(followup_row.day_total)::integer as total,
        jsonb_agg(
          to_jsonb(followup_row) - 'local_date' - 'day_rank' - 'day_total'
          order by followup_row.due_at, followup_row.id
        ) filter (where target_day is not null or followup_row.day_rank <= 3) as items
      from ranked_records followup_row
      where target_day is null or followup_row.local_date = target_day
      group by followup_row.local_date
    )
    select jsonb_build_object(
      'month', target_month,
      'month_total', (select count(*) from month_facts),
      'status_counts', jsonb_build_object(
        'all', (select count(*) from scope_filtered),
        'overdue', (
          select count(*) from scope_filtered where status = 'OPEN' and due_at < query_now
        ),
        'today', (
          select count(*) from scope_filtered
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        ),
        'upcoming', (
          select count(*) from scope_filtered where status = 'OPEN' and due_at >= day_end
        ),
        'completed', (select count(*) from scope_filtered where status = 'COMPLETED'),
        'cancelled', (select count(*) from scope_filtered where status = 'CANCELLED')
      ),
      'days', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'date', day_row.local_date,
            'total', day_row.total,
            'items', day_row.items
          ) order by day_row.local_date
        )
        from day_rows day_row
      ), '[]'::jsonb),
      'timezone', target_timezone
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_telecaller_followup_workspace_filtered_page(target_organization_id uuid, target_user_id uuid, target_branch_ids uuid[], target_customer_access boolean, target_search text, target_status text, target_priority text, target_branch_id uuid, target_team_id uuid, target_owner_id uuid, target_page integer, target_page_size integer, target_sort text, target_timezone text, target_model text DEFAULT ''::text, target_source text DEFAULT ''::text, target_temperature text DEFAULT 'all'::text, target_followup_from date DEFAULT NULL::date, target_followup_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  has_lead_filters boolean;
begin
  -- Validation is performed by the public router; this function trusts its
  -- caller to have validated all inputs.

  normalized_search := lower(btrim(coalesce(target_search, '')));
  search_phone_digits := app_private.phone_search_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  if target_followup_from is not null then
    followup_from_at := target_followup_from::timestamp at time zone target_timezone;
  end if;
  if target_followup_to is not null then
    followup_to_exclusive_at := (target_followup_to + 1)::timestamp at time zone target_timezone;
  end if;

  has_lead_filters :=
       nullif(btrim(coalesce(target_model, '')), '') is not null
    or nullif(btrim(coalesce(target_source, '')), '') is not null
    or target_temperature is distinct from 'all';

  return (
    with owned_followups as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.followups followup_row
      where followup_row.organization_id = target_organization_id
        and (followup_row.lead_id is null or exists (
          select 1 from public.leads active_work_lead
          where active_work_lead.id = followup_row.lead_id
            and active_work_lead.organization_id = followup_row.organization_id
            and active_work_lead.deleted_at is null
        ))
        and followup_row.assigned_user_id = target_user_id
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      union
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        followup_row.status,
        followup_row.assigned_user_id,
        followup_row.created_by,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.completed_at,
        followup_row.cancelled_at,
        followup_row.updated_at
      from public.leads lead_row
      join public.followups followup_row
        on followup_row.lead_id = lead_row.id
       and followup_row.organization_id = target_organization_id
      where lead_row.organization_id = target_organization_id
        and lead_row.assigned_user_id = target_user_id
        and lead_row.deleted_at is null
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))

    ), scoped_followups as materialized (
      select
        followup_row.*,
        lead_row.interested_model as lead_interested_model,
        lead_row.source::text as lead_source,
        lead_row.temperature::text as lead_temperature
      from owned_followups followup_row
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
        and (nullif(btrim(coalesce(target_model, '')), '') is null
          or lead_row.interested_model = btrim(target_model))
        and (nullif(btrim(coalesce(target_source, '')), '') is null
          or lead_row.source::text = btrim(target_source))
        and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
        and (followup_from_at is null or followup_row.due_at >= followup_from_at)
        and (followup_to_exclusive_at is null or followup_row.due_at < followup_to_exclusive_at)

    ), searched_followups as materialized (
      select
        followup_row.*,
        case when target_customer_access then
          coalesce(
            customer_row.normalized_name,
            lower(lead_row.customer_name),
            'unlinked customer'
          )
        else null end as customer_sort
      from scoped_followups followup_row
      left join public.leads lead_row
        on target_customer_access
       and lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      where (
        normalized_search = ''
        or followup_row.id = search_uuid
        or followup_row.lead_id = search_uuid
        or (
          target_customer_access
          and (
            customer_row.normalized_name ilike '%' || normalized_search || '%'
            or lower(lead_row.customer_name) ilike '%' || normalized_search || '%'
            or (
              search_phone_digits <> ''
              and (
                customer_row.normalized_phone like search_phone_digits || '%'
                or customer_row.normalized_phone like '+' || search_phone_digits || '%' or customer_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or customer_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
                or lead_row.normalized_phone like search_phone_digits || '%'
                or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
              )
            )
          )
        )
      )

    ), searchable_followups as not materialized (
      select followup_row.*
      from searched_followups followup_row
      where case target_status
        when 'overdue' then followup_row.status = 'OPEN' and followup_row.due_at < query_now
        when 'today' then followup_row.status = 'OPEN'
          and followup_row.due_at >= day_start and followup_row.due_at < day_end
        when 'upcoming' then followup_row.status = 'OPEN' and followup_row.due_at >= day_end
        when 'completed' then followup_row.status = 'COMPLETED'
        when 'cancelled' then followup_row.status = 'CANCELLED'
        else true
      end

    ), followup_scope_stats as materialized (
      select
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= day_start and completed_at < day_end
        )::bigint as completed_today
      from scoped_followups

    ), followup_tab_stats as materialized (
      select
        count(*)::bigint as all_count,
        count(*) filter (where status = 'OPEN' and due_at < query_now)::bigint as overdue,
        count(*) filter (
          where status = 'OPEN' and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (where status = 'OPEN' and due_at >= day_end)::bigint as upcoming,
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (where status = 'CANCELLED')::bigint as cancelled
      from searched_followups

    ), followup_filtered_stats as materialized (
      select count(*)::bigint as total from searchable_followups

    ), page_ids as materialized (
      select
        followup_row.id,
        followup_row.due_at,
        followup_row.updated_at,
        followup_row.customer_sort
      from searchable_followups followup_row
      order by
        case when target_sort = 'scheduled:asc' then followup_row.due_at end asc,
        case when target_sort = 'scheduled:desc' then followup_row.due_at end desc,
        case when target_sort = 'updated:desc' then followup_row.updated_at end desc,
        case when target_sort = 'updated:asc' then followup_row.updated_at end asc,
        case when target_sort = 'customer:asc' then followup_row.customer_sort end asc,
        case when target_sort = 'customer:desc' then followup_row.customer_sort end desc,
        followup_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)

    ), page_rows as materialized (
      select
        followup_row.id,
        followup_row.version,
        followup_row.lead_id,
        followup_row.customer_id,
        case when target_customer_access then
          coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer')
        else 'Restricted' end as customer_name,
        case when target_customer_access then
          coalesce(customer_row.primary_phone, lead_row.phone)
        else null end as phone,
        lead_row.interested_model,
        followup_row.reason,
        followup_row.priority,
        followup_row.due_at,
        case
          when followup_row.status = 'OPEN' and followup_row.due_at < query_now then 'OVERDUE'
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
        followup_row.updated_at,
        page_id.customer_sort
      from page_ids page_id
      join owned_followups followup_row on followup_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = followup_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = followup_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = followup_row.lead_id
       and lead_row.organization_id = target_organization_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = followup_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.profiles assigned_profile
        on assigned_profile.id = followup_row.assigned_user_id
       and assigned_profile.organization_id = target_organization_id
      left join public.profiles creator_profile
        on creator_profile.id = followup_row.created_by
       and creator_profile.organization_id = target_organization_id
    )

    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'version', page_row.version,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model,
            'reason', page_row.reason,
            'priority', page_row.priority,
            'due_at', page_row.due_at,
            'display_status', page_row.display_status,
            'status', page_row.status,
            'assigned_user_id', page_row.assigned_user_id,
            'assigned_user_name', page_row.assigned_user_name,
            'created_by', page_row.created_by,
            'created_by_name', page_row.created_by_name,
            'branch_id', page_row.branch_id,
            'branch_name', page_row.branch_name,
            'team_id', page_row.team_id,
            'team_name', page_row.team_name,
            'completed_at', page_row.completed_at,
            'cancelled_at', page_row.cancelled_at,
            'updated_at', page_row.updated_at
          ) order by
            case when target_sort = 'scheduled:asc' then page_row.due_at end asc,
            case when target_sort = 'scheduled:desc' then page_row.due_at end desc,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'updated:asc' then page_row.updated_at end asc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            case when target_sort = 'customer:desc' then page_row.customer_sort end desc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from followup_filtered_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from followup_scope_stats),
        'today', (select today from followup_scope_stats),
        'upcoming', (select upcoming from followup_scope_stats),
        'completed_today', (select completed_today from followup_scope_stats)
      ),
      'status_counts', jsonb_build_object(
        'all', (select all_count from followup_tab_stats),
        'overdue', (select overdue from followup_tab_stats),
        'today', (select today from followup_tab_stats),
        'upcoming', (select upcoming from followup_tab_stats),
        'completed', (select completed from followup_tab_stats),
        'cancelled', (select cancelled from followup_tab_stats)
      ),
      'filters', jsonb_build_object(
        'branches', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', bf.branch_id, 'name', bf.branch_name)
            order by bf.branch_name
          )
          from (
            select distinct f.branch_id, b.name as branch_name
            from owned_followups f
            join public.branches b
              on b.id = f.branch_id
             and b.organization_id = target_organization_id
          ) bf
        ), '[]'::jsonb),
        'teams', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', tf.team_id, 'name', tf.team_name, 'branch_id', tf.branch_id)
            order by tf.team_name
          )
          from (
            select distinct f.team_id, t.name as team_name, f.branch_id
            from owned_followups f
            join public.teams t
              on t.id = f.team_id
             and t.organization_id = target_organization_id
            where f.team_id is not null
          ) tf
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', of_row.assigned_user_id, 'name', of_row.assigned_user_name)
            order by of_row.assigned_user_name
          )
          from (
            select distinct f.assigned_user_id, p.full_name as assigned_user_name
            from owned_followups f
            join public.profiles p
              on p.id = f.assigned_user_id
             and p.organization_id = target_organization_id
          ) of_row
        ), '[]'::jsonb),
        'models', coalesce((
          select jsonb_agg(mv.model order by mv.model)
          from (
            select distinct l.interested_model as model
            from owned_followups f
            join public.leads l
              on l.id = f.lead_id
             and l.organization_id = target_organization_id
             and l.deleted_at is null
            where l.interested_model is not null
          ) mv
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(sv.source order by sv.source)
          from (
            select distinct l.source::text as source
            from owned_followups f
            join public.leads l
              on l.id = f.lead_id
             and l.organization_id = target_organization_id
             and l.deleted_at is null
            where l.source is not null
          ) sv
        ), '[]'::jsonb)
      ),
      'timezone', target_timezone
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_lead_phone_history(target_lead_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  access_context jsonb;
  current_organization_id uuid;
  workspace_scope record;
  actor_is_sales_consultant boolean := false;
  actor_is_telecaller boolean := false;
  anchor_phone text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'organization_id' is null
    or not (access_context->>'role_key' = any(array[
      'telecaller', 'sales-consultant', 'team-manager', 'showroom-manager', 'gm-sales'
    ]::text[]))
  then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  select * into workspace_scope
  from app_private.resolve_sales_lead_workspace_scope(current_organization_id);
  if not ('lead.view' = any(workspace_scope.permission_keys)) then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;
  actor_is_sales_consultant := access_context->>'role_key' = 'sales-consultant';
  actor_is_telecaller := access_context->>'role_key' = 'telecaller';

  select lead_row.normalized_phone into anchor_phone
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
    and (
      workspace_scope.organization_wide
      or lead_row.branch_id = any(workspace_scope.branch_scope_ids)
      or (lead_row.team_id is not null and lead_row.team_id = any(workspace_scope.team_scope_ids))
      or (
        workspace_scope.owner_scope
        and lead_row.branch_id = any(workspace_scope.owner_branch_ids)
        and (
          lead_row.assigned_user_id = auth.uid()
          or (
            actor_is_telecaller
            and app_private.is_telecaller_handoff_viewer(
              current_organization_id, lead_row.id, auth.uid()
            )
          )
        )
      )
    )
    and (
      not actor_is_sales_consultant
      or (
        lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
        and (
          lead_row.assigned_user_id = auth.uid()
          or exists (
            select 1
            from public.lead_stage_history handoff_history
            where handoff_history.organization_id = current_organization_id
              and handoff_history.lead_id = lead_row.id
              and handoff_history.to_status = 'Transferred to Sales'
          )
        )
      )
    );
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  return (
    with phone_leads as materialized (
      -- in_scope is the workspace rule this function always applied. A
      -- consultant additionally sees the other enquiries on the same mobile
      -- in their branches, as context rows with a reduced field set, so a
      -- customer's separate opportunities are visible beside their own.
      select lead_row.*,
        (
            (
              workspace_scope.organization_wide
              or lead_row.branch_id = any(workspace_scope.branch_scope_ids)
              or (lead_row.team_id is not null and lead_row.team_id = any(workspace_scope.team_scope_ids))
              or (
                workspace_scope.owner_scope
                and lead_row.branch_id = any(workspace_scope.owner_branch_ids)
                and (
                  lead_row.assigned_user_id = auth.uid()
                  or (
                    actor_is_telecaller
                    and app_private.is_telecaller_handoff_viewer(
                      current_organization_id, lead_row.id, auth.uid()
                    )
                  )
                )
              )
            )
            and (
              not actor_is_sales_consultant
              or (
                lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
                and (
                  lead_row.assigned_user_id = auth.uid()
                  or exists (
                    select 1
                    from public.lead_stage_history handoff_history
                    where handoff_history.organization_id = current_organization_id
                      and handoff_history.lead_id = lead_row.id
                      and handoff_history.to_status = 'Transferred to Sales'
                  )
                )
              )
            )
            ) as in_scope
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and (
          (nullif(anchor_phone, '') is not null and lead_row.normalized_phone = anchor_phone)
          or lead_row.id = target_lead_id
        )
    ), scoped_phone_leads as materialized (
      select phone_lead.*
      from phone_leads phone_lead
      where phone_lead.in_scope
        or (
          actor_is_sales_consultant
          and (
            workspace_scope.organization_wide
            or phone_lead.branch_id = any(workspace_scope.branch_scope_ids)
            or phone_lead.branch_id = any(workspace_scope.owner_branch_ids)
          )
        )
    ), history_rows as (
      select
        lead_row.*,
        profile_row.full_name as assigned_user_name,
        case when exists (
          select 1
          from public.user_role_assignments consultant_assignment
          join public.roles consultant_role
            on consultant_role.id = consultant_assignment.role_id
           and consultant_role.organization_id = consultant_assignment.organization_id
          where consultant_assignment.organization_id = lead_row.organization_id
            and consultant_assignment.user_id = lead_row.assigned_user_id
            and consultant_assignment.active
            and consultant_role.role_key = 'sales_consultant'
        ) then profile_row.full_name end as assigned_consultant_name,
        case
          when lead_row.lifecycle_status = 'Lost' then 'Lost'
          when exists (
            select 1 from public.bookings booking_row
            where booking_row.organization_id = current_organization_id
              and booking_row.lead_id = lead_row.id
              and booking_row.deleted_at is null
              and booking_row.status <> 'CANCELLED'
          ) then 'Booking'
          when exists (
            select 1 from public.quotations quotation_row
            where quotation_row.organization_id = current_organization_id
              and quotation_row.lead_id = lead_row.id
              and quotation_row.deleted_at is null
          ) then 'Quotation'
          when exists (
            select 1 from public.test_drive_appointments drive_row
            where drive_row.organization_id = current_organization_id
              and drive_row.lead_id = lead_row.id
          ) then 'Test Drive'
          when actor_is_sales_consultant
            and lead_row.lifecycle_status = 'Transferred to Sales'
            and exists (
              select 1 from public.activities activity_row
              where activity_row.organization_id = current_organization_id
                and activity_row.lead_id = lead_row.id
                and activity_row.activity_type = 'SALES_CONTACTED'
            ) then 'Sales Contacted'
          else lead_row.lifecycle_status::text
        end as lead_stage,
        case
          when lead_row.lifecycle_status = 'Lost' then null
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and lead_row.created_at < pg_catalog.timezone('Asia/Kolkata', date_trunc('day', pg_catalog.timezone('Asia/Kolkata', now()))) then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      from scoped_phone_leads lead_row
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
       and profile_row.active
       and profile_row.deleted_at is null
      order by lead_row.created_at desc, lead_row.id desc
      limit 100
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          case
            when history_row.in_scope then
              to_jsonb(history_row) - 'deleted_at' - 'connection_id' - 'external_lead_id' - 'in_scope'
                || jsonb_build_object('context_only', false)
            else jsonb_build_object(
              'id', history_row.id,
              'organization_id', history_row.organization_id,
              'customer_name', history_row.customer_name,
              'phone', history_row.phone,
              'normalized_phone', history_row.normalized_phone,
              'interested_model', history_row.interested_model,
              'source', history_row.source,
              'lifecycle_status', history_row.lifecycle_status,
              'lead_stage', history_row.lead_stage,
              'temperature', history_row.temperature,
              'assigned_user_id', history_row.assigned_user_id,
              'assigned_consultant_name', history_row.assigned_consultant_name,
              'created_at', history_row.created_at,
              'updated_at', history_row.updated_at,
              'read_only', true,
              'context_only', true
            )
          end
          order by history_row.created_at desc, history_row.id desc
        )
        from history_rows history_row
      ), '[]'::jsonb),
      'total', (select count(*) from scoped_phone_leads)
    )
  );
end;
$function$;

commit;
