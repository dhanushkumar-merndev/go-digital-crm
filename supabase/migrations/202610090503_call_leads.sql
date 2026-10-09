begin;

-- One call, several enquiries. A customer with two open leads is usually
-- talked to about both in one call; the caller can now say so.
--
-- call_leads holds the extra leads a call covered (the call's own lead stays
-- calls.lead_id). set_call_leads edits the set -- the caller's own leads on the
-- same customer or mobile only -- writing CALL_LINKED / CALL_UNLINKED
-- activities and an audit row. get_call_lead_options lists the candidates.
--
-- Lead-level call readers (lead detail, journey, activity tab, latest call
-- summary) now include linked calls through app_private.lead_call_ids. Call
-- lists and call KPIs read public.calls directly, so a call still counts once.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

create table if not exists public.call_leads (
  organization_id uuid not null references public.organizations(id),
  call_id uuid not null references public.calls(id) on delete cascade,
  lead_id uuid not null references public.leads(id),
  linked_by uuid references public.profiles(id),
  linked_at timestamptz not null default now(),
  primary key (call_id, lead_id)
);

create index if not exists call_leads_org_lead_idx
  on public.call_leads (organization_id, lead_id, linked_at desc);

alter table public.call_leads enable row level security;

drop policy if exists call_leads_select on public.call_leads;
create policy call_leads_select on public.call_leads
  for select to authenticated
  using (
    app_private.can_access_call(organization_id, call_id)
    or app_private.can_access_lead(lead_id)
  );

-- Writes only through set_call_leads.
revoke all on public.call_leads from public, anon, authenticated;
grant select on public.call_leads to authenticated;

