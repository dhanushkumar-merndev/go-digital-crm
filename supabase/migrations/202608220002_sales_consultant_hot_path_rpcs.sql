begin;

-- Resolve the authenticated workspace, identity and permission set in one
-- round trip.  This is intentionally flat because it replaces get_access_context
-- in middleware/layout code while preserving every non-CRM destination.
create or replace function public.get_workspace_bootstrap()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  profile_row public.profiles%rowtype;
  organization_name_value text;
  permission_keys text[] := array[]::text[];
  allowed_branch_ids uuid[] := array[]::uuid[];
  active_team_ids uuid[] := array[]::uuid[];
  assignment_fingerprint text := '';
  scope_key_value text;
begin
  access_context := public.get_access_context();

  if auth.uid() is null or access_context->>'destination' <> 'CRM' then
    return access_context || jsonb_build_object('permissions', '[]'::jsonb);
  end if;

  select profile_source.*
  into profile_row
  from public.profiles profile_source
  where profile_source.id = auth.uid();

  select coalesce(array_agg(permission_source.permission_key order by permission_source.permission_key), array[]::text[])
  into permission_keys
  from (
    select distinct permission_row.permission_key
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id is not distinct from assignment_row.organization_id
    join public.role_permissions role_permission_row
      on role_permission_row.role_id = role_row.id
    join public.permissions permission_row
      on permission_row.id = role_permission_row.permission_id
    where assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.organization_id is not distinct from profile_row.organization_id
  ) permission_source;

  select coalesce(string_agg(
    concat_ws(
      ':',
      assignment_row.id::text,
      assignment_row.data_scope::text,
      coalesce(assignment_row.scope_branch_id::text, ''),
      assignment_row.selected_branch_ids::text,
      assignment_row.active::text
    ),
    ';' order by assignment_row.id
  ), '')
  into assignment_fingerprint
  from public.user_role_assignments assignment_row
  where assignment_row.user_id = auth.uid()
    and assignment_row.active
    and assignment_row.organization_id is not distinct from profile_row.organization_id;

  if profile_row.organization_id is not null then
    select organization_row.name
    into organization_name_value
    from public.organizations organization_row
    where organization_row.id = profile_row.organization_id;

    select coalesce(array_agg(branch_row.id order by branch_row.id), array[]::uuid[])
    into allowed_branch_ids
    from public.branches branch_row
    where branch_row.organization_id = profile_row.organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and app_private.can_access_branch(profile_row.organization_id, branch_row.id);

    select coalesce(array_agg(member_row.team_id order by member_row.team_id), array[]::uuid[])
    into active_team_ids
    from public.team_members member_row
    join public.teams team_row
      on team_row.organization_id = member_row.organization_id
     and team_row.id = member_row.team_id
     and team_row.active
    where member_row.organization_id = profile_row.organization_id
      and member_row.user_id = auth.uid()
      and member_row.active;
  end if;

  scope_key_value := concat_ws(
    ':',
    coalesce(profile_row.organization_id::text, 'platform'),
    auth.uid()::text,
    coalesce(access_context->>'role_key', 'unknown'),
    coalesce(access_context->>'data_scope', 'none'),
    pg_catalog.md5(concat_ws(
      '|',
      assignment_fingerprint,
      permission_keys::text,
      allowed_branch_ids::text,
      active_team_ids::text
    ))
  );

  return access_context || jsonb_build_object(
    'scope_key', scope_key_value,
    'permissions', to_jsonb(permission_keys),
    'display_name', profile_row.full_name,
    'email', profile_row.email,
    'organization_name', organization_name_value,
    'workspace_name', coalesce(organization_name_value, 'Go Digital Marketing CRM')
  );
end;
$$;

revoke all on function public.get_workspace_bootstrap() from public, anon;
grant execute on function public.get_workspace_bootstrap() to authenticated;

-- Sales Consultant reporting RPCs are deliberately owner-only.  The role gate
-- below is the authority boundary; branch access is enumerated once per request
-- so large fact scans never call SECURITY DEFINER scope helpers per row.
create or replace function app_private.sales_consultant_organization()
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
    or access_context->>'role_key' <> 'sales-consultant'
    or access_context->>'organization_id' is null
  then
    raise exception using
      errcode = '42501',
      message = 'SALES_CONSULTANT_ACCESS_REQUIRED';
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
      and permission_row.permission_key = 'lead.view'
  ) then
    raise exception using
      errcode = '42501',
      message = 'SALES_CONSULTANT_LEAD_VIEW_REQUIRED';
  end if;
  return organization_id_value;
end;
$$;

create or replace function app_private.sales_consultant_allowed_branches(
  target_organization_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(branch_row.id order by branch_row.id), array[]::uuid[])
  from public.branches branch_row
  where branch_row.organization_id = target_organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.organization_id = assignment_row.organization_id
       and role_row.id = assignment_row.role_id
      where assignment_row.organization_id = target_organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
        and (
          assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
          or (
            assignment_row.data_scope = 'ONE_BRANCH'
            and assignment_row.scope_branch_id = branch_row.id
          )
          or (
            assignment_row.data_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(assignment_row.selected_branch_ids)
          )
          or exists (
            select 1
            from public.user_branch_access branch_access_row
            where branch_access_row.organization_id = target_organization_id
              and branch_access_row.user_id = auth.uid()
              and branch_access_row.branch_id = branch_row.id
              and branch_access_row.active
          )
          or exists (
            select 1
            from public.team_members member_row
            join public.teams team_row
              on team_row.organization_id = member_row.organization_id
             and team_row.id = member_row.team_id
            where member_row.organization_id = target_organization_id
              and member_row.user_id = auth.uid()
              and member_row.active
              and team_row.active
              and team_row.branch_id = branch_row.id
          )
        )
    );
$$;

-- The role/access gate is resolved before this helper is used. Fetching the
-- complete permission set once avoids repeatedly executing the deeply nested
-- has_permission -> can_access_organization chain for every dashboard module.
create or replace function app_private.sales_consultant_permissions(
  target_organization_id uuid
)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    array_agg(distinct permission_row.permission_key order by permission_row.permission_key),
    array[]::text[]
  )
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.organization_id = assignment_row.organization_id
   and role_row.id = assignment_row.role_id
  join public.role_permissions role_permission_row
    on role_permission_row.role_id = role_row.id
  join public.permissions permission_row
    on permission_row.id = role_permission_row.permission_id
  where assignment_row.organization_id = target_organization_id
    and assignment_row.user_id = auth.uid()
    and assignment_row.active;
