begin;

-- Extend the existing audited appointment operations without duplicating their
-- authorization/idempotency logic. The replacements only widen the validated
-- type allowlist used by the list, create, and update functions.
do $$
declare
  signature regprocedure;
  definition text;
begin
  foreach signature in array array[
    'public.get_appointment_workspace_page(text,text,text,uuid,uuid,uuid,integer,integer,text,text)'::regprocedure,
    'public.create_appointment(uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'::regprocedure,
    'public.update_appointment(uuid,bigint,jsonb,uuid)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(signature) into definition;
    definition := replace(
      definition,
      '''Showroom Visit'', ''Test Drive''',
      '''Showroom Visit'', ''Video Call'', ''Test Drive'', ''Consultant Call'''
    );
    execute definition;
  end loop;
end;
$$;

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
  current_organization_id uuid;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names timezone_row where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'appointment.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  day_start := ((now() at time zone target_timezone)::date)::timestamp at time zone target_timezone;
  day_end := (((now() at time zone target_timezone)::date + 1))::timestamp at time zone target_timezone;
  select jsonb_build_object(
    'showroom_visit', count(*) filter (where appointment_row.appointment_type = 'Showroom Visit'),
    'video_call', count(*) filter (where appointment_row.appointment_type = 'Video Call'),
    'test_drive', count(*) filter (where appointment_row.appointment_type = 'Test Drive'),
    'consultant_call', count(*) filter (where appointment_row.appointment_type = 'Consultant Call')
  ) into result
  from public.appointments appointment_row
  where appointment_row.organization_id = current_organization_id
    and appointment_row.scheduled_at >= day_start
    and appointment_row.scheduled_at < day_end
    and app_private.can_access_record(
      appointment_row.organization_id,
      appointment_row.branch_id,
      appointment_row.team_id,
      appointment_row.assigned_user_id
    );
  return result;
end;
$$;

revoke all on function public.get_appointment_type_summary(text) from public, anon;
grant execute on function public.get_appointment_type_summary(text) to authenticated;

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
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  local_today date;
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
    select 1 from pg_catalog.pg_timezone_names timezone_row where timezone_row.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end if;
  if target_status not in (
    'all','today','upcoming','confirmed','arrived','completed','no-show','rescheduled','cancelled'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_FILTER';
  end if;
  if target_appointment_type not in (
    'all','Showroom Visit','Video Call','Test Drive','Consultant Call'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_APPOINTMENT_TYPE_FILTER';
  end if;
  local_today := (now() at time zone target_timezone)::date;
  if target_month < date_trunc('month', local_today)::date - interval '1 year'
    or target_month > date_trunc('month', local_today)::date + interval '2 years'
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
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'appointment.view')
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
  month_start := target_month::timestamp at time zone target_timezone;
  month_end := (target_month + interval '1 month')::timestamp at time zone target_timezone;
  day_start := local_today::timestamp at time zone target_timezone;
  day_end := (local_today + 1)::timestamp at time zone target_timezone;

  with accessible_records as materialized (
    select
      appointment_row.id,
      appointment_row.version,
      appointment_row.lead_id,
      appointment_row.customer_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      appointment_row.appointment_type,
      appointment_row.scheduled_at,
      appointment_row.status,
      coalesce(appointment_row.attendance_status, 'NOT_ARRIVED') as attendance_status,
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
      appointment_row.updated_at
    from public.appointments appointment_row
    join public.customers customer_row
      on customer_row.id = appointment_row.customer_id
     and customer_row.organization_id = appointment_row.organization_id
     and customer_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.id = appointment_row.lead_id
     and lead_row.organization_id = appointment_row.organization_id
     and lead_row.deleted_at is null
    join public.profiles assigned_profile
      on assigned_profile.id = appointment_row.assigned_user_id
     and assigned_profile.organization_id = appointment_row.organization_id
    left join public.profiles creator_profile
      on creator_profile.id = appointment_row.created_by
     and creator_profile.organization_id = appointment_row.organization_id
    join public.branches branch_row
      on branch_row.id = appointment_row.branch_id
     and branch_row.organization_id = appointment_row.organization_id
    left join public.teams team_row
      on team_row.id = appointment_row.team_id
     and team_row.organization_id = appointment_row.organization_id
    where appointment_row.organization_id = current_organization_id
      and app_private.can_access_record(
        appointment_row.organization_id,
        appointment_row.branch_id,
        appointment_row.team_id,
        appointment_row.assigned_user_id
      )
      and app_private.can_access_customer(appointment_row.organization_id, appointment_row.customer_id)
      and (appointment_row.lead_id is null or app_private.can_access_lead(appointment_row.lead_id))
  ), filtered_records as materialized (
    select record_row.*
    from accessible_records record_row
    where (target_branch_id is null or record_row.branch_id = target_branch_id)
      and (target_team_id is null or record_row.team_id = target_team_id)
      and (target_owner_id is null or record_row.assigned_user_id = target_owner_id)
      and (target_appointment_type = 'all' or record_row.appointment_type = target_appointment_type)
      and (
        normalized_search = ''
        or record_row.id = search_uuid
        or record_row.lead_id = search_uuid
        or lower(record_row.customer_name) ilike '%' || normalized_search || '%'
        or (search_phone_digits <> '' and app_private.normalize_phone_digits(record_row.phone) like search_phone_digits || '%')
      )
      and case target_status
        when 'today' then record_row.scheduled_at >= day_start and record_row.scheduled_at < day_end
        when 'upcoming' then record_row.scheduled_at >= day_end and record_row.status not in ('COMPLETED','CANCELLED','NO_SHOW')
        when 'confirmed' then record_row.status = 'CONFIRMED'
        when 'arrived' then record_row.attendance_status = 'ARRIVED'
        when 'completed' then record_row.status = 'COMPLETED'
        when 'no-show' then record_row.status = 'NO_SHOW' or record_row.attendance_status = 'NO_SHOW'
        when 'rescheduled' then record_row.status = 'RESCHEDULED'
        when 'cancelled' then record_row.status = 'CANCELLED'
        else true
      end
  ), month_records as materialized (
    select record_row.*, (record_row.scheduled_at at time zone target_timezone)::date as local_date
    from filtered_records record_row
    where record_row.scheduled_at >= month_start and record_row.scheduled_at < month_end
  ), ranked_records as (
    select record_row.*,
      row_number() over (partition by record_row.local_date order by record_row.scheduled_at, record_row.id) as day_rank,
      count(*) over (partition by record_row.local_date) as day_total
    from month_records record_row
  ), day_rows as (
    select record_row.local_date,
      max(record_row.day_total)::integer as total,
      jsonb_agg(to_jsonb(record_row) - 'local_date' - 'day_rank' - 'day_total'
        order by record_row.scheduled_at, record_row.id)
        filter (where target_day is not null or record_row.day_rank <= 3) as items
    from ranked_records record_row
    where target_day is null or record_row.local_date = target_day
    group by record_row.local_date
  )
  select jsonb_build_object(
    'month', target_month,
    'month_total', (select count(*) from month_records),
    'days', coalesce((select jsonb_agg(
      jsonb_build_object('date', day_row.local_date, 'total', day_row.total, 'items', day_row.items)
      order by day_row.local_date) from day_rows day_row), '[]'::jsonb),
    'timezone', target_timezone
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_appointment_calendar(
  date,date,text,text,text,uuid,uuid,uuid,text
) from public, anon;
grant execute on function public.get_appointment_calendar(
  date,date,text,text,text,uuid,uuid,uuid,text
) to authenticated;

commit;
