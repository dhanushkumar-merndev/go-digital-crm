begin;

-- Keep the established implementations as the authority for every role except
-- Sales Consultant.  Only the same-name public wrappers remain executable by
-- authenticated clients.
alter function public.get_followup_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) rename to get_followup_workspace_page_legacy;
revoke all on function public.get_followup_workspace_page_legacy(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon, authenticated;

alter function public.get_appointment_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) rename to get_appointment_workspace_page_legacy;
revoke all on function public.get_appointment_workspace_page_legacy(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon, authenticated;

alter function public.get_test_drive_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) rename to get_test_drive_workspace_page_legacy;
revoke all on function public.get_test_drive_workspace_page_legacy(
  text, text, text, date, date, integer, integer, text, text
) from public, anon, authenticated;

alter function public.get_task_workspace_page(
  text, text, text, integer, integer, text, text
) rename to get_task_workspace_page_legacy;
revoke all on function public.get_task_workspace_page_legacy(
  text, text, text, integer, integer, text, text
) from public, anon, authenticated;

alter function public.get_followup_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) rename to get_followup_calendar_legacy;
revoke all on function public.get_followup_calendar_legacy(
  date, date, text, text, text, uuid, uuid, uuid, text
) from public, anon, authenticated;

alter function public.get_appointment_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) rename to get_appointment_calendar_legacy;
revoke all on function public.get_appointment_calendar_legacy(
  date, date, text, text, text, uuid, uuid, uuid, text
) from public, anon, authenticated;

alter function public.get_appointment_type_summary(text)
  rename to get_appointment_type_summary_legacy;
revoke all on function public.get_appointment_type_summary_legacy(text)
  from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_followup_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_search text,
  target_status text,
  target_priority text,
  target_branch_id uuid,
  target_team_id uuid,
  target_owner_id uuid,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_timezone text
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
  if target_timezone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';

  return (
    with owned_followups as not materialized (
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
        and followup_row.assigned_user_id = target_user_id
        and followup_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
    ), scoped_followups as not materialized (
      select followup_row.*
      from owned_followups followup_row
      where (target_branch_id is null or followup_row.branch_id = target_branch_id)
        and (target_team_id is null or followup_row.team_id = target_team_id)
        and (target_owner_id is null or followup_row.assigned_user_id = target_owner_id)
        and (target_priority = 'all' or followup_row.priority = target_priority)
    ), searchable_followups as not materialized (
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
                or customer_row.normalized_phone like '+' || search_phone_digits || '%'
                or lead_row.normalized_phone like search_phone_digits || '%'
                or lead_row.normalized_phone like '+' || search_phone_digits || '%'
              )
            )
          )
        )
      )
      and case target_status
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
$$;

revoke all on function app_private.get_sales_consultant_followup_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, text, uuid, uuid, uuid,
  integer, integer, text, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_appointment_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_search text,
  target_status text,
  target_appointment_type text,
  target_branch_id uuid,
  target_team_id uuid,
  target_owner_id uuid,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_timezone text
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
  if target_timezone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
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
                or customer_row.normalized_phone like '+' || search_phone_digits || '%'
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
$$;