$$;

revoke all on function app_private.sales_consultant_organization()
  from public, anon, authenticated;
revoke all on function app_private.sales_consultant_allowed_branches(uuid)
  from public, anon, authenticated;
revoke all on function app_private.sales_consultant_permissions(uuid)
  from public, anon, authenticated;

create or replace function app_private.sales_consultant_top_models(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_ids uuid[],
  target_month_start timestamptz,
  target_month_end timestamptz,
  target_previous_month_start timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  permission_keys text[];
  can_view_bookings boolean;
  can_view_inventory boolean;
  result jsonb;
begin
  if cardinality(coalesce(target_branch_ids, array[]::uuid[])) = 0 then
    return '[]'::jsonb;
  end if;

  permission_keys := app_private.sales_consultant_permissions(target_organization_id);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);
  can_view_inventory :=
    'inventory.stock_check' = any(permission_keys) or 'inventory.view' = any(permission_keys);

  with interest_counts as (
    select btrim(lead_row.interested_model) as model_name,
      count(*)::bigint as interest_count
    from public.leads lead_row
    where lead_row.organization_id = target_organization_id
      and lead_row.assigned_user_id = target_user_id
      and lead_row.branch_id = any(target_branch_ids)
      and lead_row.deleted_at is null
      and lead_row.created_at >= target_month_start
      and lead_row.created_at < target_month_end
      and nullif(btrim(lead_row.interested_model), '') is not null
    group by btrim(lead_row.interested_model)
  ), current_bookings as (
    select btrim(lead_row.interested_model) as model_name,
      count(*)::bigint as booking_count
    from public.bookings booking_row
    join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id
     and lead_row.id = booking_row.lead_id
     and lead_row.deleted_at is null
    where can_view_bookings
      and booking_row.organization_id = target_organization_id
      and booking_row.assigned_user_id = target_user_id
      and booking_row.branch_id = any(target_branch_ids)
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= target_month_start
      and booking_row.created_at < target_month_end
      and nullif(btrim(lead_row.interested_model), '') is not null
    group by btrim(lead_row.interested_model)
  ), previous_bookings as (
    select btrim(lead_row.interested_model) as model_name,
      count(*)::bigint as booking_count
    from public.bookings booking_row
    join public.leads lead_row
      on lead_row.organization_id = booking_row.organization_id
     and lead_row.id = booking_row.lead_id
     and lead_row.deleted_at is null
    where can_view_bookings
      and booking_row.organization_id = target_organization_id
      and booking_row.assigned_user_id = target_user_id
      and booking_row.branch_id = any(target_branch_ids)
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= target_previous_month_start
      and booking_row.created_at < target_month_start
      and nullif(btrim(lead_row.interested_model), '') is not null
    group by btrim(lead_row.interested_model)
  ), candidate_source as (
    select interest_row.model_name, interest_row.interest_count
    from interest_counts interest_row
    union all
    select booking_row.model_name, 0::bigint
    from current_bookings booking_row
    union all
    select model_row.name, 0::bigint
    from public.vehicle_models model_row
    where can_view_inventory
      and model_row.organization_id = target_organization_id
      and model_row.active
  ), candidate_names as (
    select min(candidate_row.model_name) as model_name,
      max(candidate_row.interest_count)::bigint as interest_count
    from candidate_source candidate_row
    where nullif(btrim(candidate_row.model_name), '') is not null
    group by lower(candidate_row.model_name)
  ), ranked_candidates as (
    select candidate_row.model_name,
      candidate_row.interest_count,
      coalesce(current_row.booking_count, 0)::bigint as bookings,
      coalesce(previous_row.booking_count, 0)::bigint as previous_bookings
    from candidate_names candidate_row
    left join current_bookings current_row
      on lower(current_row.model_name) = lower(candidate_row.model_name)
    left join previous_bookings previous_row
      on lower(previous_row.model_name) = lower(candidate_row.model_name)
    order by
      coalesce(current_row.booking_count, 0) desc,
      candidate_row.interest_count desc,
      candidate_row.model_name
    limit 20
  ), model_rows as (
    select
      matched_model.id as model_id,
      candidate_row.model_name as name,
      candidate_row.bookings,
      app_private.dashboard_percent_change(
        candidate_row.bookings,
        candidate_row.previous_bookings
      ) as change,
      coalesce(stock_summary.available_stock, 0)::bigint as available_stock,
      stock_summary.image_object_file_id,
      candidate_row.interest_count
    from ranked_candidates candidate_row
    left join lateral (
      select model_row.id
      from public.vehicle_models model_row
      where model_row.organization_id = target_organization_id
        and model_row.active
        and (
          lower(candidate_row.model_name) = lower(model_row.name)
          or lower(candidate_row.model_name) like '%' || lower(model_row.name) || '%'
        )
      order by
        (lower(candidate_row.model_name) = lower(model_row.name)) desc,
        char_length(model_row.name) desc,
        model_row.id
      limit 1
    ) matched_model on true
    left join lateral (
      select count(*)::bigint as available_stock,
        (array_agg(
          image_file.id
          order by stock_row.received_at desc nulls last, image_file.created_at desc
        ) filter (where image_file.id is not null))[1] as image_object_file_id
      from public.vehicle_variants variant_row
      join public.stock_units stock_row
        on stock_row.organization_id = variant_row.organization_id
       and stock_row.variant_id = variant_row.id
       and stock_row.deleted_at is null
       and stock_row.status = 'AVAILABLE'
       and stock_row.branch_id = any(target_branch_ids)
      left join lateral (
        select file_row.id, file_row.created_at
        from public.object_files file_row
        where file_row.organization_id = stock_row.organization_id
          and file_row.resource_type = 'stock_unit'
          and file_row.resource_id = stock_row.id
          and file_row.deleted_at is null
          and file_row.mime_type like 'image/%'
        order by file_row.created_at desc, file_row.id desc
        limit 1
      ) image_file on can_view_inventory
      where can_view_inventory
        and variant_row.organization_id = target_organization_id
        and variant_row.model_id = matched_model.id
    ) stock_summary on matched_model.id is not null
  )
  select coalesce(jsonb_agg(
    to_jsonb(model_row) - 'interest_count'
    order by model_row.bookings desc, model_row.interest_count desc, model_row.name
  ), '[]'::jsonb)
  into result
  from (
    select source_row.*
    from model_rows source_row
    order by source_row.bookings desc, source_row.interest_count desc,
      source_row.available_stock desc, source_row.name
    limit 5
  ) model_row;

  return result;
