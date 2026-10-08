begin;

-- Telecaller -> Sales Consultant handoff report.
--
-- A telecaller hands a qualified lead to a Sales Consultant and the lead then
-- leaves every telecaller list. This report follows those leads: how many each
-- consultant received from each telecaller, what stage each lead is at now and
-- how many reached a booking.
--
-- A handoff is the first QUALIFIED lead_assignments row of a lead. The
-- telecaller who gave it is the owner of the last FRESH assignment before that
-- row (transfer_lead_to_sales only lets the owning telecaller hand a lead
-- over); the handoff's assigned_by covers a lead that never had a FRESH group_row.
-- The lead stays credited to the consultant who received it; a lead a manager
-- later moved is flagged as reassigned rather than moved to another group_row.
--
-- The date range selects handoffs by when they happened. Stage is always the
-- lead's current stage, using the order the lead list uses:
-- Lost > Booking > Quotation > Test Drive > Follow-up > lifecycle.
--
-- New functions only; no deployed body is re-emitted.

create index if not exists lead_assignments_org_type_created_idx
  on public.lead_assignments (organization_id, assignment_type, created_at)
  include (lead_id, assigned_user_id, assigned_by, branch_id, team_id);

create index if not exists lead_assignments_org_lead_created_idx
  on public.lead_assignments (organization_id, lead_id, created_at);