revoke all on function app_private.get_sales_consultant_appointment_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, text, uuid, uuid, uuid,
  integer, integer, text, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_task_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_search text,
  target_status text,
  target_priority text,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_timezone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
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
    raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
    or target_status is null
    or target_status not in (
      'ALL', 'OPEN', 'IN_PROGRESS', 'OVERDUE', 'TODAY', 'UPCOMING', 'COMPLETED', 'CANCELLED'
    )
    or target_priority is null
    or target_priority not in ('ALL', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
    or target_page is null
    or target_page not between 1 and 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('due:asc', 'due:desc', 'updated:desc', 'priority:desc', 'customer:asc')
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_QUERY';
  end if;
  begin
    perform query_now at time zone target_timezone;
  exception when invalid_parameter_value then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end;
  if target_timezone is null then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  return (
    with owned_tasks as not materialized (
      select
        task_row.id,
        task_row.organization_id,
        task_row.branch_id,
        task_row.team_id,
        task_row.lead_id,
        task_row.customer_id,
        task_row.assigned_user_id,
        task_row.title,
        task_row.description,
        task_row.priority,
        task_row.status,
        task_row.due_at,
        task_row.completed_at,
        task_row.completion_note,
        task_row.version,
        task_row.created_at,
        task_row.updated_at
      from public.tasks task_row
      where task_row.organization_id = target_organization_id
        and task_row.assigned_user_id = target_user_id
        and task_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
        and task_row.deleted_at is null
    ), authorized_tasks as not materialized (
      select
        task_row.*,
        case when target_customer_access then customer_row.normalized_name else null end
          as customer_sort
      from owned_tasks task_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = task_row.customer_id
       and customer_row.organization_id = target_organization_id
      where (target_priority = 'ALL' or task_row.priority = target_priority)
        and (
          target_status = 'ALL'
          or (
            target_status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
            and task_row.status = target_status
          )
          or (
            target_status = 'OVERDUE'
            and task_row.status in ('OPEN', 'IN_PROGRESS')
            and task_row.due_at < query_now
          )
          or (
            target_status = 'TODAY'
            and task_row.status in ('OPEN', 'IN_PROGRESS')
            and task_row.due_at >= day_start
            and task_row.due_at < day_end
          )
          or (
            target_status = 'UPCOMING'
            and task_row.status in ('OPEN', 'IN_PROGRESS')
            and task_row.due_at >= day_end
          )
        )
        and (
          normalized_search = ''
          or task_row.id = search_uuid
          or position(normalized_search in lower(task_row.title)) > 0
          or position(normalized_search in lower(coalesce(task_row.description, ''))) > 0
          or (
            target_customer_access
            and (
              customer_row.normalized_name ilike '%' || normalized_search || '%'
              or (
                search_phone_digits <> ''
                and customer_row.normalized_phone in (
                  search_phone_digits,
                  '+' || search_phone_digits
                )
              )
            )
          )
        )
    ), task_stats as materialized (
      select
        count(*)::bigint as total,
        count(*) filter (
          where status in ('OPEN', 'IN_PROGRESS') and due_at < query_now
        )::bigint as overdue,
        count(*) filter (
          where status in ('OPEN', 'IN_PROGRESS')
            and due_at >= day_start and due_at < day_end
        )::bigint as today,
        count(*) filter (
          where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_end
        )::bigint as upcoming,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= day_start and completed_at < day_end
        )::bigint as completed_today
      from authorized_tasks
    ), page_ids as materialized (
      select
        task_row.id,
        task_row.due_at,
        task_row.updated_at,
        task_row.priority,
        task_row.customer_sort
      from authorized_tasks task_row
      order by
        case when target_sort = 'due:asc' then task_row.due_at end asc nulls last,
        case when target_sort = 'due:desc' then task_row.due_at end desc nulls last,
        case when target_sort = 'updated:desc' then task_row.updated_at end desc,
        case when target_sort = 'priority:desc' then case task_row.priority
          when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
        end desc,
        case when target_sort = 'customer:asc' then task_row.customer_sort end asc,
        task_row.id asc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        task_row.id,
        task_row.organization_id,
        task_row.branch_id,
        task_row.team_id,
        task_row.lead_id,
        task_row.customer_id,
        task_row.assigned_user_id,
        task_row.title,
        task_row.description,
        task_row.priority,
        task_row.status,
        task_row.due_at,
        task_row.completed_at,
        task_row.completion_note,
        task_row.version,
        task_row.created_at,
        task_row.updated_at,
        branch_row.name as branch_name,
        team_row.name as team_name,
        assignee_row.full_name as assigned_user_name,
        case when target_customer_access then customer_row.full_name else null end
          as customer_name,
        case when target_customer_access then customer_row.primary_phone else null end
          as phone,
        lead_row.interested_model,
        page_id.customer_sort
      from page_ids page_id
      join owned_tasks task_row on task_row.id = page_id.id
      join public.branches branch_row
        on branch_row.id = task_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = task_row.team_id
       and team_row.organization_id = target_organization_id
      left join public.profiles assignee_row
        on assignee_row.id = task_row.assigned_user_id
       and assignee_row.organization_id = target_organization_id
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = task_row.customer_id
       and customer_row.organization_id = target_organization_id
      left join public.leads lead_row
        on lead_row.id = task_row.lead_id
       and lead_row.organization_id = target_organization_id
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'organization_id', page_row.organization_id,
            'branch_id', page_row.branch_id,
            'team_id', page_row.team_id,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'assigned_user_id', page_row.assigned_user_id,
            'title', page_row.title,
            'description', page_row.description,
            'priority', page_row.priority,
            'status', page_row.status,
            'due_at', page_row.due_at,
            'completed_at', page_row.completed_at,
            'completion_note', page_row.completion_note,
            'version', page_row.version,
            'created_at', page_row.created_at,
            'updated_at', page_row.updated_at,
            'branch_name', page_row.branch_name,
            'team_name', page_row.team_name,
            'assigned_user_name', page_row.assigned_user_name,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'interested_model', page_row.interested_model
          ) order by
            case when target_sort = 'due:asc' then page_row.due_at end asc nulls last,
            case when target_sort = 'due:desc' then page_row.due_at end desc nulls last,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'priority:desc' then case page_row.priority
              when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
            end desc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            page_row.id asc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from task_stats),
      'kpis', jsonb_build_object(
        'overdue', (select overdue from task_stats),
        'today', (select today from task_stats),
        'upcoming', (select upcoming from task_stats),
        'completed_today', (select completed_today from task_stats)
      )
    )
  );