end;
$$;

revoke all on function app_private.sales_consultant_top_models(
  uuid, uuid, uuid[], timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;

create or replace function public.get_sales_consultant_top_models(
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
  local_today date;
  month_start timestamptz;
  month_end timestamptz;
  previous_month_start timestamptz;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'DASHBOARD_TIMEZONE_INVALID';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  local_today := timezone(target_timezone, now())::date;
  month_start := timezone(target_timezone, date_trunc('month', local_today::timestamp));
  month_end := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp) + interval '1 month'
  );
  previous_month_start := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp) - interval '1 month'
  );

  return app_private.sales_consultant_top_models(
    current_organization_id,
    current_user_id,
    allowed_branch_ids,
    month_start,
    month_end,
    previous_month_start
  );
end;
$$;

revoke all on function public.get_sales_consultant_top_models(text) from public, anon;
grant execute on function public.get_sales_consultant_top_models(text) to authenticated;

-- Cache-safe personal summary.  It contains aggregate data and object IDs only:
-- no customer names, phones, schedule rows, presigned URLs or raw provider data.
create or replace function public.get_sales_consultant_dashboard_summary(
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
  permission_keys text[];
  local_today date;
  yesterday_start timestamptz;
  today_start timestamptz;
  tomorrow_start timestamptz;
  previous_month_start timestamptz;
  month_start timestamptz;
  month_end timestamptz;
  can_view_followups boolean;
  can_view_test_drives boolean;
  can_view_quotations boolean;
  can_view_bookings boolean;
  can_view_insurance boolean;
  can_view_rto boolean;
  assigned_current bigint := 0;
  assigned_previous bigint := 0;
  hot_current bigint := 0;
  hot_previous bigint := 0;
  followup_current bigint := 0;
  followup_previous bigint := 0;
  calls_pending_current bigint := 0;
  calls_pending_previous bigint := 0;
  drive_current bigint := 0;
  drive_previous bigint := 0;
  quotation_current bigint := 0;
  quotation_previous bigint := 0;
  booking_current bigint := 0;
  booking_previous bigint := 0;
  current_target numeric := 0;
  previous_target numeric := 0;
  target_current numeric := 0;
  target_previous numeric := 0;
  hot_not_called_count bigint := 0;
  overdue_followup_count bigint := 0;
  test_drive_without_quote_count bigint := 0;
  quotation_without_booking_count bigint := 0;
  waiting_for_stock_count bigint := 0;
  quotation_awaiting_count bigint := 0;
  insurance_pending_count bigint := 0;
  rto_pending_count bigint := 0;
  pipeline_result jsonb := '[]'::jsonb;
  top_models_result jsonb := '[]'::jsonb;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_SALES_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  local_today := timezone(target_timezone, now())::date;
  yesterday_start := timezone(target_timezone, (local_today - 1)::timestamp);
  today_start := timezone(target_timezone, local_today::timestamp);
  tomorrow_start := timezone(target_timezone, (local_today + 1)::timestamp);
  month_start := timezone(target_timezone, date_trunc('month', local_today::timestamp));
  month_end := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp) + interval '1 month'
  );
  previous_month_start := timezone(
    target_timezone,
    date_trunc('month', local_today::timestamp) - interval '1 month'
  );

  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  can_view_followups := 'followup.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_quotations :=
    'quotation.view' = any(permission_keys) or 'quotation.manage' = any(permission_keys);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);
  can_view_insurance :=
    'insurance.view' = any(permission_keys) or 'insurance.manage' = any(permission_keys);
  can_view_rto :=
    'rto.view' = any(permission_keys) or 'rto.manage' = any(permission_keys);

  if cardinality(allowed_branch_ids) > 0 then
    select
      count(*) filter (
        where history_row.created_at >= today_start
          and history_row.created_at < tomorrow_start
      ),
      count(*) filter (
        where history_row.created_at >= yesterday_start
          and history_row.created_at < today_start
      )
    into assigned_current, assigned_previous
    from public.lead_assignment_history history_row
    where history_row.organization_id = current_organization_id
      and history_row.new_owner_id = current_user_id
      and history_row.branch_id = any(allowed_branch_ids)
      and history_row.created_at >= yesterday_start
      and history_row.created_at < tomorrow_start;

    select
      count(*) filter (
        where lead_row.temperature = 'HOT'
          and lead_row.lifecycle_status <> 'Lost'
      ),
      count(*) filter (
        where lead_row.temperature = 'HOT'
          and lead_row.lifecycle_status <> 'Lost'
          and lead_row.created_at < today_start
      ),
      count(*) filter (
        where lead_row.temperature = 'HOT'
          and lead_row.lifecycle_status <> 'Lost'
          and lead_row.first_contacted_at is null
      )
    into hot_current, hot_previous, hot_not_called_count
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.assigned_user_id = current_user_id
      and lead_row.branch_id = any(allowed_branch_ids)
      and lead_row.deleted_at is null;

    if can_view_followups then
      select
        count(*) filter (
          where followup_row.due_at >= today_start
            and followup_row.due_at < tomorrow_start
        ),
        count(*) filter (
          where followup_row.due_at >= yesterday_start
            and followup_row.due_at < today_start
        ),
        count(*) filter (
          where followup_row.due_at < tomorrow_start
            and (
              followup_row.reason ilike '%call%'
              or followup_row.reason ilike '%contact%'
            )
        ),
        count(*) filter (
          where followup_row.due_at < today_start
            and (
              followup_row.reason ilike '%call%'
              or followup_row.reason ilike '%contact%'
            )
        ),
        count(*) filter (where followup_row.due_at < now())
      into
        followup_current,
        followup_previous,
        calls_pending_current,
        calls_pending_previous,
        overdue_followup_count
      from public.followups followup_row
      where followup_row.organization_id = current_organization_id
        and followup_row.assigned_user_id = current_user_id
        and followup_row.branch_id = any(allowed_branch_ids)
        and followup_row.status in ('OPEN', 'OVERDUE');
    end if;

    if can_view_test_drives then
      select
        count(*) filter (
          where appointment_row.scheduled_at >= today_start
            and appointment_row.scheduled_at < tomorrow_start
        ),
        count(*) filter (
          where appointment_row.scheduled_at >= yesterday_start
            and appointment_row.scheduled_at < today_start
        )
      into drive_current, drive_previous
      from public.test_drive_appointments appointment_row
      where appointment_row.organization_id = current_organization_id
        and appointment_row.assigned_user_id = current_user_id
        and appointment_row.branch_id = any(allowed_branch_ids)
        and appointment_row.status <> 'CANCELLED'
        and appointment_row.scheduled_at >= yesterday_start
        and appointment_row.scheduled_at < tomorrow_start;

      if can_view_quotations then
        select count(*)
        into test_drive_without_quote_count
        from public.test_drives drive_row
        where drive_row.organization_id = current_organization_id
          and drive_row.assigned_user_id = current_user_id
          and drive_row.branch_id = any(allowed_branch_ids)
          and drive_row.status = 'COMPLETED'
          and not exists (
            select 1
            from public.quotations quotation_row
            where quotation_row.organization_id = drive_row.organization_id
              and quotation_row.deleted_at is null
              and (
                quotation_row.lead_id = drive_row.lead_id
                or quotation_row.customer_id = drive_row.customer_id
              )
          );
      end if;
    end if;

    if can_view_quotations then
      select
        count(*) filter (
          where quotation_row.status in ('DRAFT', 'PENDING_APPROVAL', 'SENT')
        ),
        count(*) filter (
          where quotation_row.status in ('DRAFT', 'PENDING_APPROVAL', 'SENT')
            and quotation_row.created_at < today_start
        ),
        count(*) filter (where quotation_row.status = 'SENT')
      into quotation_current, quotation_previous, quotation_awaiting_count
      from public.quotations quotation_row
      where quotation_row.organization_id = current_organization_id
        and quotation_row.assigned_user_id = current_user_id
        and quotation_row.branch_id = any(allowed_branch_ids)
        and quotation_row.deleted_at is null;

      if can_view_bookings then
        select count(*)
        into quotation_without_booking_count
        from public.quotations quotation_row
        where quotation_row.organization_id = current_organization_id
          and quotation_row.assigned_user_id = current_user_id
          and quotation_row.branch_id = any(allowed_branch_ids)
          and quotation_row.deleted_at is null
          and quotation_row.status in ('SENT', 'ACCEPTED')
          and not exists (
            select 1
            from public.bookings booking_row
            where booking_row.organization_id = quotation_row.organization_id
              and booking_row.quotation_id = quotation_row.id
              and booking_row.deleted_at is null
              and booking_row.status <> 'CANCELLED'
          );
      end if;
    end if;

    if can_view_bookings then
      select
        count(*) filter (
          where booking_row.created_at >= month_start
            and booking_row.created_at < month_end
        ),
        count(*) filter (
          where booking_row.created_at >= previous_month_start
            and booking_row.created_at < month_start
        ),
        count(*) filter (where booking_row.status = 'AWAITING_ALLOCATION')
      into booking_current, booking_previous, waiting_for_stock_count
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.assigned_user_id = current_user_id
        and booking_row.branch_id = any(allowed_branch_ids)
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED';
    end if;

    if can_view_insurance and can_view_bookings then
      select count(*)
      into insurance_pending_count
      from public.insurance_cases case_row
      join public.bookings booking_row
        on booking_row.organization_id = case_row.organization_id
       and booking_row.id = case_row.booking_id
       and booking_row.deleted_at is null
      where case_row.organization_id = current_organization_id
        and case_row.deleted_at is null
        and case_row.status = 'QUOTE_PENDING'
        and booking_row.assigned_user_id = current_user_id
        and booking_row.branch_id = any(allowed_branch_ids);
    end if;

    if can_view_rto and can_view_bookings then
      select count(*)
      into rto_pending_count
      from public.rto_cases case_row
      join public.bookings booking_row
        on booking_row.organization_id = case_row.organization_id
       and booking_row.id = case_row.booking_id
       and booking_row.deleted_at is null
      where case_row.organization_id = current_organization_id
        and case_row.deleted_at is null
        and case_row.status in ('NEW', 'DOCUMENTS_PENDING', 'SUBMITTED', 'IN_PROCESS')
        and booking_row.assigned_user_id = current_user_id
        and booking_row.branch_id = any(allowed_branch_ids);
    end if;

    select coalesce((
      select target_row.target_value
      from public.targets target_row
      where target_row.organization_id = current_organization_id
        and target_row.user_id = current_user_id
        and upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')
        and local_today between target_row.period_start and target_row.period_end
      order by target_row.created_at desc
      limit 1
    ), 0)
    into current_target;

    select coalesce((
      select target_row.target_value
      from public.targets target_row
      where target_row.organization_id = current_organization_id
        and target_row.user_id = current_user_id
        and upper(target_row.metric) in ('BOOKINGS', 'SALES_BOOKINGS')
        and (local_today - interval '1 month')::date
          between target_row.period_start and target_row.period_end
      order by target_row.created_at desc
      limit 1
    ), 0)
    into previous_target;

    target_current := case when current_target > 0
      then round((booking_current * 100 / current_target)::numeric, 1)
      else 0 end;
    target_previous := case when previous_target > 0
      then round((booking_previous * 100 / previous_target)::numeric, 1)
      else 0 end;

    with pipeline_rows as (
      select 1 as display_order, 'Leads Assigned'::text as name, count(*)::bigint as value
      from public.lead_assignment_history history_row
      where history_row.organization_id = current_organization_id
        and history_row.new_owner_id = current_user_id
        and history_row.branch_id = any(allowed_branch_ids)
        and history_row.created_at >= month_start
        and history_row.created_at < month_end
      union all
      select 2, 'Follow-up', count(distinct followup_row.lead_id)
      from public.followups followup_row
      where can_view_followups
        and followup_row.organization_id = current_organization_id
        and followup_row.assigned_user_id = current_user_id
        and followup_row.branch_id = any(allowed_branch_ids)
        and followup_row.created_at >= month_start
        and followup_row.created_at < month_end
      union all
      select 3, 'Test Drive', count(*)
      from public.test_drive_appointments drive_row
      where can_view_test_drives
        and drive_row.organization_id = current_organization_id
        and drive_row.assigned_user_id = current_user_id
        and drive_row.branch_id = any(allowed_branch_ids)
        and drive_row.status <> 'CANCELLED'
        and drive_row.created_at >= month_start
        and drive_row.created_at < month_end
      union all
      select 4, 'Quotation', count(*)
      from public.quotations quotation_row
      where can_view_quotations
        and quotation_row.organization_id = current_organization_id
        and quotation_row.assigned_user_id = current_user_id
        and quotation_row.branch_id = any(allowed_branch_ids)
        and quotation_row.deleted_at is null
        and quotation_row.status <> 'REJECTED'
        and quotation_row.created_at >= month_start
        and quotation_row.created_at < month_end
      union all
      select 5, 'Booking', count(*)
      from public.bookings booking_row
      where can_view_bookings
        and booking_row.organization_id = current_organization_id
        and booking_row.assigned_user_id = current_user_id
        and booking_row.branch_id = any(allowed_branch_ids)
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= month_start
        and booking_row.created_at < month_end
    )
    select coalesce(jsonb_agg(
      jsonb_build_object('name', pipeline_row.name, 'value', pipeline_row.value)
      order by pipeline_row.display_order
    ), '[]'::jsonb)
    into pipeline_result
    from pipeline_rows pipeline_row;

    top_models_result := app_private.sales_consultant_top_models(
      current_organization_id,
      current_user_id,
      allowed_branch_ids,
      month_start,
      month_end,
      previous_month_start
    );
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'generated_at', now(),
    'local_date', local_today,
    'timezone', target_timezone,
    'metrics', jsonb_build_object(
      'leads_assigned_today', jsonb_build_object(
        'value', assigned_current,
        'change', app_private.dashboard_percent_change(assigned_current, assigned_previous),
        'comparison', 'YESTERDAY'
      ),
      'hot_leads', jsonb_build_object(
        'value', hot_current,
        'change', app_private.dashboard_percent_change(hot_current, hot_previous),
        'comparison', 'YESTERDAY'
      ),
      'followups_today', jsonb_build_object(
        'value', followup_current,
        'change', app_private.dashboard_percent_change(followup_current, followup_previous),
        'comparison', 'YESTERDAY'
      ),
      'calls_pending', jsonb_build_object(
        'value', calls_pending_current,
        'change', app_private.dashboard_percent_change(
          calls_pending_current,
          calls_pending_previous
        ),
        'comparison', 'YESTERDAY'
      ),
      'test_drives_today', jsonb_build_object(
        'value', drive_current,
        'change', app_private.dashboard_percent_change(drive_current, drive_previous),
        'comparison', 'YESTERDAY'
      ),
      'quotations_pending', jsonb_build_object(
        'value', quotation_current,
        'change', app_private.dashboard_percent_change(
          quotation_current,
          quotation_previous
        ),
        'comparison', 'YESTERDAY'
      ),
      'bookings_month', jsonb_build_object(
        'value', booking_current,
        'change', app_private.dashboard_percent_change(booking_current, booking_previous),
        'comparison', 'LAST_MONTH'
      ),
      'target_achievement', jsonb_build_object(
        'value', target_current,
        'change', target_current - target_previous,
        'comparison', 'LAST_MONTH'
      )
    ),
    'attention', jsonb_build_array(
      jsonb_build_object('key', 'HOT_NOT_CALLED', 'value', hot_not_called_count),
      jsonb_build_object('key', 'OVERDUE_FOLLOWUPS', 'value', overdue_followup_count),
      jsonb_build_object('key', 'TEST_DRIVE_QUOTATION', 'value', test_drive_without_quote_count),
      jsonb_build_object('key', 'QUOTATION_NO_BOOKING', 'value', quotation_without_booking_count),
      jsonb_build_object('key', 'WAITING_FOR_STOCK', 'value', waiting_for_stock_count)
    ),
    'pipeline', pipeline_result,
    'top_models', top_models_result,
    'alerts', jsonb_build_array(
      jsonb_build_object('key', 'FOLLOWUPS_DUE', 'value', followup_current),
      jsonb_build_object('key', 'TEST_DRIVES_SCHEDULED', 'value', drive_current),
      jsonb_build_object('key', 'QUOTATIONS_AWAITING', 'value', quotation_awaiting_count),
      jsonb_build_object('key', 'INSURANCE_DOCUMENTS', 'value', insurance_pending_count),
      jsonb_build_object('key', 'RTO_PENDING', 'value', rto_pending_count)
    )
  );