-- Which handoffs the caller may see. Exactly one of the three filters is set:
-- a telecaller sees the leads they handed over, a team manager the handoffs of
-- the teams they manage, and showroom managers, client admins and business
-- owners the handoffs inside their branch scope.
create or replace function app_private.sales_handoff_scope()
returns table (
  organization_id uuid,
  role_key text,
  telecaller_id uuid,
  team_ids uuid[],
  branch_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb := public.get_access_context();
  actor_org uuid;
  actor_role text;
begin
  actor_role := access_context->>'role_key';
  actor_org := nullif(access_context->>'organization_id', '')::uuid;
  if auth.uid() is null
    or access_context->>'destination' is distinct from 'CRM'
    or actor_org is null
    or actor_role is null
    or actor_role not in (
      'telecaller', 'team-manager', 'showroom-manager', 'client-admin', 'business-owner'
    )
  then
    raise exception using errcode = '42501', message = 'SALES_HANDOFF_ACCESS_DENIED';
  end if;
  -- Business Owner reads leads through the customer-level overview grant.
  if not app_private.has_permission(
    actor_org,
    case when actor_role = 'business-owner' then 'customer.view' else 'lead.view' end
  ) then
    raise exception using errcode = '42501', message = 'SALES_HANDOFF_ACCESS_DENIED';
  end if;

  organization_id := actor_org;
  role_key := actor_role;
  if actor_role = 'telecaller' then
    telecaller_id := auth.uid();
  elsif actor_role = 'team-manager' then
    select coalesce(array_agg(team_row.id order by team_row.id), array[]::uuid[])
    into team_ids
    from public.teams team_row
    where team_row.organization_id = actor_org
      and team_row.active
      and team_row.manager_id = auth.uid()
      and app_private.can_access_team(actor_org, team_row.id);
  else
    branch_ids := app_private.actor_branch_scope(actor_org);
  end if;
  return next;
end;
$$;

-- One row per handoff in the window, with the lead's current stage. Both report
-- functions read this set once and group or page it.
create or replace function app_private.sales_handoff_rows(
  target_organization_id uuid,
  target_telecaller_id uuid,
  target_team_ids uuid[],
  target_branch_ids uuid[],
  range_start timestamptz,
  range_end timestamptz
)
returns table (
  lead_id uuid,
  branch_id uuid,
  team_id uuid,
  handed_off_at timestamptz,
  telecaller_id uuid,
  consultant_id uuid,
  current_owner_id uuid,
  stage text,
  stage_bucket text,
  customer_name text,
  phone text,
  normalized_phone text,
  next_followup_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  with handoffs as materialized (
    select handoff_row.lead_id,
      handoff_row.branch_id,
      handoff_row.team_id,
      handoff_row.created_at as handed_off_at,
      coalesce(fresh_row.assigned_user_id, handoff_row.assigned_by) as telecaller_id,
      handoff_row.assigned_user_id as consultant_id
    from public.lead_assignments handoff_row
    left join lateral (
      select fresh.assigned_user_id
      from public.lead_assignments fresh
      where fresh.organization_id = target_organization_id
        and fresh.lead_id = handoff_row.lead_id
        and fresh.assignment_type = 'FRESH'
        and fresh.created_at <= handoff_row.created_at
      order by fresh.created_at desc, fresh.id desc
      limit 1
    ) fresh_row on true
    where handoff_row.organization_id = target_organization_id
      and handoff_row.assignment_type = 'QUALIFIED'
      and handoff_row.created_at >= range_start
      and handoff_row.created_at < range_end
      and (target_team_ids is null or handoff_row.team_id = any(target_team_ids))
      and (target_branch_ids is null or handoff_row.branch_id = any(target_branch_ids))
      and not exists (
        select 1
        from public.lead_assignments earlier
        where earlier.organization_id = target_organization_id
          and earlier.lead_id = handoff_row.lead_id
          and earlier.assignment_type = 'QUALIFIED'
          and (earlier.created_at, earlier.id) < (handoff_row.created_at, handoff_row.id)
      )
  ), staged as (
    select handoffs.*,
      lead_row.assigned_user_id as current_owner_id,
      lead_row.customer_name,
      lead_row.phone,
      lead_row.normalized_phone,
      lead_row.next_followup_at,
      lead_row.updated_at,
      case
        when lead_row.lifecycle_status = 'Lost' then 'Lost'
        when exists (
          select 1 from public.bookings booking_row
          where booking_row.organization_id = target_organization_id
            and booking_row.lead_id = lead_row.id
            and booking_row.deleted_at is null
            and booking_row.status <> 'CANCELLED'
        ) then 'Booking'
        when exists (
          select 1 from public.quotations quotation_row
          where quotation_row.organization_id = target_organization_id
            and quotation_row.lead_id = lead_row.id
            and quotation_row.deleted_at is null
        ) then 'Quotation'
        when exists (
          select 1 from public.test_drive_appointments drive_row
          where drive_row.organization_id = target_organization_id
            and drive_row.lead_id = lead_row.id
        ) then 'Test Drive'
        when lead_row.next_followup_at is not null then 'Follow-up'
        else lead_row.lifecycle_status::text
      end as stage
    from handoffs
    join public.leads lead_row
      on lead_row.id = handoffs.lead_id
     and lead_row.organization_id = target_organization_id
     and lead_row.deleted_at is null
    where target_telecaller_id is null or handoffs.telecaller_id = target_telecaller_id
  )
  select staged.lead_id,
    staged.branch_id,
    staged.team_id,
    staged.handed_off_at,
    staged.telecaller_id,
    staged.consultant_id,
    staged.current_owner_id,
    staged.stage,
    case staged.stage
      when 'Lost' then 'LOST'
      when 'Booking' then 'BOOKED'
      when 'Quotation' then 'QUOTATION'
      when 'Test Drive' then 'TEST_DRIVE'
      when 'Follow-up' then 'FOLLOW_UP'
      else 'WITH_SALES'
    end,
    staged.customer_name,
    staged.phone,
    staged.normalized_phone,
    staged.next_followup_at,
    staged.updated_at
  from staged;
end;
$$;

-- Resolves the window and the caller's scope, narrowed by optional filters. A
-- filter outside the caller's scope is refused rather than silently ignored.
create or replace function app_private.sales_handoff_window(
  target_days integer,
  target_timezone text,
  target_branch_id uuid,
  target_team_id uuid,
  target_telecaller_id uuid
)
returns table (
  organization_id uuid,
  role_key text,
  telecaller_id uuid,
  team_ids uuid[],
  branch_ids uuid[],
  range_start timestamptz,
  range_end timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  scope_row record;
  zone text;
  local_today date;
  start_day date;
begin
  if target_days is null or target_days < 1 or target_days > 9999
    or target_timezone is null
    or target_timezone !~ '^(Asia/Kolkata|UTC)(\|[0-9]{4}-[0-9]{2}-[0-9]{2})?$'
  then
    raise exception using errcode = '22023', message = 'INVALID_SALES_HANDOFF_WINDOW';
  end if;

  select * into scope_row from app_private.sales_handoff_scope();
  zone := split_part(target_timezone, '|', 1);
  local_today := coalesce(
    nullif(split_part(target_timezone, '|', 2), '')::date,
    timezone(zone, now())::date
  );
  start_day := local_today - (target_days - 1);

  organization_id := scope_row.organization_id;
  role_key := scope_row.role_key;
  telecaller_id := scope_row.telecaller_id;
  team_ids := scope_row.team_ids;
  branch_ids := scope_row.branch_ids;
  range_start := timezone(zone, start_day::timestamp);
  range_end := timezone(zone, (local_today + 1)::timestamp);

  if target_branch_id is not null then
    if branch_ids is not null and not (target_branch_id = any(branch_ids)) then
      raise exception using errcode = '42501', message = 'SALES_HANDOFF_OUT_OF_SCOPE';
    end if;
    branch_ids := array[target_branch_id];
  end if;
  if target_team_id is not null then
    if team_ids is not null and not (target_team_id = any(team_ids)) then
      raise exception using errcode = '42501', message = 'SALES_HANDOFF_OUT_OF_SCOPE';
    end if;
    team_ids := array[target_team_id];
  end if;
  if target_telecaller_id is not null then
    if telecaller_id is not null and telecaller_id <> target_telecaller_id then
      raise exception using errcode = '42501', message = 'SALES_HANDOFF_OUT_OF_SCOPE';
    end if;
    telecaller_id := target_telecaller_id;
  end if;
  return next;
end;
$$;

create or replace function public.get_sales_handoff_summary(
  target_days integer default 30,
  target_timezone text default 'Asia/Kolkata',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_telecaller_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  window_row record;
begin
  select * into window_row
  from app_private.sales_handoff_window(
    target_days, target_timezone, target_branch_id, target_team_id, target_telecaller_id
  );

  return (
    with handoffs as materialized (
      select *
      from app_private.sales_handoff_rows(
        window_row.organization_id,
        window_row.telecaller_id,
        window_row.team_ids,
        window_row.branch_ids,
        window_row.range_start,
        window_row.range_end
      )
    ), names as materialized (
      select profile_row.id, profile_row.full_name
      from public.profiles profile_row
      where profile_row.organization_id = window_row.organization_id
        and profile_row.id in (
          select handoffs.telecaller_id from handoffs
          union select handoffs.consultant_id from handoffs
        )
    ), by_consultant as (
      select handoffs.consultant_id,
        count(*)::integer as transferred,
        count(*) filter (where stage_bucket = 'WITH_SALES')::integer as with_sales,
        count(*) filter (where stage_bucket = 'FOLLOW_UP')::integer as follow_up,
        count(*) filter (where stage_bucket = 'TEST_DRIVE')::integer as test_drive,
        count(*) filter (where stage_bucket = 'QUOTATION')::integer as quotation,
        count(*) filter (where stage_bucket = 'BOOKED')::integer as booked,
        count(*) filter (where stage_bucket = 'LOST')::integer as lost,
        count(*) filter (
          where current_owner_id is distinct from consultant_id
        )::integer as reassigned
      from handoffs
      group by handoffs.consultant_id
    ), by_telecaller as (
      select handoffs.telecaller_id,
        count(*)::integer as transferred,
        count(distinct handoffs.consultant_id)::integer as consultants,
        count(*) filter (where stage_bucket in ('WITH_SALES', 'FOLLOW_UP', 'TEST_DRIVE', 'QUOTATION'))::integer
          as in_progress,
        count(*) filter (where stage_bucket = 'BOOKED')::integer as booked,
        count(*) filter (where stage_bucket = 'LOST')::integer as lost
      from handoffs
      group by handoffs.telecaller_id
    ), matrix as (
      select handoffs.telecaller_id,
        handoffs.consultant_id,
        count(*)::integer as transferred,
        count(*) filter (where stage_bucket in ('WITH_SALES', 'FOLLOW_UP', 'TEST_DRIVE', 'QUOTATION'))::integer
          as in_progress,
        count(*) filter (where stage_bucket = 'BOOKED')::integer as booked,
        count(*) filter (where stage_bucket = 'LOST')::integer as lost
      from handoffs
      group by handoffs.telecaller_id, handoffs.consultant_id
    ), by_branch as (
      select handoffs.branch_id,
        count(*)::integer as transferred,
        count(*) filter (where stage_bucket in ('WITH_SALES', 'FOLLOW_UP', 'TEST_DRIVE', 'QUOTATION'))::integer
          as in_progress,
        count(*) filter (where stage_bucket = 'BOOKED')::integer as booked,
        count(*) filter (where stage_bucket = 'LOST')::integer as lost
      from handoffs
      where window_row.role_key in ('client-admin', 'business-owner')
      group by handoffs.branch_id
    )
    select jsonb_build_object(
      'days', target_days,
      'generated_at', now(),
      'kpis', (
        select jsonb_build_object(
          'transferred', count(*),
          'with_sales', count(*) filter (where stage_bucket = 'WITH_SALES'),
          'follow_up', count(*) filter (where stage_bucket = 'FOLLOW_UP'),
          'test_drive', count(*) filter (where stage_bucket = 'TEST_DRIVE'),
          'quotation', count(*) filter (where stage_bucket = 'QUOTATION'),
          'booked', count(*) filter (where stage_bucket = 'BOOKED'),
          'lost', count(*) filter (where stage_bucket = 'LOST'),
          'reassigned', count(*) filter (where current_owner_id is distinct from consultant_id),
          'conversion_pct', coalesce(
            round(count(*) filter (where stage_bucket = 'BOOKED') * 100.0 / nullif(count(*), 0), 1),
            0
          )
        )
        from handoffs
      ),
      'by_consultant', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'consultant_id', group_row.consultant_id,
            'consultant', coalesce(name_row.full_name, 'Former user'),
            'transferred', group_row.transferred,
            'with_sales', group_row.with_sales,
            'follow_up', group_row.follow_up,
            'test_drive', group_row.test_drive,
            'quotation', group_row.quotation,
            'booked', group_row.booked,
            'lost', group_row.lost,
            'reassigned', group_row.reassigned,
            'conversion_pct', round(group_row.booked * 100.0 / group_row.transferred, 1)
          )
          order by group_row.transferred desc, name_row.full_name, group_row.consultant_id
        )
        from by_consultant group_row
        left join names name_row on name_row.id = group_row.consultant_id
      ), '[]'::jsonb),
      'by_telecaller', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'telecaller_id', group_row.telecaller_id,
            'telecaller', coalesce(name_row.full_name, 'Former user'),
            'transferred', group_row.transferred,
            'consultants', group_row.consultants,
            'in_progress', group_row.in_progress,
            'booked', group_row.booked,
            'lost', group_row.lost,
            'conversion_pct', round(group_row.booked * 100.0 / group_row.transferred, 1)
          )
          order by group_row.transferred desc, name_row.full_name, group_row.telecaller_id
        )
        from by_telecaller group_row
        left join names name_row on name_row.id = group_row.telecaller_id
        where window_row.role_key <> 'telecaller'
      ), '[]'::jsonb),
      'matrix', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'telecaller_id', group_row.telecaller_id,
            'telecaller', coalesce(telecaller_name.full_name, 'Former user'),
            'consultant_id', group_row.consultant_id,
            'consultant', coalesce(consultant_name.full_name, 'Former user'),
            'transferred', group_row.transferred,
            'in_progress', group_row.in_progress,
            'booked', group_row.booked,
            'lost', group_row.lost,
            'conversion_pct', round(group_row.booked * 100.0 / group_row.transferred, 1)
          )
          order by telecaller_name.full_name, group_row.transferred desc, consultant_name.full_name
        )
        from matrix group_row
        left join names telecaller_name on telecaller_name.id = group_row.telecaller_id
        left join names consultant_name on consultant_name.id = group_row.consultant_id
      ), '[]'::jsonb),
      'by_branch', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'branch_id', group_row.branch_id,
            'branch', coalesce(branch_row.name, 'Branch'),
            'transferred', group_row.transferred,
            'in_progress', group_row.in_progress,
            'booked', group_row.booked,
            'lost', group_row.lost,
            'conversion_pct', round(group_row.booked * 100.0 / group_row.transferred, 1)
          )
          order by group_row.transferred desc, branch_row.name
        )
        from by_branch group_row
        left join public.branches branch_row
          on branch_row.id = group_row.branch_id
         and branch_row.organization_id = window_row.organization_id
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.get_sales_handoff_leads(
  target_days integer default 30,
  target_timezone text default 'Asia/Kolkata',
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_telecaller_id uuid default null,
  target_consultant_id uuid default null,
  target_stage text default null,
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  window_row record;
  search_term text := nullif(btrim(coalesce(target_search, '')), '');
  name_pattern text;
  phone_digits text;
begin
  if target_stage is not null and target_stage not in (
    'WITH_SALES', 'FOLLOW_UP', 'TEST_DRIVE', 'QUOTATION', 'BOOKED', 'LOST'
  )
    or target_page is null or target_page < 1 or target_page > 100000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or char_length(coalesce(search_term, '')) > 100
  then
    raise exception using errcode = '22023', message = 'INVALID_SALES_HANDOFF_QUERY';
  end if;

  select * into window_row
  from app_private.sales_handoff_window(
    target_days, target_timezone, target_branch_id, target_team_id, target_telecaller_id
  );

  if search_term is not null then
    name_pattern := '%' || replace(replace(replace(lower(search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    phone_digits := nullif(regexp_replace(search_term, '\D', '', 'g'), '');
    if char_length(coalesce(phone_digits, '')) < 3 then
      phone_digits := null;
    end if;
  end if;

  return (
    with filtered as materialized (
      select handoffs.*
      from app_private.sales_handoff_rows(
        window_row.organization_id,
        window_row.telecaller_id,
        window_row.team_ids,
        window_row.branch_ids,
        window_row.range_start,
        window_row.range_end
      ) handoffs
      where (target_consultant_id is null or handoffs.consultant_id = target_consultant_id)
        and (target_stage is null or handoffs.stage_bucket = target_stage)
        and (
          search_term is null
          or lower(handoffs.customer_name) like name_pattern
          or (phone_digits is not null and handoffs.normalized_phone like '%' || phone_digits || '%')
        )
    ), page_rows as (
      select filtered.*
      from filtered
      order by filtered.handed_off_at desc, filtered.lead_id
      limit target_page_size
      offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'page', target_page,
      'page_size', target_page_size,
      'total', (select count(*) from filtered),
      'rows', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'lead_id', page_rows.lead_id,
            'customer_name', page_rows.customer_name,
            'phone', page_rows.phone,
            'telecaller', coalesce(telecaller_row.full_name, 'Former user'),
            'received_by', coalesce(consultant_row.full_name, 'Former user'),
            'current_owner', owner_row.full_name,
            'reassigned', page_rows.current_owner_id is distinct from page_rows.consultant_id,
            'handed_off_at', page_rows.handed_off_at,
            'stage', page_rows.stage,
            'stage_bucket', page_rows.stage_bucket,
            'next_followup_at', page_rows.next_followup_at,
            'updated_at', page_rows.updated_at
          )
          order by page_rows.handed_off_at desc, page_rows.lead_id
        )
        from page_rows
        left join public.profiles telecaller_row on telecaller_row.id = page_rows.telecaller_id
        left join public.profiles consultant_row on consultant_row.id = page_rows.consultant_id
        left join public.profiles owner_row on owner_row.id = page_rows.current_owner_id
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function app_private.sales_handoff_scope() from public, anon, authenticated;
revoke all on function app_private.sales_handoff_rows(uuid, uuid, uuid[], uuid[], timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function app_private.sales_handoff_window(integer, text, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.get_sales_handoff_summary(integer, text, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.get_sales_handoff_summary(integer, text, uuid, uuid, uuid)
  to authenticated;
revoke all on function public.get_sales_handoff_leads(
  integer, text, uuid, uuid, uuid, uuid, text, text, integer, integer
) from public, anon;
grant execute on function public.get_sales_handoff_leads(
  integer, text, uuid, uuid, uuid, uuid, text, text, integer, integer
) to authenticated;

commit;