end;
$$;

revoke all on function app_private.get_sales_consultant_task_workspace_page(
  uuid, uuid, uuid[], boolean, text, text, text, integer, integer, text, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_test_drive_workspace_page(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_quotation_access boolean,
  target_view text,
  target_search text,
  target_model text,
  target_from_date date,
  target_to_date date,
  target_page integer,
  target_page_size integer,
  target_sort text,
  target_timezone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_model text := lower(btrim(coalesce(target_model, '')));
  search_phone_digits text;
  search_uuid uuid;
  query_now timestamptz := now();
  day_start timestamptz;
  day_end timestamptz;
  month_start timestamptz;
  month_end timestamptz;
  from_at timestamptz;
  to_exclusive_at timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or target_user_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'TEST_DRIVE_VIEW_PERMISSION_REQUIRED';
  end if;
  if upper(coalesce(target_view, '')) not in ('TODAY', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')
    or char_length(normalized_search) > 160
    or char_length(normalized_model) > 120
    or target_page is null
    or target_page not between 1 and 1000000
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('scheduled:asc', 'scheduled:desc', 'updated:desc', 'customer:asc')
    or target_timezone is null
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or (
      target_from_date is not null
      and target_to_date is not null
      and target_from_date > target_to_date
    )
    or (
      target_from_date is not null
      and target_to_date is not null
      and target_to_date > target_from_date + 366
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  day_start := date_trunc('day', query_now at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  month_start := date_trunc('month', query_now at time zone target_timezone)
    at time zone target_timezone;
  month_end := month_start + interval '1 month';
  if target_from_date is not null then
    from_at := target_from_date::timestamp at time zone target_timezone;
  end if;
  if target_to_date is not null then
    to_exclusive_at := (target_to_date + 1)::timestamp at time zone target_timezone;
  end if;

  return (
    with owned_drives as not materialized (
      select
        drive_row.id,
        drive_row.organization_id,
        drive_row.appointment_id,
        drive_row.customer_id,
        drive_row.lead_id,
        drive_row.branch_id,
        drive_row.team_id,
        drive_row.assigned_user_id,
        drive_row.status,
        drive_row.version,
        drive_row.started_at,
        drive_row.reached_at,
        drive_row.completed_at,
        drive_row.start_odometer,
        drive_row.end_odometer,
        drive_row.distance_meters,
        drive_row.duration_seconds,
        drive_row.start_anchor,
        drive_row.reached_anchor,
        drive_row.end_anchor,
        drive_row.route_finalized_at,
        drive_row.cancelled_at,
        drive_row.cancellation_reason,
        drive_row.created_at,
        drive_row.updated_at,
        appointment_row.scheduled_at,
        appointment_row.expected_duration_minutes,
        appointment_row.stock_unit_id,
        appointment_row.vehicle_registration,
        appointment_row.start_location,
        appointment_row.destination
      from public.test_drives drive_row
      join public.test_drive_appointments appointment_row
        on appointment_row.id = drive_row.appointment_id
       and appointment_row.organization_id = target_organization_id
       and appointment_row.assigned_user_id = target_user_id
       and appointment_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      where drive_row.organization_id = target_organization_id
        and drive_row.assigned_user_id = target_user_id
        and drive_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
        and (from_at is null or appointment_row.scheduled_at >= from_at)
        and (to_exclusive_at is null or appointment_row.scheduled_at < to_exclusive_at)
    ), eligible_drives as not materialized (
      select
        drive_row.*,
        case when target_customer_access then customer_row.normalized_name else null end
          as customer_sort
      from owned_drives drive_row
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = drive_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      left join public.stock_units stock_row
        on stock_row.id = drive_row.stock_unit_id
       and stock_row.organization_id = target_organization_id
      left join public.vehicle_variants variant_row
        on variant_row.id = stock_row.variant_id
       and variant_row.organization_id = target_organization_id
      left join public.vehicle_models model_row
        on model_row.id = variant_row.model_id
       and model_row.organization_id = target_organization_id
      left join public.vehicle_brands brand_row
        on brand_row.id = model_row.brand_id
       and brand_row.organization_id = target_organization_id
      where (
        normalized_model = ''
        or position(normalized_model in lower(coalesce(brand_row.name, ''))) > 0
        or position(normalized_model in lower(coalesce(model_row.name, ''))) > 0
        or position(normalized_model in lower(coalesce(variant_row.name, ''))) > 0
      )
      and (
        normalized_search = ''
        or drive_row.id = search_uuid
        or position(normalized_search in lower(coalesce(stock_row.vin, ''))) > 0
        or position(
          normalized_search in lower(coalesce(drive_row.vehicle_registration, ''))
        ) > 0
        or (
          target_customer_access
          and (
            customer_row.normalized_name ilike '%' || normalized_search || '%'
            or (
              search_phone_digits <> ''
              and customer_row.normalized_phone in (
                search_phone_digits,
                '+' || search_phone_digits
              )
            )
          )
        )
      )
    ), latest_quotations as materialized (
      select distinct on (drive_row.id)
        drive_row.id as test_drive_id,
        quotation_row.status as quotation_status
      from eligible_drives drive_row
      join public.quotations quotation_row
        on target_quotation_access
       and quotation_row.organization_id = target_organization_id
       and quotation_row.lead_id = drive_row.lead_id
       and quotation_row.assigned_user_id = target_user_id
       and quotation_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
       and quotation_row.created_at >= coalesce(drive_row.completed_at, drive_row.created_at)
      order by drive_row.id, quotation_row.created_at desc, quotation_row.id desc
    ), authorized_drives as not materialized (
      select
        drive_row.*,
        quotation_row.quotation_status,
        case
          when drive_row.status = 'READY' and drive_row.scheduled_at < day_start then 'OVERDUE'
          when drive_row.status = 'READY' and drive_row.scheduled_at < day_end then 'TODAY'
          when drive_row.status = 'READY' then 'UPCOMING'
          else drive_row.status
        end as schedule_state
      from eligible_drives drive_row
      left join latest_quotations quotation_row
        on quotation_row.test_drive_id = drive_row.id
    ), filtered_drives as not materialized (
      select drive_row.*
      from authorized_drives drive_row
      where case upper(target_view)
        when 'TODAY' then drive_row.status = 'READY' and drive_row.scheduled_at < day_end
        when 'UPCOMING' then drive_row.status = 'READY' and drive_row.scheduled_at >= day_end
        when 'ACTIVE' then drive_row.status = 'ACTIVE'
        when 'COMPLETED' then drive_row.status = 'COMPLETED'
        when 'CANCELLED' then drive_row.status = 'CANCELLED'
        else false
      end
    ), test_drive_authorized_stats as materialized (
      select
        count(*) filter (
          where status = 'READY' and scheduled_at >= day_start and scheduled_at < day_end
        )::bigint as today,
        count(*) filter (
          where status = 'READY' and scheduled_at < day_start
        )::bigint as overdue,
        count(*) filter (
          where status = 'READY' and scheduled_at >= day_end
        )::bigint as upcoming,
        count(*) filter (where status = 'ACTIVE')::bigint as active,
        count(*) filter (
          where status = 'COMPLETED'
            and completed_at >= month_start and completed_at < month_end
        )::bigint as completed_this_month,
        count(*) filter (where status = 'CANCELLED')::bigint as cancelled,
        count(*) filter (
          where status = 'COMPLETED' and quotation_status is not null
        )::bigint as converted
      from authorized_drives
    ), test_drive_filtered_stats as materialized (
      select count(*)::bigint as total from filtered_drives
    ), page_ids as materialized (
      select
        drive_row.id,
        drive_row.scheduled_at,
        drive_row.updated_at,
        drive_row.customer_sort
      from filtered_drives drive_row
      order by
        case when target_sort = 'scheduled:asc' then drive_row.scheduled_at end asc,
        case when target_sort = 'scheduled:desc' then drive_row.scheduled_at end desc,
        case when target_sort = 'updated:desc' then drive_row.updated_at end desc,
        case when target_sort = 'customer:asc' then drive_row.customer_sort end asc,
        drive_row.id desc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        drive_row.id,
        drive_row.organization_id,
        drive_row.appointment_id,
        drive_row.customer_id,
        drive_row.lead_id,
        drive_row.branch_id,
        drive_row.team_id,
        drive_row.assigned_user_id,
        drive_row.status,
        drive_row.version,
        drive_row.scheduled_at,
        drive_row.expected_duration_minutes,
        drive_row.stock_unit_id,
        drive_row.vehicle_registration,
        drive_row.start_location,
        drive_row.destination,
        case when target_customer_access then
          coalesce(customer_row.full_name, 'Restricted')
        else 'Restricted' end
          as customer_name,
        case when target_customer_access then customer_row.primary_phone else null end
          as phone,
        branch_row.name as branch_name,
        team_row.name as team_name,
        profile_row.full_name as assigned_user_name,
        brand_row.name as brand_name,
        model_row.name as model_name,
        variant_row.name as variant_name,
        stock_row.vin,
        stock_row.chassis_number,
        stock_row.color,
        drive_row.started_at,
        drive_row.reached_at,
        drive_row.completed_at,
        drive_row.start_odometer,
        drive_row.end_odometer,
        drive_row.distance_meters,
        drive_row.duration_seconds,
        drive_row.start_anchor,
        drive_row.reached_anchor,
        drive_row.end_anchor,
        drive_row.route_finalized_at,
        summary_row.id as route_summary_id,
        summary_row.point_count,
        feedback_row.id as feedback_id,
        feedback_row.overall_rating,
        feedback_row.purchase_intent,
        drive_row.cancelled_at,
        drive_row.cancellation_reason,
        drive_row.updated_at,
        case
          when drive_row.status = 'ACTIVE' then 'ANCHORS_ONLY_ACTIVE'
          when drive_row.status = 'COMPLETED' and summary_row.id is null
            then 'ROUTE_UPLOAD_PENDING'
          when summary_row.id is not null then 'ROUTE_FINALIZED'
          else 'NOT_STARTED'
        end as gps_status,
        drive_row.quotation_status,
        drive_row.schedule_state,
        page_id.customer_sort
      from page_ids page_id
      join authorized_drives drive_row on drive_row.id = page_id.id
      left join public.customers customer_row
        on target_customer_access
       and customer_row.id = drive_row.customer_id
       and customer_row.organization_id = target_organization_id
       and customer_row.deleted_at is null
      join public.branches branch_row
        on branch_row.id = drive_row.branch_id
       and branch_row.organization_id = target_organization_id
      left join public.teams team_row
        on team_row.id = drive_row.team_id
       and team_row.organization_id = target_organization_id
      join public.profiles profile_row
        on profile_row.id = drive_row.assigned_user_id
       and profile_row.organization_id = target_organization_id
      left join public.stock_units stock_row
        on stock_row.id = drive_row.stock_unit_id
       and stock_row.organization_id = target_organization_id
      left join public.vehicle_variants variant_row
        on variant_row.id = stock_row.variant_id
       and variant_row.organization_id = target_organization_id
      left join public.vehicle_models model_row
        on model_row.id = variant_row.model_id
       and model_row.organization_id = target_organization_id
      left join public.vehicle_brands brand_row
        on brand_row.id = model_row.brand_id
       and brand_row.organization_id = target_organization_id
      left join public.test_drive_route_summaries summary_row
        on summary_row.test_drive_id = drive_row.id
       and summary_row.organization_id = target_organization_id
      left join public.test_drive_feedback feedback_row
        on feedback_row.test_drive_id = drive_row.id
       and feedback_row.organization_id = target_organization_id
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'organization_id', page_row.organization_id,
            'appointment_id', page_row.appointment_id,
            'customer_id', page_row.customer_id,
            'lead_id', page_row.lead_id,
            'branch_id', page_row.branch_id,
            'team_id', page_row.team_id,
            'assigned_user_id', page_row.assigned_user_id,
            'status', page_row.status,
            'version', page_row.version,
            'scheduled_at', page_row.scheduled_at,
            'expected_duration_minutes', page_row.expected_duration_minutes,
            'stock_unit_id', page_row.stock_unit_id,
            'vehicle_registration', page_row.vehicle_registration,
            'start_location', page_row.start_location,
            'destination', page_row.destination,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'branch_name', page_row.branch_name,
            'team_name', page_row.team_name,
            'assigned_user_name', page_row.assigned_user_name,
            'brand_name', page_row.brand_name,
            'model_name', page_row.model_name,
            'variant_name', page_row.variant_name,
            'vin', page_row.vin,
            'chassis_number', page_row.chassis_number,
            'color', page_row.color,
            'started_at', page_row.started_at,
            'reached_at', page_row.reached_at,
            'completed_at', page_row.completed_at,
            'start_odometer', page_row.start_odometer,
            'end_odometer', page_row.end_odometer,
            'distance_meters', page_row.distance_meters,
            'duration_seconds', page_row.duration_seconds,
            'start_anchor', page_row.start_anchor,
            'reached_anchor', page_row.reached_anchor,
            'end_anchor', page_row.end_anchor,
            'route_finalized_at', page_row.route_finalized_at,
            'route_summary_id', page_row.route_summary_id,
            'point_count', page_row.point_count,
            'feedback_id', page_row.feedback_id,
            'overall_rating', page_row.overall_rating,
            'purchase_intent', page_row.purchase_intent,
            'cancelled_at', page_row.cancelled_at,
            'cancellation_reason', page_row.cancellation_reason,
            'updated_at', page_row.updated_at,
            'gps_status', page_row.gps_status,
            'quotation_status', page_row.quotation_status,
            'schedule_state', page_row.schedule_state
          ) order by
            case when target_sort = 'scheduled:asc' then page_row.scheduled_at end asc,
            case when target_sort = 'scheduled:desc' then page_row.scheduled_at end desc,
            case when target_sort = 'updated:desc' then page_row.updated_at end desc,
            case when target_sort = 'customer:asc' then page_row.customer_sort end asc,
            page_row.id desc
        )
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select total from test_drive_filtered_stats),
      'organization_id', target_organization_id,
      'timezone', target_timezone,
      'kpis', jsonb_build_object(
        'today', (select today from test_drive_authorized_stats),
        'overdue', (select overdue from test_drive_authorized_stats),
        'upcoming', (select upcoming from test_drive_authorized_stats),
        'active', (select active from test_drive_authorized_stats),
        'completed_this_month', (
          select completed_this_month from test_drive_authorized_stats
        ),
        'cancelled', (select cancelled from test_drive_authorized_stats),
        'converted', (select converted from test_drive_authorized_stats)
      )
    )
  );
end;
$$;

revoke all on function app_private.get_sales_consultant_test_drive_workspace_page(
  uuid, uuid, uuid[], boolean, boolean, text, text, text, date, date,
  integer, integer, text, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_followup_calendar(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_month date,
  target_day date,
  target_search text,
  target_status text,
  target_priority text,
  target_branch_id uuid,
  target_team_id uuid,
  target_owner_id uuid,
  target_timezone text
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
  if target_timezone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
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
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  month_start := target_month::timestamp at time zone target_timezone;
  month_end := (target_month + interval '1 month')::timestamp at time zone target_timezone;
  day_start := local_today::timestamp at time zone target_timezone;
  day_end := (local_today + 1)::timestamp at time zone target_timezone;

  return (
    with owned_followups as not materialized (
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
        and followup_row.assigned_user_id = target_user_id
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
                  or customer_row.normalized_phone like '+' || search_phone_digits || '%'
                  or lead_row.normalized_phone like search_phone_digits || '%'
                  or lead_row.normalized_phone like '+' || search_phone_digits || '%'
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
$$;

revoke all on function app_private.get_sales_consultant_followup_calendar(
  uuid, uuid, uuid[], boolean, date, date, text, text, text,
  uuid, uuid, uuid, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_appointment_calendar(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_customer_access boolean,
  target_month date,
  target_day date,
  target_search text,
  target_status text,
  target_appointment_type text,
  target_branch_id uuid,
  target_team_id uuid,
  target_owner_id uuid,
  target_timezone text
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
  if target_timezone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  if target_status is null or target_status not in (
    'all', 'today', 'upcoming', 'confirmed', 'arrived', 'completed',
    'no-show', 'rescheduled', 'cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type is null or target_appointment_type not in (
    'all', 'Showroom Visit', 'Video Call', 'Test Drive', 'Consultant Call'
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
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
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
                  or customer_row.normalized_phone like '+' || search_phone_digits || '%'
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
$$;

revoke all on function app_private.get_sales_consultant_appointment_calendar(
  uuid, uuid, uuid[], boolean, date, date, text, text, text,
  uuid, uuid, uuid, text
) from public, anon, authenticated;

create or replace function app_private.get_sales_consultant_appointment_type_summary(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_timezone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
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
  if target_timezone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  day_start := ((query_now at time zone target_timezone)::date)::timestamp
    at time zone target_timezone;
  day_end := (((query_now at time zone target_timezone)::date + 1))::timestamp
    at time zone target_timezone;

  return (
    select jsonb_build_object(
      'showroom_visit', count(*) filter (
        where appointment_row.appointment_type = 'Showroom Visit'
      ),
      'video_call', count(*) filter (
        where appointment_row.appointment_type = 'Video Call'
      ),
      'test_drive', count(*) filter (
        where appointment_row.appointment_type = 'Test Drive'
      ),
      'consultant_call', count(*) filter (
        where appointment_row.appointment_type = 'Consultant Call'
      )
    )
    from public.appointments appointment_row
    where appointment_row.organization_id = target_organization_id
      and appointment_row.assigned_user_id = target_user_id
      and appointment_row.branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))
      and appointment_row.scheduled_at >= day_start
      and appointment_row.scheduled_at < day_end
  );
end;
$$;

revoke all on function app_private.get_sales_consultant_appointment_type_summary(
  uuid, uuid, uuid[], text
) from public, anon, authenticated;

create or replace function public.get_followup_workspace_page(
  target_search text default '',
  target_status text default 'all',
  target_priority text default 'all',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null,
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'scheduled:asc',
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('followup.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null
      and not app_private.can_access_team(current_organization_id, target_team_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;

    return app_private.get_sales_consultant_followup_workspace_page(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_search,
      target_status,
      target_priority,
      target_branch_id,
      target_team_id,
      target_owner_id,
      target_page,
      target_page_size,
      target_sort,
      target_timezone
    );
  end if;

  return public.get_followup_workspace_page_legacy(
    target_search,
    target_status,
    target_priority,
    target_branch_id,
    target_team_id,
    target_owner_id,
    target_page,
    target_page_size,
    target_sort,
    target_timezone
  );
end;
$$;

revoke all on function public.get_followup_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon;
grant execute on function public.get_followup_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) to authenticated;

create or replace function public.get_appointment_workspace_page(
  target_search text default '',
  target_status text default 'all',
  target_appointment_type text default 'all',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null,
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'scheduled:asc',
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('appointment.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null
      and not app_private.can_access_team(current_organization_id, target_team_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;

    return app_private.get_sales_consultant_appointment_workspace_page(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_search,
      target_status,
      target_appointment_type,
      target_branch_id,
      target_team_id,
      target_owner_id,
      target_page,
      target_page_size,
      target_sort,
      target_timezone
    );
  end if;

  return public.get_appointment_workspace_page_legacy(
    target_search,
    target_status,
    target_appointment_type,
    target_branch_id,
    target_team_id,
    target_owner_id,
    target_page,
    target_page_size,
    target_sort,
    target_timezone
  );
end;
$$;

revoke all on function public.get_appointment_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) from public, anon;
grant execute on function public.get_appointment_workspace_page(
  text, text, text, uuid, uuid, uuid, integer, integer, text, text
) to authenticated;

create or replace function public.get_task_workspace_page(
  target_search text default '',
  target_status text default 'ALL',
  target_priority text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'due:asc',
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('task.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );

    return app_private.get_sales_consultant_task_workspace_page(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_search,
      target_status,
      target_priority,
      target_page,
      target_page_size,
      target_sort,
      target_timezone
    );
  end if;

  return public.get_task_workspace_page_legacy(
    target_search,
    target_status,
    target_priority,
    target_page,
    target_page_size,
    target_sort,
    target_timezone
  );
end;
$$;

revoke all on function public.get_task_workspace_page(
  text, text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.get_task_workspace_page(
  text, text, text, integer, integer, text, text
) to authenticated;

create or replace function public.get_test_drive_workspace_page(
  target_view text default 'TODAY',
  target_search text default '',
  target_model text default '',
  target_from_date date default null,
  target_to_date date default null,
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'scheduled:asc',
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
  quotation_access boolean;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'TEST_DRIVE_VIEW_PERMISSION_REQUIRED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'TEST_DRIVE_VIEW_PERMISSION_REQUIRED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not (
      'test_drive.view' = any(permission_keys)
      or 'test_drive.manage' = any(permission_keys)
    ) then
      raise exception using errcode = '42501', message = 'TEST_DRIVE_VIEW_PERMISSION_REQUIRED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    quotation_access :=
      'quotation.view' = any(permission_keys)
      or 'quotation.manage' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );

    return app_private.get_sales_consultant_test_drive_workspace_page(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      quotation_access,
      target_view,
      target_search,
      target_model,
      target_from_date,
      target_to_date,
      target_page,
      target_page_size,
      target_sort,
      target_timezone
    );
  end if;

  return public.get_test_drive_workspace_page_legacy(
    target_view,
    target_search,
    target_model,
    target_from_date,
    target_to_date,
    target_page,
    target_page_size,
    target_sort,
    target_timezone
  );
end;
$$;

revoke all on function public.get_test_drive_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) from public, anon;
grant execute on function public.get_test_drive_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) to authenticated;

create or replace function public.get_followup_calendar(
  target_month date,
  target_day date default null,
  target_search text default '',
  target_status text default 'all',
  target_priority text default 'all',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null,
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('followup.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null
      and not app_private.can_access_team(current_organization_id, target_team_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;

    return app_private.get_sales_consultant_followup_calendar(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_month,
      target_day,
      target_search,
      target_status,
      target_priority,
      target_branch_id,
      target_team_id,
      target_owner_id,
      target_timezone
    );
  end if;

  return public.get_followup_calendar_legacy(
    target_month,
    target_day,
    target_search,
    target_status,
    target_priority,
    target_branch_id,
    target_team_id,
    target_owner_id,
    target_timezone
  );
end;
$$;

revoke all on function public.get_followup_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) from public, anon;
grant execute on function public.get_followup_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) to authenticated;

create or replace function public.get_appointment_calendar(
  target_month date,
  target_day date default null,
  target_search text default '',
  target_status text default 'all',
  target_appointment_type text default 'all',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null,
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('appointment.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    if target_branch_id is not null
      and not (target_branch_id = any(allowed_branch_ids))
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
    if target_team_id is not null
      and not app_private.can_access_team(current_organization_id, target_team_id)
    then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;

    return app_private.get_sales_consultant_appointment_calendar(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      customer_access,
      target_month,
      target_day,
      target_search,
      target_status,
      target_appointment_type,
      target_branch_id,
      target_team_id,
      target_owner_id,
      target_timezone
    );
  end if;

  return public.get_appointment_calendar_legacy(
    target_month,
    target_day,
    target_search,
    target_status,
    target_appointment_type,
    target_branch_id,
    target_team_id,
    target_owner_id,
    target_timezone
  );
end;
$$;

revoke all on function public.get_appointment_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) from public, anon;
grant execute on function public.get_appointment_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) to authenticated;

create or replace function public.get_appointment_type_summary(
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
  current_user_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
begin
  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' is distinct from 'CRM'
      or access_context->>'organization_id' is null
      or access_context->>'user_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    current_user_id := (access_context->>'user_id')::uuid;
    if current_user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;

    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('appointment.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_appointment_type_summary(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      target_timezone
    );
  end if;

  return public.get_appointment_type_summary_legacy(target_timezone);
end;
$$;

revoke all on function public.get_appointment_type_summary(text) from public, anon;
grant execute on function public.get_appointment_type_summary(text) to authenticated;

commit;
