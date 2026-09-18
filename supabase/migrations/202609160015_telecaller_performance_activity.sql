-- Personal Telecaller reporting uses dated actor evidence, never current lead ownership.
create index if not exists activities_personal_performance_idx
  on public.activities (organization_id, actor_id, occurred_at)
  where activity_type in ('TELECALLER_CONTACTED', 'FOLLOWUP_COMPLETED');
create index if not exists lead_stage_personal_performance_idx
  on public.lead_stage_history (organization_id, changed_by, created_at);
create index if not exists calls_personal_performance_idx
  on public.calls (organization_id, assigned_user_id, started_at);

create or replace function public.get_telecaller_performance(
  target_days integer default 7,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  ctx jsonb := public.get_access_context();
  org uuid;
  actor uuid := auth.uid();
  branches uuid[];
  today date;
  first_day date;
  range_start timestamptz;
  range_end timestamptz;
  result jsonb;
begin
  if target_days is null or target_days not in (7,14,30)
    or target_timezone is null or target_timezone not in ('Asia/Kolkata','UTC') then
    raise exception using errcode = '22023', message = 'INVALID_PERFORMANCE_QUERY';
  end if;
  if actor is null or ctx->>'destination' is distinct from 'CRM'
    or ctx->>'role_key' is distinct from 'telecaller'
    or ctx->>'data_scope' is distinct from 'OWN_RECORDS'
    or ctx->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'PERSONAL_PERFORMANCE_ACCESS_REQUIRED';
  end if;
  org := (ctx->>'organization_id')::uuid;
  if not app_private.has_permission(org, 'lead.view') then
    raise exception using errcode = '42501', message = 'LEAD_VIEW_PERMISSION_REQUIRED';
  end if;
  branches := app_private.sales_consultant_allowed_branches(org);
  if coalesce(cardinality(branches),0) = 0 then
    raise exception using errcode = '42501', message = 'PERSONAL_PERFORMANCE_SCOPE_DENIED';
  end if;
  today := timezone(target_timezone, now())::date;
  first_day := today - (target_days - 1);
  range_start := timezone(target_timezone, first_day::timestamp);
  range_end := least(now(), timezone(target_timezone, (today + 1)::timestamp));

  with call_events as materialized (
    select c.lead_id, c.started_at, upper(coalesce(c.outcome,'')) = 'CONNECTED' as connected,
      coalesce(c.duration_seconds,0) as seconds
    from public.calls c
    where c.organization_id = org and c.assigned_user_id = actor
      and c.branch_id = any(branches)
      and app_private.has_permission(org, 'call.view')
      and c.started_at >= range_start and c.started_at <= range_end
  ), stage_events as materialized (
    select h.lead_id, h.to_status, h.created_at
    from public.lead_stage_history h
    join public.leads l on l.id = h.lead_id and l.organization_id = h.organization_id
    where h.organization_id = org and h.changed_by = actor
      and l.branch_id = any(branches) and l.deleted_at is null
      and h.created_at >= range_start and h.created_at <= range_end
  ), contact_ids as (
    select c.lead_id from call_events c
    join public.leads l on l.id = c.lead_id and l.organization_id = org
    where c.connected and l.deleted_at is null and l.branch_id = any(branches)
    union
    select lead_id from stage_events where to_status = 'Contacted'
    union
    select a.lead_id from public.activities a
    join public.leads l on l.id = a.lead_id and l.organization_id = a.organization_id
    where a.organization_id = org and a.actor_id = actor
      and a.activity_type = 'TELECALLER_CONTACTED'
      and l.branch_id = any(branches) and l.deleted_at is null
      and a.occurred_at >= range_start and a.occurred_at <= range_end
  ), assigned_ids as (
    select h.lead_id from public.lead_assignment_history h
    join public.leads l on l.id = h.lead_id and l.organization_id = h.organization_id
    where h.organization_id = org and h.new_owner_id = actor
      and h.branch_id = any(branches) and l.branch_id = any(branches) and l.deleted_at is null
      and h.created_at >= range_start and h.created_at <= range_end
    union
    -- Legacy/directly-created leads can lack an initial assignment event.
    select l.id from public.leads l
    where l.organization_id = org and l.assigned_user_id = actor
      and l.branch_id = any(branches) and l.deleted_at is null
      and l.created_at >= range_start and l.created_at <= range_end
      and not exists (select 1 from public.lead_assignment_history h
        where h.organization_id = org and h.lead_id = l.id)
    union
    -- Preserve that initial owner after the first handoff/reassignment as well.
    select l.id from public.leads l
    join lateral (
      select h.previous_owner_id from public.lead_assignment_history h
      where h.organization_id = org and h.lead_id = l.id
      order by h.created_at, h.id limit 1
    ) initial on initial.previous_owner_id = actor
    where l.organization_id = org and l.branch_id = any(branches) and l.deleted_at is null
      and l.created_at >= range_start and l.created_at <= range_end
  ), followup_events as materialized (
    select distinct f.id, f.completed_at
    from public.activities a
    join public.followups f on f.id::text = a.metadata->>'followup_id'
      and f.organization_id = a.organization_id
    where a.organization_id = org and a.actor_id = actor
      and a.activity_type = 'FOLLOWUP_COMPLETED'
      and app_private.has_permission(org, 'followup.view')
      and f.branch_id = any(branches) and f.status = 'COMPLETED'
      and f.completed_at >= range_start and f.completed_at <= range_end
      and a.occurred_at >= range_start and a.occurred_at <= range_end
  ), daily as (
    select day::date as metric_day from generate_series(first_day::timestamp, today::timestamp, interval '1 day') day
  ), daily_calls as (
    select timezone(target_timezone, started_at)::date as metric_day,
      count(*) as calls, count(*) filter (where connected) as connected
    from call_events group by 1
  ), daily_followups as (
    select timezone(target_timezone, completed_at)::date as metric_day, count(*) as completed
    from followup_events group by 1
  ), daily_handoffs as (
    select timezone(target_timezone, created_at)::date as metric_day, count(distinct lead_id) as transferred
    from stage_events where to_status = 'Transferred to Sales' group by 1
  ), matching_targets as (
    -- Do not compare a rolling week against a full monthly target or silently
    -- choose one of several overlapping periods. Only exact periods are comparable.
    select distinct on (lower(t.metric)) lower(t.metric) as metric, t.target_value
    from public.targets t
    where t.organization_id = org and t.user_id = actor
      and (t.branch_id is null or t.branch_id = any(branches))
      and t.period_start = first_day and t.period_end = today
    order by lower(t.metric), t.created_at desc, t.id desc
  )
  select jsonb_build_object(
    'days', target_days, 'generated_at', now(),
    'kpis', jsonb_build_object(
      'leads', (select count(*) from assigned_ids),
      'contacted', (select count(*) from contact_ids),
      'calls', (select count(*) from call_events),
      'connected_calls', (select count(*) from call_events where connected),
      'talk_seconds', (select coalesce(sum(seconds) filter (where connected),0) from call_events),
      'qualified', (select count(distinct lead_id) from stage_events where to_status in ('Qualified','Transferred to Sales')),
      'transferred', (select count(distinct lead_id) from stage_events where to_status = 'Transferred to Sales'),
      'followups_completed', (select count(*) from followup_events)
    ),
    'daily', (select jsonb_agg(jsonb_build_object(
      'name', to_char(d.metric_day,'DD Mon'),
      'calls', coalesce(c.calls,0), 'connected', coalesce(c.connected,0),
      'followups_completed', coalesce(f.completed,0), 'transferred', coalesce(h.transferred,0)
    ) order by d.metric_day) from daily d
      left join daily_calls c using (metric_day)
      left join daily_followups f using (metric_day)
      left join daily_handoffs h using (metric_day)),
    'targets', (select coalesce(jsonb_object_agg(metric,target_value),'{}'::jsonb) from matching_targets)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_telecaller_performance(integer,text) from public, anon;
grant execute on function public.get_telecaller_performance(integer,text) to authenticated;
