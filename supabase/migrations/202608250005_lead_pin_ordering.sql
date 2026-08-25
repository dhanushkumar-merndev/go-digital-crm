begin;

-- Pinning must survive pagination: a pinned lead has to reach page one even when
-- the active sort would bury it on page 40. Ordering therefore moves into the
-- workspace page RPC, and a pin timestamp records the pin order so the most
-- recently pinned lead outranks earlier pins.
alter table public.user_lead_preferences
  add column if not exists pinned_at timestamptz;

update public.user_lead_preferences
set pinned_at = updated_at
where pinned and pinned_at is null;

do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_lead_preferences_pinned_at_present'
      and conrelid = 'public.user_lead_preferences'::regclass
  ) then
    alter table public.user_lead_preferences
      add constraint user_lead_preferences_pinned_at_present
      check (pinned = (pinned_at is not null)) not valid;
  end if;
end
$constraint$;

-- The page RPC reads this per request, so keep it a covering, pins-only index.
create index if not exists user_lead_preferences_pinned_rank_idx
  on public.user_lead_preferences (organization_id, user_id, pinned_at desc)
  include (lead_id)
  where pinned;

-- Adding a column to a `returns table` signature needs a drop; `create or
-- replace` refuses to change an existing function's return type.
drop function if exists public.get_my_lead_preferences();

create function public.get_my_lead_preferences()
returns table (lead_id uuid, pinned boolean, starred boolean, pinned_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM' or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'LEAD_PREFERENCE_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  return query
  select
    preference_row.lead_id,
    preference_row.pinned,
    preference_row.starred,
    preference_row.pinned_at
  from public.user_lead_preferences preference_row
  where preference_row.organization_id = current_organization_id
    and preference_row.user_id = auth.uid()
    and app_private.can_access_lead(preference_row.lead_id)
  order by preference_row.pinned_at desc nulls last, preference_row.updated_at desc;
end;
$$;

drop function if exists public.set_my_lead_preference(uuid, boolean, boolean);

create function public.set_my_lead_preference(
  target_lead_id uuid,
  target_pinned boolean,
  target_starred boolean
)
returns table (lead_id uuid, pinned boolean, starred boolean, pinned_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  existing_pinned_at timestamptz;
  next_pinned_at timestamptz;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM' or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'LEAD_PREFERENCE_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  if not exists (
    select 1
    from public.leads lead_row
    where lead_row.id = target_lead_id
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and app_private.can_access_lead(lead_row.id)
  ) then
    raise exception using errcode = '42501', message = 'LEAD_PREFERENCE_SCOPE_DENIED';
  end if;

  if not target_pinned and not target_starred then
    delete from public.user_lead_preferences preference_row
    where preference_row.organization_id = current_organization_id
      and preference_row.user_id = auth.uid()
      and preference_row.lead_id = target_lead_id;

    return query select target_lead_id, false, false, null::timestamptz;
    return;
  end if;

  select preference_row.pinned_at into existing_pinned_at
  from public.user_lead_preferences preference_row
  where preference_row.organization_id = current_organization_id
    and preference_row.user_id = auth.uid()
    and preference_row.lead_id = target_lead_id
    and preference_row.pinned;

  -- A fresh pin stamps now() and jumps to the top; toggling the star on an
  -- already pinned lead must not reshuffle it, so the stamp is preserved.
  if target_pinned then
    next_pinned_at := coalesce(existing_pinned_at, now());
  else
    next_pinned_at := null;
  end if;

  insert into public.user_lead_preferences (
    organization_id, user_id, lead_id, pinned, starred, pinned_at, updated_at
  )
  values (
    current_organization_id, auth.uid(), target_lead_id,
    target_pinned, target_starred, next_pinned_at, now()
  )
  on conflict (organization_id, user_id, lead_id) do update
    set pinned = excluded.pinned,
        starred = excluded.starred,
        pinned_at = excluded.pinned_at,
        updated_at = excluded.updated_at;

  return query select target_lead_id, target_pinned, target_starred, next_pinned_at;
end;
$$;

revoke all on function public.get_my_lead_preferences() from public, anon;
grant execute on function public.get_my_lead_preferences() to authenticated;
revoke all on function public.set_my_lead_preference(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_my_lead_preference(uuid, boolean, boolean) to authenticated;

create or replace function app_private.get_sales_role_lead_workspace_page(
  target_organization_id uuid,
  target_actor_id uuid,
  target_organization_wide boolean,
  target_branch_scope_ids uuid[],
  target_team_scope_ids uuid[],
  target_owner_scope boolean,
  target_owner_branch_ids uuid[],
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
  -- Personal pins for this viewer, most recently pinned first. Capped so the
  -- ordering join below stays a tiny hash probe even for heavy pinners.
  pinned_lead_ids uuid[];
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

  return (
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
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
        and (
          target_organization_wide
          or lead_row.branch_id = any(target_branch_scope_ids)
          or (
            lead_row.team_id is not null
            and lead_row.team_id = any(target_team_scope_ids)
          )
          or (
            target_owner_scope
            and lead_row.assigned_user_id = target_actor_id
            and lead_row.branch_id = any(target_owner_branch_ids)
          )
        )
    ), test_drive_leads as materialized (
      select distinct drive_row.lead_id
      from public.test_drive_appointments drive_row
      join scoped_leads lead_row on lead_row.id = drive_row.lead_id
      where drive_row.organization_id = target_organization_id
        and drive_row.lead_id is not null
    ), quotation_leads as materialized (
      select distinct quotation_row.lead_id
      from public.quotations quotation_row
      join scoped_leads lead_row on lead_row.id = quotation_row.lead_id
      where quotation_row.organization_id = target_organization_id
        and quotation_row.lead_id is not null
        and quotation_row.deleted_at is null
    ), booking_leads as materialized (
      select distinct booking_row.lead_id
      from public.bookings booking_row
      join scoped_leads lead_row on lead_row.id = booking_row.lead_id
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
      from scoped_leads lead_row
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
    ), filtered_lead_ids as materialized (
      select
        lead_row.id,
        lead_row.updated_at,
        lead_row.created_at,
        lead_row.customer_name
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
            or lead_row.normalized_phone like search_phone_digits || '%'
          )
        )
      )
    ), page_ids as materialized (
      select lead_row.id
      from filtered_lead_ids lead_row
      left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
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
      'total', (select count(*) from filtered_lead_ids),
      'kpis', (select to_jsonb(kpis) from kpis),
      'filters', jsonb_build_object(
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
      )
    )
  );
end;
$$;
revoke all on function app_private.get_sales_role_lead_workspace_page(
  uuid, uuid, boolean, uuid[], uuid[], boolean, uuid[], integer, integer,
  text, text, text, text, text, text, text, date, date
) from public, anon, authenticated;

commit;