-- Every call a lead's history should show: the calls placed on it, plus calls
-- placed on a sibling enquiry that the caller said also covered this one.
-- Readers match `call_row.id = any(...)` so the lookup stays on primary keys.
CREATE OR REPLACE FUNCTION app_private.lead_call_ids(target_organization_id uuid, target_lead_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(array_agg(distinct linked.call_id), '{}'::uuid[])
  from (
    select call_row.id as call_id
    from public.calls call_row
    where call_row.organization_id = target_organization_id
      and call_row.lead_id = target_lead_id
    union all
    select link_row.call_id
    from public.call_leads link_row
    where link_row.organization_id = target_organization_id
      and link_row.lead_id = target_lead_id
  ) linked;
$function$;
revoke all on function app_private.lead_call_ids(uuid, uuid) from public, anon;
grant execute on function app_private.lead_call_ids(uuid, uuid) to authenticated;

-- The caller's own leads on the same customer or mobile as target_lead_id,
-- the ones a call on it may also cover. With target_call_id, `linked` says
-- which are attached to that call now.
CREATE OR REPLACE FUNCTION public.get_call_lead_options(target_lead_id uuid, target_call_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  anchor public.leads%rowtype;
  call_row public.calls%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  select lead_row.* into anchor
  from public.leads lead_row
  where lead_row.id = target_lead_id
    and lead_row.organization_id = app_private.current_tenant_organization()
    and lead_row.deleted_at is null;
  if not found or not app_private.can_access_lead(anchor.id) then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if target_call_id is not null then
    select * into call_row
    from public.calls
    where id = target_call_id
      and organization_id = anchor.organization_id
      and lead_id = anchor.id;
    if not found or not app_private.can_access_call(anchor.organization_id, target_call_id) then
      raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
    end if;
  end if;

  return jsonb_build_object(
    'call_id', target_call_id,
    'can_edit', target_call_id is null or call_row.assigned_user_id = auth.uid(),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lead_id', lead_row.id,
        'interested_model', lead_row.interested_model,
        'lifecycle_status', lead_row.lifecycle_status,
        'source', lead_row.source,
        'created_at', lead_row.created_at,
        'is_primary', lead_row.id = anchor.id,
        'linked', lead_row.id = anchor.id or exists (
          select 1 from public.call_leads link_row
          where link_row.call_id = target_call_id and link_row.lead_id = lead_row.id
        )
      ) order by (lead_row.id = anchor.id) desc, lead_row.created_at desc, lead_row.id)
      from public.leads lead_row
      where lead_row.organization_id = anchor.organization_id
        and lead_row.deleted_at is null
        and (
          lead_row.id = anchor.id
          or (
            lead_row.assigned_user_id = auth.uid()
            and (
              (nullif(anchor.normalized_phone, '') is not null
                and lead_row.normalized_phone = anchor.normalized_phone)
              or (anchor.customer_id is not null and lead_row.customer_id = anchor.customer_id)
            )
          )
        )
      limit 20
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_call_lead_options(uuid, uuid) from public, anon;
grant execute on function public.get_call_lead_options(uuid, uuid) to authenticated;

-- Sets which other leads a call also covers. The call's own lead is always
-- included and cannot be removed. Only the person who made the call may change
-- it, and only to their own leads on the same customer or mobile. Replays are
-- no-ops.
CREATE OR REPLACE FUNCTION public.set_call_leads(target_call_id uuid, target_lead_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  call_row public.calls%rowtype;
  anchor public.leads%rowtype;
  requested uuid[];
  added uuid[];
  removed uuid[];
  changed_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  select * into call_row
  from public.calls
  where id = target_call_id
    and organization_id = current_organization_id
  for update;
  if not found or not app_private.can_access_call(current_organization_id, target_call_id) then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if call_row.assigned_user_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'CALL_OWNER_REQUIRED';
  end if;
  if call_row.lead_id is null then
    raise exception using errcode = '23514', message = 'CALL_HAS_NO_LEAD';
  end if;
  select * into anchor
  from public.leads
  where id = call_row.lead_id and organization_id = current_organization_id;

  select coalesce(array_agg(distinct requested_id), '{}'::uuid[]) into requested
  from unnest(coalesce(target_lead_ids, '{}'::uuid[])) requested_id
  where requested_id is not null and requested_id <> call_row.lead_id;
  if cardinality(requested) > 10 then
    raise exception using errcode = '22023', message = 'TOO_MANY_CALL_LEADS';
  end if;

  if exists (
    select 1
    from unnest(requested) requested_id
    where not exists (
      select 1
      from public.leads lead_row
      where lead_row.id = requested_id
        and lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and lead_row.assigned_user_id = auth.uid()
        and (
          (nullif(anchor.normalized_phone, '') is not null
            and lead_row.normalized_phone = anchor.normalized_phone)
          or (anchor.customer_id is not null and lead_row.customer_id = anchor.customer_id)
        )
    )
  ) then
    raise exception using errcode = '23514', message = 'CALL_LEAD_NOT_ELIGIBLE';
  end if;

  select coalesce(array_agg(requested_id), '{}'::uuid[]) into added
  from unnest(requested) requested_id
  where not exists (
    select 1 from public.call_leads link_row
    where link_row.call_id = target_call_id and link_row.lead_id = requested_id
  );
  select coalesce(array_agg(link_row.lead_id), '{}'::uuid[]) into removed
  from public.call_leads link_row
  where link_row.call_id = target_call_id
    and not (link_row.lead_id = any(requested));

  if cardinality(added) = 0 and cardinality(removed) = 0 then
    return jsonb_build_object('call_id', target_call_id, 'lead_ids', to_jsonb(requested), 'changed', false);
  end if;

  delete from public.call_leads
  where call_id = target_call_id and lead_id = any(removed);
  insert into public.call_leads (organization_id, call_id, lead_id, linked_by, linked_at)
  select current_organization_id, target_call_id, added_id, auth.uid(), changed_at
  from unnest(added) added_id;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
  )
  select current_organization_id, lead_row.customer_id, lead_row.id,
    case when lead_row.id = any(added) then 'CALL_LINKED' else 'CALL_UNLINKED' end,
    auth.uid(),
    jsonb_build_object('call_id', target_call_id, 'call_lead_id', call_row.lead_id),
    changed_at
  from public.leads lead_row
  where lead_row.id = any(added || removed);

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'call.leads_changed', 'call', target_call_id::text,
    call_row.branch_id,
    jsonb_build_object('added', to_jsonb(added), 'removed', to_jsonb(removed))
  );

  return jsonb_build_object('call_id', target_call_id, 'lead_ids', to_jsonb(requested), 'changed', true);
