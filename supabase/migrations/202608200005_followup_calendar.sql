-- Month-scoped follow-up calendar for the operational Follow-ups workspace.
-- The month response returns at most three records per day; requesting a
-- specific day returns that day's complete authorized list for the side sheet.

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
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  local_today date;
  current_month date;
  next_month date;
  month_start timestamptz;
  month_end timestamptz;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  if target_status not in ('all', 'overdue', 'today', 'upcoming', 'completed', 'cancelled') then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_FILTER';
  end if;
  if target_priority not in ('all', 'LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception using errcode = '22023', message = 'INVALID_FOLLOWUP_PRIORITY_FILTER';
  end if;

  local_today := (now() at time zone target_timezone)::date;
  current_month := date_trunc('month', local_today)::date;
  next_month := (current_month + interval '1 month')::date;
  if target_month not in (current_month, next_month) then
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

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'followup.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if target_team_id is not null
    and not app_private.can_access_team(current_organization_id, target_team_id)
  then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  with accessible_records as materialized (
    select
      followup_row.id,
      followup_row.version,
      followup_row.lead_id,
      followup_row.customer_id,
      coalesce(customer_row.full_name, lead_row.customer_name, 'Unlinked customer') as customer_name,
      coalesce(customer_row.primary_phone, lead_row.phone) as phone,
      lead_row.interested_model,
      followup_row.reason,
      followup_row.priority,
      followup_row.due_at,
      case
        when followup_row.status = 'OPEN' and followup_row.due_at < now() then 'OVERDUE'
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
    join public.branches branch_row
      on branch_row.id = followup_row.branch_id
     and branch_row.organization_id = followup_row.organization_id
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
    where followup_row.organization_id = current_organization_id
      and app_private.can_access_record(
        followup_row.organization_id,
        followup_row.branch_id,
        followup_row.team_id,
        followup_row.assigned_user_id
      )
      and (followup_row.lead_id is null or app_private.can_access_lead(followup_row.lead_id))
      and (
        followup_row.customer_id is null
        or (
          app_private.has_permission(followup_row.organization_id, 'customer.view')
          and app_private.can_access_customer(
            followup_row.organization_id,
            followup_row.customer_id
          )
        )
      )
  ), scope_filtered as materialized (
    select record_row.*
    from accessible_records record_row
    where (target_branch_id is null or record_row.branch_id = target_branch_id)
      and (target_team_id is null or record_row.team_id = target_team_id)
      and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
      and (target_priority = 'all' or record_row.priority = target_priority)
      and (
        normalized_search = ''
        or record_row.id = search_uuid
        or record_row.lead_id = search_uuid
        or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(record_row.phone) like search_phone_digits || '%'
        )
      )
  ), status_filtered as materialized (
    select record_row.*
    from scope_filtered record_row
    where case target_status
      when 'overdue' then record_row.status = 'OPEN' and record_row.due_at < now()
      when 'today' then record_row.status = 'OPEN'
        and record_row.due_at >= day_start and record_row.due_at < day_end
      when 'upcoming' then record_row.status = 'OPEN' and record_row.due_at >= day_end
      when 'completed' then record_row.status = 'COMPLETED'
      when 'cancelled' then record_row.status = 'CANCELLED'
      else true
    end
  ), month_records as materialized (
    select
      record_row.*,
      (record_row.due_at at time zone target_timezone)::date as local_date
    from status_filtered record_row
    where record_row.due_at >= month_start and record_row.due_at < month_end
  ), ranked_records as (
    select
      record_row.*,
      row_number() over (
        partition by record_row.local_date order by record_row.due_at, record_row.id
      ) as day_rank,
      count(*) over (partition by record_row.local_date) as day_total
    from month_records record_row
  ), day_rows as (
    select
      record_row.local_date,
      max(record_row.day_total)::integer as total,
      jsonb_agg(
        to_jsonb(record_row) - 'local_date' - 'day_rank' - 'day_total'
        order by record_row.due_at, record_row.id
      ) filter (where target_day is not null or record_row.day_rank <= 3) as items
    from ranked_records record_row
    where target_day is null or record_row.local_date = target_day
    group by record_row.local_date
  )
  select jsonb_build_object(
    'month', target_month,
    'month_total', (select count(*) from month_records),
    'status_counts', jsonb_build_object(
      'all', (select count(*) from scope_filtered),
      'overdue', (select count(*) from scope_filtered where status = 'OPEN' and due_at < now()),
      'today', (
        select count(*) from scope_filtered
        where status = 'OPEN' and due_at >= day_start and due_at < day_end
      ),
      'upcoming', (select count(*) from scope_filtered where status = 'OPEN' and due_at >= day_end),
      'completed', (select count(*) from scope_filtered where status = 'COMPLETED'),
      'cancelled', (select count(*) from scope_filtered where status = 'CANCELLED')
    ),
    'days', coalesce((
      select jsonb_agg(
        jsonb_build_object('date', day_row.local_date, 'total', day_row.total, 'items', day_row.items)
        order by day_row.local_date
      )
      from day_rows day_row
    ), '[]'::jsonb),
    'timezone', target_timezone
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_followup_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) from public, anon;
grant execute on function public.get_followup_calendar(
  date, date, text, text, text, uuid, uuid, uuid, text
) to authenticated;