end;
$$;

revoke all on function public.get_sales_consultant_dashboard_summary(text)
  from public, anon;
grant execute on function public.get_sales_consultant_dashboard_summary(text)
  to authenticated;

-- Bounded, uncached dashboard data.  This is the only split response that
-- contains customer names or phone numbers.
create or replace function public.get_sales_consultant_dashboard_live(
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
  local_today date;
  today_start timestamptz;
  tomorrow_start timestamptz;
  permission_keys text[];
  can_view_customers boolean;
  can_view_followups boolean;
  can_view_appointments boolean;
  can_view_test_drives boolean;
  can_view_deliveries boolean;
  can_view_bookings boolean;
  schedule_result jsonb := '[]'::jsonb;
  recent_leads_result jsonb := '[]'::jsonb;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_SALES_DASHBOARD_QUERY';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  local_today := timezone(target_timezone, now())::date;
  today_start := timezone(target_timezone, local_today::timestamp);
  tomorrow_start := timezone(target_timezone, (local_today + 1)::timestamp);
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  can_view_customers := 'customer.view' = any(permission_keys);
  can_view_followups := 'followup.view' = any(permission_keys);
  can_view_appointments := 'appointment.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_deliveries :=
    'delivery.view' = any(permission_keys) or 'delivery.manage' = any(permission_keys);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);

  if cardinality(allowed_branch_ids) > 0 then
    select coalesce(jsonb_agg(to_jsonb(schedule_row)
      order by schedule_row.scheduled_at, schedule_row.id), '[]'::jsonb)
    into schedule_result
    from (
      select source_row.*
      from (
        select
          followup_row.id,
          'FOLLOW_UP'::text as kind,
          followup_row.due_at as scheduled_at,
          coalesce(customer_row.full_name, lead_row.customer_name, 'Customer') as customer_name,
          coalesce(lead_row.phone, followup_row.reason) as detail,
          followup_row.status
        from public.followups followup_row
        left join public.customers customer_row
          on customer_row.organization_id = followup_row.organization_id
         and customer_row.id = followup_row.customer_id
         and customer_row.deleted_at is null
        left join public.leads lead_row
          on lead_row.organization_id = followup_row.organization_id
         and lead_row.id = followup_row.lead_id
         and lead_row.deleted_at is null
        where can_view_customers
          and can_view_followups
          and followup_row.organization_id = current_organization_id
          and followup_row.assigned_user_id = current_user_id
          and followup_row.branch_id = any(allowed_branch_ids)
          and followup_row.status in ('OPEN', 'OVERDUE', 'COMPLETED')
          and followup_row.due_at >= today_start
          and followup_row.due_at < tomorrow_start
        union all
        select
          appointment_row.id,
          'SHOWROOM_VISIT'::text,
          appointment_row.scheduled_at,
          customer_row.full_name,
          lead_row.interested_model,
          appointment_row.status
        from public.appointments appointment_row
        join public.customers customer_row
          on customer_row.organization_id = appointment_row.organization_id
         and customer_row.id = appointment_row.customer_id
         and customer_row.deleted_at is null
        left join public.leads lead_row
          on lead_row.organization_id = appointment_row.organization_id
         and lead_row.id = appointment_row.lead_id
         and lead_row.deleted_at is null
        where can_view_customers
          and can_view_appointments
          and appointment_row.organization_id = current_organization_id
          and appointment_row.assigned_user_id = current_user_id
          and appointment_row.branch_id = any(allowed_branch_ids)
          and appointment_row.appointment_type = 'Showroom Visit'
          and appointment_row.status <> 'CANCELLED'
          and appointment_row.scheduled_at >= today_start
          and appointment_row.scheduled_at < tomorrow_start
        union all
        select
          drive_row.id,
          'TEST_DRIVE'::text,
          drive_row.scheduled_at,
          customer_row.full_name,
          coalesce(model_row.name, lead_row.interested_model),
          drive_row.status
        from public.test_drive_appointments drive_row
        join public.customers customer_row
          on customer_row.organization_id = drive_row.organization_id
         and customer_row.id = drive_row.customer_id
         and customer_row.deleted_at is null
        left join public.leads lead_row
          on lead_row.organization_id = drive_row.organization_id
         and lead_row.id = drive_row.lead_id
         and lead_row.deleted_at is null
        left join public.stock_units stock_row
          on stock_row.organization_id = drive_row.organization_id
         and stock_row.id = drive_row.stock_unit_id
         and stock_row.deleted_at is null
        left join public.vehicle_variants variant_row
          on variant_row.organization_id = stock_row.organization_id
         and variant_row.id = stock_row.variant_id
        left join public.vehicle_models model_row
          on model_row.organization_id = variant_row.organization_id
         and model_row.id = variant_row.model_id
        where can_view_customers
          and can_view_test_drives
          and drive_row.organization_id = current_organization_id
          and drive_row.assigned_user_id = current_user_id
          and drive_row.branch_id = any(allowed_branch_ids)
          and drive_row.status <> 'CANCELLED'
          and drive_row.scheduled_at >= today_start
          and drive_row.scheduled_at < tomorrow_start
        union all
        select
          delivery_row.id,
          'DELIVERY'::text,
          delivery_row.scheduled_at,
          customer_row.full_name,
          booking_row.booking_number,
          delivery_row.status
        from public.delivery_cases delivery_row
        join public.bookings booking_row
          on booking_row.organization_id = delivery_row.organization_id
         and booking_row.id = delivery_row.booking_id
         and booking_row.deleted_at is null
        join public.customers customer_row
          on customer_row.organization_id = delivery_row.organization_id
         and customer_row.id = delivery_row.customer_id
         and customer_row.deleted_at is null
        where can_view_customers
          and can_view_deliveries
          and can_view_bookings
          and delivery_row.organization_id = current_organization_id
          and delivery_row.deleted_at is null
          and delivery_row.status <> 'CANCELLED'
          and booking_row.assigned_user_id = current_user_id
          and booking_row.branch_id = any(allowed_branch_ids)
          and delivery_row.scheduled_at >= today_start
          and delivery_row.scheduled_at < tomorrow_start
      ) source_row
      order by source_row.scheduled_at, source_row.id
      limit 8
    ) schedule_row;

    select coalesce(jsonb_agg(to_jsonb(lead_result) - 'updated_at'
      order by lead_result.updated_at desc, lead_result.id desc), '[]'::jsonb)
    into recent_leads_result
    from (
      select
        lead_row.id,
        'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
        lead_row.customer_name,
        lead_row.phone,
        lead_row.interested_model,
        lead_row.next_followup_at,
        lead_row.source,
        lead_row.lifecycle_status::text as lifecycle_status,
        lead_row.temperature::text as temperature,
        lead_row.updated_at
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
      order by lead_row.updated_at desc, lead_row.id desc
      limit 5
    ) lead_result;
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'generated_at', now(),
    'local_date', local_today,
    'timezone', target_timezone,
    'schedule', schedule_result,
    'recent_leads', recent_leads_result
  );
