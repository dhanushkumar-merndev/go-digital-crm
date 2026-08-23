-- A focused lead-detail read model. The UI never reads a tenant-wide lead
-- dataset here: every section is bounded and authorization is rechecked from
-- the lead as the parent resource.

create index if not exists lead_stage_history_detail_idx
  on public.lead_stage_history (organization_id, lead_id, created_at desc, id desc);
create index if not exists lead_temperature_history_detail_idx
  on public.lead_temperature_history (organization_id, lead_id, created_at desc, id desc);
create index if not exists lead_assignment_history_detail_idx
  on public.lead_assignment_history (organization_id, lead_id, created_at desc, id desc);
create index if not exists followups_detail_lead_due_idx
  on public.followups (organization_id, lead_id, due_at, id)
  where lead_id is not null;
create index if not exists appointments_detail_lead_scheduled_idx
  on public.appointments (organization_id, lead_id, scheduled_at, id)
  where lead_id is not null;

create or replace function public.get_lead_detail_workspace(target_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  lead_data jsonb;
  followups_data jsonb := '[]'::jsonb;
  calls_data jsonb := '[]'::jsonb;
  timeline_data jsonb := '[]'::jsonb;
  latest_ai_summary text := null;
  followup_count bigint := 0;
  call_count bigint := 0;
  conversation_count bigint := 0;
  appointment_count bigint := 0;
  can_followups boolean := false;
  can_calls boolean := false;
  can_messages boolean := false;
  can_appointments boolean := false;
  can_update boolean := false;
begin
  if auth.uid() is null or target_lead_id is null
    or not app_private.can_access_lead(target_lead_id) then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  can_followups := app_private.has_permission(lead_row.organization_id, 'followup.view');
  can_calls := app_private.has_permission(lead_row.organization_id, 'call.view');
  can_messages := app_private.has_permission(lead_row.organization_id, 'message.view');
  can_appointments := app_private.has_permission(lead_row.organization_id, 'appointment.view')
    and lead_row.customer_id is not null;
  can_update := app_private.has_permission(lead_row.organization_id, 'lead.update');

  select jsonb_build_object(
    'id', lead_row.id,
    'organization_id', lead_row.organization_id,
    'branch_id', lead_row.branch_id,
    'branch_name', branch_row.name,
    'team_id', lead_row.team_id,
    'team_name', team_row.name,
    'customer_id', lead_row.customer_id,
    'customer_name', lead_row.customer_name,
    'phone', lead_row.phone,
    'email', lead_row.email,
    'source', lead_row.source,
    'source_detail', lead_row.source_detail,
    'campaign', lead_row.campaign,
    'interested_model', lead_row.interested_model,
    'lifecycle_status', lead_row.lifecycle_status,
    'temperature', lead_row.temperature,
    'work_state', case
      when lead_row.first_contacted_at is null and lead_row.sla_due_at is not null
        and now() > lead_row.sla_due_at then 'SLA_RISK'
      when lead_row.first_contacted_at is null and now() >= lead_row.created_at + interval '24 hours'
        then 'PENDING'
      when lead_row.first_contacted_at is null then 'NEW_TODAY'
      else null
    end,
    'assigned_user_id', lead_row.assigned_user_id,
    'assigned_user_name', profile_row.full_name,
    'first_contacted_at', lead_row.first_contacted_at,
    'next_followup_at', lead_row.next_followup_at,
    'sla_due_at', lead_row.sla_due_at,
    'lost_reason', lead_row.lost_reason,
    'created_at', lead_row.created_at,
    'updated_at', lead_row.updated_at
  ) into lead_data
  from public.branches branch_row
  left join public.teams team_row
    on team_row.organization_id = lead_row.organization_id and team_row.id = lead_row.team_id
  left join public.profiles profile_row
    on profile_row.organization_id = lead_row.organization_id and profile_row.id = lead_row.assigned_user_id
  where branch_row.organization_id = lead_row.organization_id and branch_row.id = lead_row.branch_id;

  if can_followups then
    select count(*) into followup_count
    from public.followups followup_row
    where followup_row.organization_id = lead_row.organization_id
      and followup_row.lead_id = lead_row.id
      and app_private.can_access_record(
        followup_row.organization_id, followup_row.branch_id, followup_row.team_id,
        followup_row.assigned_user_id
      );

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.due_at asc, item.id asc), '[]'::jsonb)
    into followups_data
    from (
      select followup_row.id, followup_row.reason, followup_row.priority, followup_row.due_at,
        followup_row.status, profile_row.full_name as assigned_user_name
      from public.followups followup_row
      left join public.profiles profile_row
        on profile_row.organization_id = followup_row.organization_id
       and profile_row.id = followup_row.assigned_user_id
      where followup_row.organization_id = lead_row.organization_id
        and followup_row.lead_id = lead_row.id
        and app_private.can_access_record(
          followup_row.organization_id, followup_row.branch_id, followup_row.team_id,
          followup_row.assigned_user_id
        )
      order by
        case when followup_row.status in ('OPEN', 'OVERDUE') then 0 else 1 end,
        followup_row.due_at asc, followup_row.id asc
      limit 8
    ) item;
  end if;

  if can_calls then
    select count(*) into call_count
    from public.calls call_row
    where call_row.organization_id = lead_row.organization_id
      and call_row.lead_id = lead_row.id
      and app_private.can_access_call(call_row.organization_id, call_row.id);

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.started_at desc, item.id desc), '[]'::jsonb)
    into calls_data
    from (
      select call_row.id, call_row.direction, call_row.call_source, call_row.started_at,
        call_row.duration_seconds, call_row.outcome, call_row.status,
        profile_row.full_name as assigned_user_name
      from public.calls call_row
      left join public.profiles profile_row
        on profile_row.organization_id = call_row.organization_id
       and profile_row.id = call_row.assigned_user_id
      where call_row.organization_id = lead_row.organization_id
        and call_row.lead_id = lead_row.id
        and app_private.can_access_call(call_row.organization_id, call_row.id)
      order by call_row.started_at desc, call_row.id desc
      limit 8
    ) item;

    select summary_row.summary into latest_ai_summary
    from public.ai_call_summaries summary_row
    join public.calls call_row
      on call_row.organization_id = summary_row.organization_id and call_row.id = summary_row.call_id
    where summary_row.organization_id = lead_row.organization_id
      and call_row.lead_id = lead_row.id
      and app_private.can_access_call(call_row.organization_id, call_row.id)
    order by summary_row.created_at desc, summary_row.id desc
    limit 1;
  end if;

  if can_messages then
    select count(*) into conversation_count
    from public.conversations conversation_row
    where conversation_row.organization_id = lead_row.organization_id
      and conversation_row.lead_id = lead_row.id
      and app_private.can_access_conversation(conversation_row.organization_id, conversation_row.id);
  end if;

  if can_appointments then
    select count(*) into appointment_count
    from public.appointments appointment_row
    where appointment_row.organization_id = lead_row.organization_id
      and appointment_row.lead_id = lead_row.id
      and app_private.can_access_record(
        appointment_row.organization_id, appointment_row.branch_id, appointment_row.team_id,
        appointment_row.assigned_user_id
      );
  end if;

  select coalesce(jsonb_agg(to_jsonb(item)
    order by item.occurred_at desc, item.id desc), '[]'::jsonb)
  into timeline_data
  from (
    select item.* from (
      select stage_row.id, stage_row.created_at as occurred_at, 'stage'::text as kind,
        'Lead stage updated'::text as title,
        concat_ws(' → ', stage_row.from_status::text, stage_row.to_status::text) as detail
      from public.lead_stage_history stage_row
      where stage_row.organization_id = lead_row.organization_id and stage_row.lead_id = lead_row.id
      union all
      select temperature_row.id, temperature_row.created_at, 'temperature'::text,
        'Lead temperature updated'::text,
        concat_ws(' → ', temperature_row.from_temperature::text, temperature_row.to_temperature::text)
      from public.lead_temperature_history temperature_row
      where temperature_row.organization_id = lead_row.organization_id and temperature_row.lead_id = lead_row.id
      union all
      select assignment_row.id, assignment_row.created_at, 'assignment'::text,
        'Lead assignment updated'::text,
        coalesce(assignment_row.reason, 'Assignment changed')
      from public.lead_assignment_history assignment_row
      where assignment_row.organization_id = lead_row.organization_id and assignment_row.lead_id = lead_row.id
      union all
      select activity_row.id, activity_row.occurred_at, 'activity'::text,
        activity_row.activity_type, coalesce(activity_row.metadata->>'summary', '')
      from public.activities activity_row
      where activity_row.organization_id = lead_row.organization_id and activity_row.lead_id = lead_row.id
    ) item
    order by item.occurred_at desc, item.id desc
    limit 20
  ) item;

  return jsonb_build_object(
    'lead', lead_data,
    'access', jsonb_build_object(
      'can_update', can_update,
      'can_followups', can_followups,
      'can_calls', can_calls,
      'can_messages', can_messages,
      'can_appointments', can_appointments
    ),
    'counts', jsonb_build_object(
      'calls', call_count,
      'messages', conversation_count,
      'followups', followup_count,
      'appointments', appointment_count
    ),
    'followups', followups_data,
    'calls', calls_data,
    'timeline', timeline_data,
    'latest_ai_summary', latest_ai_summary
  );
end;
$$;

revoke all on function public.get_lead_detail_workspace(uuid) from public, anon;
grant execute on function public.get_lead_detail_workspace(uuid) to authenticated;