end;
$function$;
revoke all on function public.set_call_leads(uuid, uuid[]) from public, anon;
grant execute on function public.set_call_leads(uuid, uuid[]) to authenticated;

CREATE OR REPLACE FUNCTION app_private.lead_latest_call_summary_json(target_lead_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'call_id', call_row.id,
    'summary', summary_row.summary,
    'started_at', call_row.started_at,
    'duration_seconds', call_row.duration_seconds,
    'caller_name', profile_row.full_name,
    'generated_at', summary_row.created_at
  )
  from public.calls call_row
  join lateral (
    select summary_source.summary, summary_source.created_at
    from public.ai_call_summaries summary_source
    where summary_source.organization_id = call_row.organization_id
      and summary_source.call_id = call_row.id
    order by summary_source.created_at desc, summary_source.id desc
    limit 1
  ) summary_row on true
  left join public.profiles profile_row
    on profile_row.organization_id = call_row.organization_id
   and profile_row.id = call_row.assigned_user_id
  where call_row.id = any(app_private.lead_call_ids(
      (select lead_row.organization_id from public.leads lead_row where lead_row.id = target_lead_id),
      target_lead_id
    ))
    and app_private.has_permission(call_row.organization_id, 'call.view')
    and app_private.can_access_call(call_row.organization_id, call_row.id)
  order by call_row.started_at desc, call_row.id desc
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_lead_detail_workspace(target_lead_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  handoff_read_only boolean := false;
begin
  if auth.uid() is null or target_lead_id is null
    or not (
      app_private.can_access_lead(target_lead_id)
      or exists (
        select 1
        from public.leads access_lead_row
        where access_lead_row.id = target_lead_id
          and access_lead_row.deleted_at is null
          and app_private.is_telecaller_handoff_viewer(
            access_lead_row.organization_id, access_lead_row.id, auth.uid()
          )
      )
    ) then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  handoff_read_only := app_private.is_telecaller_handoff_viewer(
    lead_row.organization_id, lead_row.id, auth.uid()
  );

  can_followups := app_private.has_permission(lead_row.organization_id, 'followup.view');
  can_calls := app_private.has_permission(lead_row.organization_id, 'call.view');
  can_messages := app_private.has_permission(lead_row.organization_id, 'message.view');
  can_appointments := app_private.has_permission(lead_row.organization_id, 'appointment.view')
    and lead_row.customer_id is not null;
  can_update := not handoff_read_only
    and app_private.has_permission(lead_row.organization_id, 'lead.update');

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
      when lead_row.first_contacted_at is null and lead_row.created_at < pg_catalog.timezone('Asia/Kolkata', date_trunc('day', pg_catalog.timezone('Asia/Kolkata', now())))
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
      and call_row.id = any(app_private.lead_call_ids(lead_row.organization_id, lead_row.id))
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
        and call_row.id = any(app_private.lead_call_ids(lead_row.organization_id, lead_row.id))
        and app_private.can_access_call(call_row.organization_id, call_row.id)
      order by call_row.started_at desc, call_row.id desc
      limit 8
    ) item;

    select summary_row.summary into latest_ai_summary
    from public.ai_call_summaries summary_row
    join public.calls call_row
      on call_row.organization_id = summary_row.organization_id and call_row.id = summary_row.call_id
    where summary_row.organization_id = lead_row.organization_id
      and call_row.id = any(app_private.lead_call_ids(lead_row.organization_id, lead_row.id))
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
      'read_only', handoff_read_only,
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
    'latest_ai_summary', latest_ai_summary,
    'requirements', app_private.lead_requirements_json(lead_row.id),
    'exchange_vehicle', app_private.lead_exchange_vehicle_json(lead_row.id),
    'exchange_case', case when lead_row.customer_id is not null
      then app_private.customer_exchange_case_json(lead_row.organization_id, lead_row.customer_id) end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_lead_journey(target_lead_id uuid, target_cursor_at timestamp with time zone DEFAULT NULL::timestamp with time zone, target_cursor_id uuid DEFAULT NULL::uuid, target_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  lead_row public.leads%rowtype;
  org uuid;
  call_access boolean;
  followup_access boolean;
  appointment_access boolean;
  test_drive_access boolean;
  quotation_access boolean;
  booking_access boolean;
  message_access boolean;
  events jsonb;
  page_size integer := least(greatest(coalesce(target_limit, 50), 1), 100);
  last_event jsonb;
  has_more boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if (target_cursor_at is null) <> (target_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_JOURNEY_CURSOR';
  end if;
  select * into lead_row from public.leads where id = target_lead_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  org := lead_row.organization_id;
  if not app_private.has_permission(org, 'lead.view') or not app_private.can_access_lead(lead_row.id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  call_access := app_private.has_permission(org, 'call.view');
  followup_access := app_private.has_permission(org, 'followup.view');
  appointment_access := app_private.has_permission(org, 'appointment.view');
  test_drive_access := app_private.has_permission(org, 'test_drive.view')
    or app_private.has_permission(org, 'test_drive.manage');
  quotation_access := app_private.has_permission(org, 'quotation.view')
    or app_private.has_permission(org, 'quotation.manage');
  booking_access := app_private.has_permission(org, 'booking.view')
    or app_private.has_permission(org, 'booking.manage');
  message_access := app_private.has_permission(org, 'message.view');

  with event as (
    -- Calls
    select call_row.id, coalesce(call_row.answered_at, call_row.started_at) as occurred_at,
      'CALL'::text as kind,
      concat_ws(' ', coalesce(caller.full_name, 'Someone'),
        case when call_row.direction = 'INBOUND' then 'received a call' else 'called' end) as title,
      concat_ws(' · ',
        initcap(replace(coalesce(call_row.outcome, call_row.status, 'UNKNOWN'), '_', ' ')),
        case when coalesce(call_row.duration_seconds, 0) > 0 then
          (call_row.duration_seconds / 60)::text || 'm ' || (call_row.duration_seconds % 60)::text || 's' end,
        case when call_row.call_source = 'PROVIDER' then 'IVR' else 'Personal phone' end) as detail,
      caller.full_name as actor_name,
      call_row.outcome as status,
      case when app_private.can_access_call(org, call_row.id) then jsonb_strip_nulls(jsonb_build_object(
        'notes', call_row.notes,
        'ai_summary', (
          select summary_row.summary from public.ai_call_summaries summary_row
          where summary_row.organization_id = org and summary_row.call_id = call_row.id
          order by summary_row.created_at desc, summary_row.id desc limit 1
        ),
        'call_id', call_row.id
      )) else '{}'::jsonb end as extra
    from public.calls call_row
    left join public.profiles caller on caller.id = call_row.assigned_user_id
    where call_access and call_row.organization_id = org and call_row.id = any(app_private.lead_call_ids(org, lead_row.id))

    union all
    -- Stage changes
    select stage_row.id, stage_row.created_at, 'STAGE',
      'Stage changed to ' || stage_row.to_status::text,
      concat_ws(' · ', case when stage_row.from_status is not null then 'from ' || stage_row.from_status::text end,
        nullif(btrim(stage_row.reason), '')),
      actor.full_name, stage_row.to_status::text, '{}'::jsonb
    from public.lead_stage_history stage_row
    left join public.profiles actor on actor.id = stage_row.changed_by
    where stage_row.organization_id = org and stage_row.lead_id = lead_row.id

    union all
    -- Temperature changes
    select temperature_row.id, temperature_row.created_at, 'TEMPERATURE',
      'Marked ' || temperature_row.to_temperature::text,
      case when temperature_row.from_temperature is not null
        then 'from ' || temperature_row.from_temperature::text end,
      actor.full_name, temperature_row.to_temperature::text, '{}'::jsonb
    from public.lead_temperature_history temperature_row
    left join public.profiles actor on actor.id = temperature_row.changed_by
    where temperature_row.organization_id = org and temperature_row.lead_id = lead_row.id

    union all
    -- Assignments
    select assignment_row.id, assignment_row.created_at, 'ASSIGNMENT',
      'Assigned to ' || coalesce(new_owner.full_name, 'a user'),
      concat_ws(' · ', initcap(replace(assignment_row.method::text, '_', ' ')),
        case when previous_owner.full_name is not null then 'from ' || previous_owner.full_name end,
        nullif(btrim(assignment_row.reason), '')),
      coalesce(assigner.full_name, 'CRM'), assignment_row.method::text, '{}'::jsonb
    from public.lead_assignment_history assignment_row
    left join public.profiles new_owner on new_owner.id = assignment_row.new_owner_id
    left join public.profiles previous_owner on previous_owner.id = assignment_row.previous_owner_id
    left join public.profiles assigner on assigner.id = assignment_row.assigned_by
    where assignment_row.organization_id = org and assignment_row.lead_id = lead_row.id

    union all
    -- Follow-ups: when planned, and when closed
    select followup_row.id, followup_row.created_at, 'FOLLOWUP',
      'Follow-up scheduled for ' || to_char(followup_row.due_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM'),
      concat_ws(' · ', followup_row.reason, initcap(coalesce(followup_row.priority, 'NORMAL')) || ' priority'),
      creator.full_name, 'SCHEDULED', '{}'::jsonb
    from public.followups followup_row
    left join public.profiles creator on creator.id = coalesce(followup_row.created_by, followup_row.assigned_user_id)
    where followup_access and followup_row.organization_id = org and followup_row.lead_id = lead_row.id

    union all
    select followup_row.id, coalesce(followup_row.completed_at, followup_row.cancelled_at), 'FOLLOWUP',
      case when followup_row.status = 'COMPLETED' then 'Follow-up completed' else 'Follow-up cancelled' end,
      concat_ws(' · ', followup_row.reason,
        nullif(btrim(coalesce(followup_row.completion_note, followup_row.cancellation_reason, '')), '')),
      owner.full_name, followup_row.status, '{}'::jsonb
    from public.followups followup_row
    left join public.profiles owner on owner.id = followup_row.assigned_user_id
    where followup_access and followup_row.organization_id = org and followup_row.lead_id = lead_row.id
      and followup_row.status in ('COMPLETED', 'CANCELLED')
      and coalesce(followup_row.completed_at, followup_row.cancelled_at) is not null

    union all
    -- Appointments
    select appointment_row.id, appointment_row.created_at, 'APPOINTMENT',
      appointment_row.appointment_type || ' scheduled for '
        || to_char(appointment_row.scheduled_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM'),
      nullif(btrim(coalesce(appointment_row.notes, '')), ''),
      creator.full_name, 'SCHEDULED', '{}'::jsonb
    from public.appointments appointment_row
    left join public.profiles creator on creator.id = coalesce(appointment_row.created_by, appointment_row.assigned_user_id)
    where appointment_access and appointment_row.organization_id = org and appointment_row.lead_id = lead_row.id

    union all
    select appointment_row.id,
      coalesce(appointment_row.completed_at, appointment_row.cancelled_at, appointment_row.scheduled_at), 'APPOINTMENT',
      appointment_row.appointment_type || case appointment_row.status
        when 'COMPLETED' then ' completed' when 'NO_SHOW' then ' — customer did not come' else ' cancelled' end,
      nullif(btrim(coalesce(appointment_row.cancellation_reason, '')), ''),
      owner.full_name, appointment_row.status, '{}'::jsonb
    from public.appointments appointment_row
    left join public.profiles owner on owner.id = appointment_row.assigned_user_id
    where appointment_access and appointment_row.organization_id = org and appointment_row.lead_id = lead_row.id
      and appointment_row.status in ('COMPLETED', 'NO_SHOW', 'CANCELLED')

    union all
    -- Test drives
    select drive_appointment.id, drive_appointment.created_at, 'TEST_DRIVE',
      'Test drive scheduled for '
        || to_char(drive_appointment.scheduled_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM'),
      nullif(drive_appointment.vehicle_registration, ''),
      creator.full_name, drive_appointment.status, '{}'::jsonb
    from public.test_drive_appointments drive_appointment
    left join public.profiles creator on creator.id = coalesce(drive_appointment.created_by, drive_appointment.assigned_user_id)
    where test_drive_access and drive_appointment.organization_id = org and drive_appointment.lead_id = lead_row.id

    union all
    select drive_row.id, coalesce(drive_row.completed_at, drive_row.cancelled_at), 'TEST_DRIVE',
      case when drive_row.status = 'COMPLETED' then 'Test drive completed' else 'Test drive cancelled' end,
      case when drive_row.status = 'COMPLETED' then concat_ws(' · ',
          round(coalesce(drive_row.distance_meters, 0) / 1000.0, 1)::text || ' km',
          (coalesce(drive_row.duration_seconds, 0) / 60)::text || ' min')
        else drive_row.cancellation_reason end,
      owner.full_name, drive_row.status, '{}'::jsonb
    from public.test_drives drive_row
    left join public.profiles owner on owner.id = drive_row.assigned_user_id
    where test_drive_access and drive_row.organization_id = org and drive_row.lead_id = lead_row.id
      and drive_row.status in ('COMPLETED', 'CANCELLED')
      and coalesce(drive_row.completed_at, drive_row.cancelled_at) is not null

    union all
    -- Quotations
    select quotation_row.id, quotation_row.created_at, 'QUOTATION',
      'Quotation ' || quotation_row.quotation_number || ' created',
      concat_ws(' · ', '₹' || to_char(quotation_row.total_amount, 'FM99,99,99,999'),
        'now ' || lower(replace(quotation_row.status, '_', ' ')),
        case when quotation_row.current_version > 1 then 'version ' || quotation_row.current_version end),
      owner.full_name, quotation_row.status, jsonb_build_object('quotation_id', quotation_row.id)
    from public.quotations quotation_row
    left join public.profiles owner on owner.id = quotation_row.assigned_user_id
    where quotation_access and quotation_row.organization_id = org and quotation_row.lead_id = lead_row.id
      and quotation_row.deleted_at is null

    union all
    -- Bookings
    select booking_row.id, booking_row.created_at, 'BOOKING',
      'Booking ' || booking_row.booking_number || ' confirmed',
      concat_ws(' · ', '₹' || to_char(booking_row.booking_amount, 'FM99,99,99,999') || ' paid',
        'now ' || lower(replace(booking_row.status, '_', ' ')),
        case when booking_row.expected_delivery_date is not null
          then 'delivery ' || to_char(booking_row.expected_delivery_date, 'DD Mon YYYY') end),
      owner.full_name, booking_row.status, jsonb_build_object('booking_id', booking_row.id)
    from public.bookings booking_row
    left join public.profiles owner on owner.id = booking_row.assigned_user_id
    where booking_access and booking_row.organization_id = org and booking_row.lead_id = lead_row.id
      and booking_row.deleted_at is null

    union all
    -- Conversations (the thread itself opens in lead detail)
    select conversation_row.id, conversation_row.created_at, 'MESSAGE',
      initcap(replace(replace(conversation_row.channel, '_BUSINESS', ''), '_', ' ')) || ' conversation started',
      (select count(*)::text || ' messages' from public.conversation_messages message_row
        where message_row.organization_id = org and message_row.conversation_id = conversation_row.id),
      owner.full_name, conversation_row.status, jsonb_build_object('conversation_id', conversation_row.id)
    from public.conversations conversation_row
    left join public.profiles owner on owner.id = conversation_row.assigned_user_id
    where message_access and conversation_row.organization_id = org and conversation_row.lead_id = lead_row.id

    union all
    -- Notes on the lead
    select note_row.id, note_row.created_at, 'NOTE', 'Note added', left(note_row.body, 600),
      author.full_name, null, '{}'::jsonb
    from public.notes note_row
    left join public.profiles author on author.id = note_row.created_by
    where note_row.organization_id = org and lower(note_row.resource_type) = 'lead'
      and note_row.resource_id = lead_row.id and note_row.deleted_at is null

    union all
    -- Activities that no structured source above already records
    select activity_row.id, activity_row.occurred_at, 'ACTIVITY',
      case activity_row.activity_type
        when 'SALES_CONTACTED' then 'Sales Consultant contacted the customer'
        when 'TELECALLER_CONTACTED' then 'Telecaller contacted the customer'
        when 'CUSTOMER_LINKED' then 'Linked to an existing customer'
        when 'CUSTOMER_CREATED_AND_LINKED' then 'Customer record created'
        when 'LEAD_REQUIREMENTS_UPDATED' then 'Requirements updated'
        else initcap(replace(activity_row.activity_type, '_', ' '))
      end,
      coalesce(
        case when activity_row.metadata ? 'channel'
          then 'via ' || initcap(replace(activity_row.metadata->>'channel', '_', ' ')) end,
        nullif(activity_row.metadata->>'summary', '')
      ),
      actor.full_name, activity_row.activity_type, '{}'::jsonb
    from public.activities activity_row
    left join public.profiles actor on actor.id = activity_row.actor_id
    where activity_row.organization_id = org and activity_row.lead_id = lead_row.id
      and activity_row.activity_type not in (
        'LEAD_RECEIVED', 'FIRST_CONTACTED', 'LEAD_QUALIFIED', 'LEAD_TRANSFERRED_TO_SALES',
        'FOLLOWUP_SCHEDULED', 'FOLLOWUP_COMPLETED', 'APPOINTMENT_SCHEDULED', 'APPOINTMENT_UPDATED',
        'APPOINTMENT_COMPLETED', 'TEST_DRIVE_SCHEDULED', 'TEST_DRIVE_COMPLETED', 'QUOTATION_CREATED',
        'BOOKING_CREATED'
      )
      and activity_row.activity_type not like 'demo.%'
  ), page as (
    select * from event
    where occurred_at is not null
      and (target_cursor_at is null or (occurred_at, id) < (target_cursor_at, target_cursor_id))
    order by occurred_at desc, id desc
    limit page_size + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'occurred_at', page.occurred_at,
      'kind', page.kind,
      'title', page.title,
      'detail', nullif(page.detail, ''),
      'actor_name', page.actor_name,
      'status', page.status,
      'extra', page.extra
    ) order by page.occurred_at desc, page.id desc), '[]'::jsonb)
  into events
  from page;

  has_more := jsonb_array_length(events) > page_size;
  if has_more then
    events := events - page_size;
  end if;
  last_event := events -> (jsonb_array_length(events) - 1);

  return jsonb_build_object(
    'lead_id', lead_row.id,
    'events', events,
    'next_cursor', case when has_more then jsonb_build_object(
      'occurred_at', last_event->'occurred_at', 'id', last_event->'id') end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_lead_activity_page(target_lead_id uuid, target_kind text, target_page integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare org uuid; result jsonb; permission text;
begin
  if not app_private.can_access_lead(target_lead_id) then raise exception 'LEAD_NOT_FOUND'; end if;
  select organization_id into org from public.leads where id=target_lead_id and deleted_at is null;
  permission:=case target_kind when 'calls' then 'call.view' when 'followups' then 'followup.view' when 'appointments' then 'appointment.view' end;
  if permission is null or not app_private.has_permission(org,permission) then raise exception 'ACTIVITY_ACCESS_DENIED'; end if;
  if target_page not between 1 and 1000000 then raise exception 'INVALID_PAGE'; end if;
  with rows as materialized (
    select id,direction::text||' call' label,status::text,started_at occurred_at,coalesce(outcome,'') detail from public.calls
    where target_kind='calls' and organization_id=org and id = any(app_private.lead_call_ids(org, target_lead_id)) and app_private.can_access_call(org,id)
    union all
    select id,reason,status::text,due_at,priority::text from public.followups
    where target_kind='followups' and organization_id=org and lead_id=target_lead_id
      and app_private.can_access_record(organization_id,branch_id,team_id,assigned_user_id)
    union all
    select id,appointment_type,status::text,scheduled_at,coalesce(notes,'') from public.appointments
    where target_kind='appointments' and organization_id=org and lead_id=target_lead_id
      and app_private.can_access_record(organization_id,branch_id,team_id,assigned_user_id)
  ), page as (select * from rows order by occurred_at desc,id desc limit 25 offset (target_page-1)::bigint*25)
  select jsonb_build_object('total',(select count(*) from rows),'records',coalesce((select jsonb_agg(to_jsonb(p) order by occurred_at desc,id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$function$;

commit;