end;
$$;

revoke all on function public.get_sales_consultant_dashboard_live(text)
  from public, anon;
grant execute on function public.get_sales_consultant_dashboard_live(text)
  to authenticated;

-- Backward-compatible composition for callers that have not yet adopted the
-- cache-safe summary/live split.
create or replace function public.get_sales_consultant_dashboard(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return public.get_sales_consultant_dashboard_summary(target_timezone)
    || public.get_sales_consultant_dashboard_live(target_timezone);
end;
$$;

revoke all on function public.get_sales_consultant_dashboard(text) from public, anon;
grant execute on function public.get_sales_consultant_dashboard(text) to authenticated;

-- Personal performance uses one bounded scan per fact table.  Explicit aliases
-- also remove the 42702 ambiguous day_value failure in the previous UNION.
create or replace function public.get_sales_consultant_performance(
  target_days integer default 7,
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
  local_today date;
  start_day date;
  range_start timestamptz;
  range_end timestamptz;
  permission_keys text[];
  can_view_calls boolean;
  can_view_appointments boolean;
  can_view_test_drives boolean;
  can_view_bookings boolean;
  result jsonb;
begin
  if target_days not in (7, 14, 30)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_PERFORMANCE_QUERY';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  local_today := timezone(target_timezone, now())::date;
  start_day := local_today - (target_days - 1);
  range_start := timezone(target_timezone, start_day::timestamp);
  range_end := timezone(target_timezone, (local_today + 1)::timestamp);
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  can_view_calls := 'call.view' = any(permission_keys);
  can_view_appointments := 'appointment.view' = any(permission_keys);
  can_view_test_drives :=
    'test_drive.view' = any(permission_keys) or 'test_drive.manage' = any(permission_keys);
  can_view_bookings :=
    'booking.view' = any(permission_keys) or 'booking.manage' = any(permission_keys);

  with lead_stats as (
    select
      count(*)::bigint as lead_count,
      count(*) filter (where lead_row.first_contacted_at is not null)::bigint as contacted_count,
      coalesce(round(avg(extract(epoch from (
        lead_row.first_contacted_at - lead_row.created_at
      ))) filter (
        where lead_row.first_contacted_at is not null
          and lead_row.first_contacted_at >= lead_row.created_at
      ))::bigint, 0) as average_response_seconds
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.assigned_user_id = current_user_id
      and lead_row.branch_id = any(allowed_branch_ids)
      and lead_row.deleted_at is null
      and lead_row.created_at >= range_start
      and lead_row.created_at < range_end
  ), call_daily as (
    select timezone(target_timezone, call_row.started_at)::date as metric_day,
      count(*)::bigint as call_count,
      count(*) filter (
        where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
      )::bigint as connected_count,
      coalesce(sum(call_row.duration_seconds), 0)::bigint as talk_seconds
    from public.calls call_row
    where can_view_calls
      and call_row.organization_id = current_organization_id
      and call_row.assigned_user_id = current_user_id
      and call_row.branch_id = any(allowed_branch_ids)
      and call_row.started_at >= range_start
      and call_row.started_at < range_end
    group by timezone(target_timezone, call_row.started_at)::date
  ), appointment_daily as (
    select timezone(target_timezone, appointment_row.scheduled_at)::date as metric_day,
      count(*)::bigint as appointment_count
    from public.appointments appointment_row
    where can_view_appointments
      and appointment_row.organization_id = current_organization_id
      and appointment_row.assigned_user_id = current_user_id
      and appointment_row.branch_id = any(allowed_branch_ids)
      and appointment_row.status <> 'CANCELLED'
      and appointment_row.scheduled_at >= range_start
      and appointment_row.scheduled_at < range_end
    group by timezone(target_timezone, appointment_row.scheduled_at)::date
  ), test_drive_daily as (
    select timezone(target_timezone, drive_row.scheduled_at)::date as metric_day,
      count(*)::bigint as test_drive_count
    from public.test_drive_appointments drive_row
    where can_view_test_drives
      and drive_row.organization_id = current_organization_id
      and drive_row.assigned_user_id = current_user_id
      and drive_row.branch_id = any(allowed_branch_ids)
      and drive_row.status <> 'CANCELLED'
      and drive_row.scheduled_at >= range_start
      and drive_row.scheduled_at < range_end
    group by timezone(target_timezone, drive_row.scheduled_at)::date
  ), booking_stats as (
    select count(*)::bigint as booking_count
    from public.bookings booking_row
    where can_view_bookings
      and booking_row.organization_id = current_organization_id
      and booking_row.assigned_user_id = current_user_id
      and booking_row.branch_id = any(allowed_branch_ids)
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= range_start
      and booking_row.created_at < range_end
  ), day_rows as (
    select generated_day.day_timestamp::date as metric_day
    from generate_series(
      start_day::timestamp,
      local_today::timestamp,
      interval '1 day'
    ) generated_day(day_timestamp)
  ), daily_result as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', to_char(day_row.metric_day, 'DD Mon'),
      'calls', coalesce(call_row.call_count, 0),
      'connected', coalesce(call_row.connected_count, 0),
      'appointments', coalesce(appointment_row.appointment_count, 0),
      'test_drives', coalesce(drive_row.test_drive_count, 0)
    ) order by day_row.metric_day), '[]'::jsonb) as data
    from day_rows day_row
    left join call_daily call_row
      on call_row.metric_day = day_row.metric_day
    left join appointment_daily appointment_row
      on appointment_row.metric_day = day_row.metric_day
    left join test_drive_daily drive_row
      on drive_row.metric_day = day_row.metric_day
  ), target_result as (
    select coalesce(jsonb_object_agg(
      lower(target_row.metric), target_row.target_value
      order by target_row.created_at
    ), '{}'::jsonb) as data
    from public.targets target_row
    where target_row.organization_id = current_organization_id
      and target_row.user_id = current_user_id
      and target_row.period_start <= local_today
      and target_row.period_end >= start_day
  )
  select jsonb_build_object(
    'days', target_days,
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', lead_row.lead_count,
      'contacted', lead_row.contacted_count,
      'calls', coalesce((select sum(call_source.call_count) from call_daily call_source), 0),
      'connected_calls', coalesce((select sum(call_source.connected_count) from call_daily call_source), 0),
      'talk_seconds', coalesce((select sum(call_source.talk_seconds) from call_daily call_source), 0),
      'appointments', coalesce((select sum(appointment_source.appointment_count) from appointment_daily appointment_source), 0),
      'test_drives', coalesce((select sum(drive_source.test_drive_count) from test_drive_daily drive_source), 0),
      'bookings', booking_row.booking_count,
      'average_response_seconds', lead_row.average_response_seconds
    ),
    'daily', daily_row.data,
    'targets', target_row.data
  )
  into result
  from lead_stats lead_row
  cross join booking_stats booking_row
  cross join daily_result daily_row
  cross join target_result target_row;

  return result;
