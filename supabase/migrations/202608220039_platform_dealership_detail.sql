begin;

create or replace function public.get_platform_dealership_detail(target_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  organization_row record;
  local_today date := timezone('Asia/Kolkata', now())::date;
  week_start timestamptz;
  week_end timestamptz;
begin
  if auth.uid() is null
    or target_organization_id is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_DEALERSHIP_DETAIL_ACCESS_REQUIRED';
  end if;

  select
    organization_source.id,
    organization_source.name,
    organization_source.slug,
    organization_source.legal_name,
    organization_source.gst_number,
    organization_source.status,
    organization_source.primary_owner_id,
    organization_source.created_at
  into organization_row
  from public.organizations
  organization_source
  where organization_source.id = target_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'PLATFORM_DEALERSHIP_NOT_FOUND';
  end if;

  week_start := timezone('Asia/Kolkata', (local_today - 6)::timestamp);
  week_end := timezone('Asia/Kolkata', (local_today + 1)::timestamp);

  return (
    with owner_row as materialized (
      select profile_row.full_name, profile_row.email, profile_row.phone
      from public.profiles profile_row
      where profile_row.id = organization_row.primary_owner_id
        and profile_row.organization_id = organization_row.id
        and profile_row.deleted_at is null
      limit 1
    ), active_branches as materialized (
      select branch_row.id, branch_row.name, branch_row.code
      from public.branches branch_row
      where branch_row.organization_id = organization_row.id
        and branch_row.active
        and branch_row.deleted_at is null
    ), active_users as materialized (
      select profile_row.id
      from public.profiles profile_row
      where profile_row.organization_id = organization_row.id
        and profile_row.active
        and profile_row.deleted_at is null
    ), weekly_leads as materialized (
      select lead_row.id, lead_row.branch_id, lead_row.source, lead_row.created_at
      from public.leads lead_row
      where lead_row.organization_id = organization_row.id
        and lead_row.deleted_at is null
        and lead_row.created_at >= week_start
        and lead_row.created_at < week_end
    ), weekly_bookings as materialized (
      select booking_row.id, booking_row.branch_id, booking_row.created_at
      from public.bookings booking_row
      where booking_row.organization_id = organization_row.id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and booking_row.created_at >= week_start
        and booking_row.created_at < week_end
    ), branch_users as materialized (
      select access_row.branch_id, count(distinct access_row.user_id)::integer as user_count
      from public.user_branch_access access_row
      join active_branches branch_row on branch_row.id = access_row.branch_id
      join active_users user_row on user_row.id = access_row.user_id
      where access_row.organization_id = organization_row.id
      group by access_row.branch_id
    ), branch_leads as materialized (
      select branch_id, count(*)::integer as lead_count
      from weekly_leads
      group by branch_id
    ), day_rows as materialized (
      select (local_today - offset_days)::date as metric_day
      from generate_series(6, 0, -1) as offsets(offset_days)
    ), daily as materialized (
      select metric_day,
        coalesce((select count(*)::integer from weekly_leads lead_row where lead_row.created_at >= timezone('Asia/Kolkata', metric_day::timestamp) and lead_row.created_at < timezone('Asia/Kolkata', (metric_day + 1)::timestamp)), 0) as leads,
        coalesce((select count(*)::integer from weekly_bookings booking_row where booking_row.created_at >= timezone('Asia/Kolkata', metric_day::timestamp) and booking_row.created_at < timezone('Asia/Kolkata', (metric_day + 1)::timestamp)), 0) as bookings
      from day_rows
    )
    select jsonb_build_object(
      'organization', jsonb_build_object(
        'id', organization_row.id,
        'name', organization_row.name,
        'slug', organization_row.slug,
        'legal_name', organization_row.legal_name,
        'gst_number', organization_row.gst_number,
        'status', organization_row.status,
        'created_at', organization_row.created_at,
        'owner_name', (select full_name from owner_row),
        'owner_email', (select email from owner_row),
        'owner_phone', (select phone from owner_row)
      ),
      'kpis', jsonb_build_object(
        'branches', (select count(*)::integer from active_branches),
        'users', (select count(*)::integer from active_users),
        'leads_this_week', (select count(*)::integer from weekly_leads),
        'bookings_this_week', (select count(*)::integer from weekly_bookings),
        'enabled_modules', (
          select count(*)::integer
          from public.organization_module_entitlements entitlement_row
          where entitlement_row.organization_id = organization_row.id
            and entitlement_row.enabled
            and (entitlement_row.valid_until is null or entitlement_row.valid_until > now())
        )
      ),
      'daily', coalesce((select jsonb_agg(jsonb_build_object(
        'name', to_char(metric_day, 'DD Mon'), 'leads', leads, 'bookings', bookings
      ) order by metric_day) from daily), '[]'::jsonb),
      'lead_sources', coalesce((select jsonb_agg(jsonb_build_object(
        'name', source, 'value', lead_count
      ) order by lead_count desc, source) from (
        select coalesce(nullif(btrim(source), ''), 'Other') as source, count(*)::integer as lead_count
        from weekly_leads
        group by coalesce(nullif(btrim(source), ''), 'Other')
        order by lead_count desc, source
        limit 8
      ) source_rows), '[]'::jsonb),
      'branches', coalesce((select jsonb_agg(jsonb_build_object(
        'id', branch_row.id, 'name', branch_row.name, 'code', branch_row.code,
        'users', coalesce(branch_user_row.user_count, 0),
        'leads_this_week', coalesce(branch_lead_row.lead_count, 0)
      ) order by branch_row.name, branch_row.id)
      from active_branches branch_row
      left join branch_users branch_user_row on branch_user_row.branch_id = branch_row.id
      left join branch_leads branch_lead_row on branch_lead_row.branch_id = branch_row.id), '[]'::jsonb),
      'recent_activity', coalesce((select jsonb_agg(jsonb_build_object(
        'id', audit_row.id, 'action', audit_row.action, 'resource_type', audit_row.resource_type,
        'summary', coalesce(audit_row.metadata->>'safe_message', audit_row.metadata->>'summary', audit_row.metadata->>'reason'),
        'created_at', audit_row.created_at
      ) order by audit_row.created_at desc, audit_row.id desc)
      from (
        select id, action, resource_type, metadata, created_at
        from public.audit_logs
        where organization_id = organization_row.id
        order by created_at desc, id desc
        limit 8
      ) audit_row), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_platform_dealership_detail(uuid) from public, anon;
grant execute on function public.get_platform_dealership_detail(uuid) to authenticated;

commit;