end;
$$;

revoke all on function public.get_sales_consultant_performance(integer, text)
  from public, anon;
grant execute on function public.get_sales_consultant_performance(integer, text)
  to authenticated;

-- object_files stores the original client name in original_file_name.  Repair
-- the deployed exchange function without copying its transactional mutation
-- sibling or introducing a duplicate compatibility column.
do $migration$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'public.get_sales_exchange_options(text,integer)'::regprocedure
  )
  into function_definition;

  if position('file_row.file_name' in function_definition) > 0 then
    execute replace(
      function_definition,
      'file_row.file_name',
      'coalesce(file_row.original_file_name, ''Document'')'
    );
  end if;
end;
$migration$;

-- Re-deploy and optimize the Sales Consultant activity surface.  The prior
-- implementation called can_access_lead once per owned lead, materialized the
-- user's complete history, ranked it, and only then applied OFFSET.
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
  consultant_name_value text;
begin
  if char_length(normalized_search) > 160
    or normalized_kind not in (
      'ALL', 'CALL', 'MESSAGE', 'FOLLOW_UP', 'TEST_DRIVE',
      'QUOTATION', 'TASK', 'APPOINTMENT', 'NOTE', 'OTHER'
    )
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort not in ('latest:desc', 'oldest:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
  then
    raise exception using errcode = '22023', message = 'INVALID_SALES_ACTIVITY_QUERY';
  end if;

  current_organization_id := app_private.sales_consultant_organization();
  permission_keys := app_private.sales_consultant_permissions(current_organization_id);
  if not ('customer.view' = any(permission_keys)) then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;
  allowed_branch_ids := app_private.sales_consultant_allowed_branches(current_organization_id);
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  summary_start := timezone(
    target_timezone,
    (timezone(target_timezone, now())::date - 6)::timestamp
  );

  select profile_row.full_name
  into consultant_name_value
  from public.profiles profile_row
  where profile_row.organization_id = current_organization_id
    and profile_row.id = current_user_id;

  if cardinality(allowed_branch_ids) > 0 then
    with owned_leads as (
      select lead_row.id, lead_row.customer_id,
        'LID' || upper(substr(replace(lead_row.id::text, '-', ''), 1, 7)) as reference,
        lead_row.interested_model
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
    ), activity_base as (
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
      join owned_leads lead_row
        on lead_row.id = activity_row.lead_id
      join public.customers customer_row
        on customer_row.organization_id = activity_row.organization_id
       and customer_row.id = activity_row.customer_id
       and customer_row.deleted_at is null
      left join public.profiles actor_row
        on actor_row.organization_id = activity_row.organization_id
       and actor_row.id = activity_row.actor_id
      where activity_row.organization_id = current_organization_id
    ), filtered as (
      select activity_row.*
      from activity_base activity_row
      where (normalized_kind = 'ALL' or activity_row.activity_kind = normalized_kind)
        and (
          normalized_search = ''
          or position(normalized_search in lower(activity_row.customer_name)) > 0
          or position(normalized_search in lower(activity_row.lead_reference)) > 0
          or position(
            normalized_search in lower(coalesce(activity_row.interested_model, ''))
          ) > 0
          or position(normalized_search in lower(coalesce(activity_row.detail, ''))) > 0
          or (
            search_phone_digits <> ''
            and app_private.normalize_phone_digits(activity_row.customer_phone)
              = search_phone_digits
          )
        )
    ), page_rows as (
      select filtered_row.*
      from filtered filtered_row
      order by
        case when target_sort = 'latest:desc' then filtered_row.occurred_at end desc,
        case when target_sort = 'oldest:asc' then filtered_row.occurred_at end asc,
        filtered_row.id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    )
    select
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', page_row.id,
          'activity_type', page_row.activity_type,
          'activity_kind', page_row.activity_kind,
          'detail', page_row.detail,
          'occurred_at', page_row.occurred_at,
          'customer_name', page_row.customer_name,
          'customer_phone', page_row.customer_phone,
          'lead_reference', page_row.lead_reference,
          'interested_model', page_row.interested_model,
          'actor_name', page_row.actor_name
        ) order by
          case when target_sort = 'latest:desc' then page_row.occurred_at end desc,
          case when target_sort = 'oldest:asc' then page_row.occurred_at end asc,
          page_row.id desc)
        from page_rows page_row
      ), '[]'::jsonb),
      (select count(*) from filtered)
    into page_result, total_result;

    with owned_leads as (
      select lead_row.id
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
    ), recent_activity as (
      select case
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
    )
    select
      count(*) filter (where activity_row.activity_kind = 'CALL'),
      count(*) filter (where activity_row.activity_kind = 'MESSAGE'),
      count(*) filter (where activity_row.activity_kind = 'FOLLOW_UP'),
      count(*) filter (where activity_row.activity_kind = 'TEST_DRIVE'),
      count(*) filter (where activity_row.activity_kind = 'QUOTATION'),
      count(*) filter (where activity_row.activity_kind = 'NOTE')
    into
      calls_count,
      messages_count,
      followups_count,
      test_drives_count,
      quotations_count,
      notes_count
    from recent_activity activity_row;

    if 'followup.view' = any(permission_keys) then
      with owned_leads as (
        select lead_row.id, lead_row.interested_model
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.assigned_user_id = current_user_id
          and lead_row.branch_id = any(allowed_branch_ids)
          and lead_row.deleted_at is null
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', followup_source.id,
        'customer_name', followup_source.customer_name,
        'detail', coalesce(
          nullif(btrim(followup_source.reason), ''),
          followup_source.interested_model
        ),
        'due_at', followup_source.due_at,
        'priority', followup_source.priority
      ) order by followup_source.due_at, followup_source.id), '[]'::jsonb)
      into upcoming_followups_result
      from (
        select followup_row.id, followup_row.reason, followup_row.due_at,
          followup_row.priority, lead_row.interested_model,
          customer_row.full_name as customer_name
        from public.followups followup_row
        join owned_leads lead_row on lead_row.id = followup_row.lead_id
        join public.customers customer_row
          on customer_row.organization_id = followup_row.organization_id
         and customer_row.id = followup_row.customer_id
         and customer_row.deleted_at is null
        where followup_row.organization_id = current_organization_id
          and followup_row.assigned_user_id = current_user_id
          and followup_row.branch_id = any(allowed_branch_ids)
          and followup_row.status in ('OPEN', 'OVERDUE')
          and followup_row.due_at >= now()
        order by followup_row.due_at, followup_row.id
        limit 4
      ) followup_source;
    end if;

    with owned_customers as (
      select distinct lead_row.customer_id
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = current_user_id
        and lead_row.branch_id = any(allowed_branch_ids)
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
      select note_row.id, note_row.body, note_row.created_at,
        customer_row.full_name as customer_name
      from public.notes note_row
      join owned_customers customer_scope
        on customer_scope.customer_id = note_row.resource_id
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
  end if;

  return jsonb_build_object(
    'organization_id', current_organization_id,
    'consultant_name', coalesce(consultant_name_value, 'Sales Consultant'),
    'records', page_result,
    'total', total_result,
    'summary', jsonb_build_object(
      'calls', calls_count,
      'messages', messages_count,
      'followups', followups_count,
      'test_drives', test_drives_count,
      'quotations', quotations_count,
      'notes', notes_count
    ),
    'upcoming_followups', upcoming_followups_result,
    'recent_notes', recent_notes_result
  );
end;
$$;

revoke all on function public.get_sales_consultant_activity_timeline(
  text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.get_sales_consultant_activity_timeline(
  text, text, integer, integer, text, text
) to authenticated;

commit;
