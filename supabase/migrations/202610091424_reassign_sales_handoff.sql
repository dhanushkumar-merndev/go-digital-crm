begin;

-- Cancel transfer can now name the next consultant in the same step: the
-- telecaller who handed the lead to Sales moves it from one consultant to
-- another in one transaction (reassign_sales_handoff). The lead keeps its
-- stage -- a booked lead stays booked -- and everything on it stays; the
-- previous consultant's open follow-ups go to the new one. The timeline gets
-- "Transfer to X cancelled, moved to Y" with the reason, plus the assignment
-- row, and an audit row is written.
--
-- get_sales_handoff_candidates lets that telecaller list the team's
-- consultants for the move. cancel_sales_handoff finds the telecaller's own
-- handoff even after the lead was moved between consultants.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

CREATE OR REPLACE FUNCTION public.reassign_sales_handoff(target_lead_id uuid, target_user_id uuid, reassignment_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  normalized_reason text := nullif(btrim(coalesce(reassignment_reason, '')), '');
  changed_at timestamptz := clock_timestamp();
  assignment_id uuid;
  moved_followup_ids uuid[];
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if normalized_reason is null then
    raise exception using errcode = '22023', message = 'HANDOFF_CANCELLATION_REASON_REQUIRED';
  end if;
  if char_length(normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'HANDOFF_CANCELLATION_REASON_TOO_LONG';
  end if;
  if target_user_id is null then
    raise exception using errcode = '22023', message = 'SALES_CONSULTANT_REQUIRED';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if target_lead.lifecycle_status not in ('Transferred to Sales', 'Appointment Scheduled')
    or target_lead.assigned_user_id is null then
    raise exception using errcode = '23514', message = 'HANDOFF_NOT_CANCELLABLE';
  end if;
  if target_lead.assigned_user_id = target_user_id then
    raise exception using errcode = '23514', message = 'SALES_CONSULTANT_UNCHANGED';
  end if;
  if not app_private.has_permission(current_organization_id, 'lead.update') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  -- Only the telecaller who handed this lead to Sales.
  if not app_private.is_telecaller_handoff_viewer(current_organization_id, target_lead.id, auth.uid()) then
    raise exception using errcode = '42501', message = 'HANDOFF_ORIGINAL_TELECALLER_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.organization_id = member_row.organization_id
     and profile_row.id = member_row.user_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.user_id = target_user_id
      and member_row.active
      and member_row.eligible_for_qualified_leads
      and profile_row.active
      and profile_row.deleted_at is null
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.organization_id = current_organization_id
          and assignment_row.user_id = target_user_id
          and assignment_row.active
          and role_row.role_key = 'sales_consultant'
      )
  ) then
    raise exception using errcode = '23514', message = 'SALES_CONSULTANT_NOT_ELIGIBLE';
  end if;

  perform set_config('app.assign_lead_rpc', 'on', true);

  update public.lead_assignments
  set active = false
  where organization_id = current_organization_id
    and lead_id = target_lead.id
    and active;

  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id,
    target_user_id, 'QUALIFIED', 'MANUAL_ASSIGNMENT', auth.uid(), normalized_reason
  ) returning id into assignment_id;

  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id,
    target_lead.assigned_user_id, target_user_id, auth.uid(), 'MANUAL_ASSIGNMENT', normalized_reason
  );

  -- The lead keeps its stage; only the owner changes.
  update public.leads
  set assigned_user_id = target_user_id,
      updated_at = greatest(changed_at, updated_at + interval '1 microsecond')
  where id = target_lead.id;

  update public.team_members
  set last_qualified_assigned_at = changed_at
  where organization_id = current_organization_id
    and team_id = target_lead.team_id
    and user_id = target_user_id;

  -- The previous consultant's open follow-ups go to the new one.
  with moved as (
    update public.followups followup_row
    set assigned_user_id = target_user_id,
        updated_at = clock_timestamp(),
        version = followup_row.version + 1
    where followup_row.organization_id = current_organization_id
      and followup_row.lead_id = target_lead.id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and followup_row.assigned_user_id = target_lead.assigned_user_id
    returning followup_row.id
  )
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into moved_followup_ids from moved;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, target_lead.customer_id, target_lead.id,
    'SALES_HANDOFF_REASSIGNED', auth.uid(),
    jsonb_build_object(
      'previous_sales_consultant_id', target_lead.assigned_user_id,
      'new_sales_consultant_id', target_user_id,
      'lifecycle_status', target_lead.lifecycle_status,
      'assignment_id', assignment_id,
      'moved_followup_ids', to_jsonb(moved_followup_ids),
      'reason', normalized_reason
    )
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'lead.sales_handoff_reassigned', 'lead',
    target_lead.id::text, target_lead.branch_id,
    jsonb_build_object(
      'previous_sales_consultant_id', target_lead.assigned_user_id,
      'new_sales_consultant_id', target_user_id,
      'assignment_id', assignment_id,
      'moved_followup_ids', to_jsonb(moved_followup_ids),
      'reason', normalized_reason
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'assigned_user_id', target_user_id,
    'previous_assigned_user_id', target_lead.assigned_user_id,
    'lifecycle_status', target_lead.lifecycle_status
  );
end;
$function$;
revoke all on function public.reassign_sales_handoff(uuid, uuid, text) from public, anon;
grant execute on function public.reassign_sales_handoff(uuid, uuid, text) to authenticated;

CREATE OR REPLACE FUNCTION public.cancel_sales_handoff(target_lead_id uuid, cancellation_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  handoff_history record;
  normalized_reason text := nullif(btrim(coalesce(cancellation_reason, '')), '');
  cancelled_at timestamptz := clock_timestamp();
  restored_assignment_id uuid;
  moved_followup_ids uuid[];
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if normalized_reason is null then
    raise exception using errcode = '22023', message = 'HANDOFF_CANCELLATION_REASON_REQUIRED';
  end if;
  if char_length(normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'HANDOFF_CANCELLATION_REASON_TOO_LONG';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  -- The consultant may already have scheduled a visit or booked the lead.
  -- Cancelling still returns it; its test drives, quotations, bookings and
  -- history stay on the lead and the timeline carries on from there.
  if target_lead.lifecycle_status not in ('Transferred to Sales', 'Appointment Scheduled')
    or target_lead.assigned_user_id is null then
    raise exception using errcode = '23514', message = 'HANDOFF_NOT_CANCELLABLE';
  end if;
  if not app_private.has_permission(current_organization_id, 'lead.update') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) then
    raise exception using errcode = '42501', message = 'HANDOFF_ORIGINAL_TELECALLER_REQUIRED';
  end if;

  select history_row.* into handoff_history
  from public.lead_assignment_history history_row
  where history_row.organization_id = current_organization_id
    and history_row.lead_id = target_lead.id
    and history_row.previous_owner_id = auth.uid()
    and history_row.new_owner_id is not null
  order by history_row.created_at desc, history_row.id desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'HANDOFF_ORIGINAL_TELECALLER_REQUIRED';
  end if;
  if target_lead.team_id is null or not exists (
    select 1
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.organization_id = member_row.organization_id
     and profile_row.id = member_row.user_id
    where member_row.organization_id = current_organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.user_id = auth.uid()
      and member_row.active
      and profile_row.active
      and profile_row.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'HANDOFF_RETURN_OWNER_NOT_ELIGIBLE';
  end if;

  -- Only this security-definer operation may cross the owner invariant and
  -- insert a fresh assignment after a previous qualified handoff.
  perform set_config('app.assign_lead_rpc', 'on', true);
  perform set_config('app.sales_handoff_cancellation_rpc', 'on', true);

  update public.leads
  set lifecycle_status = 'Contacted',
      assigned_user_id = auth.uid(),
      updated_at = greatest(cancelled_at, updated_at + interval '1 microsecond')
  where id = target_lead.id;

  -- Follow-ups the consultant left open come back with the lead, so the
  -- telecaller can work them -- completing one with Transfer to Sales picks
  -- the next consultant -- instead of a stranded follow-up blocking the handoff.
  with moved as (
    update public.followups followup_row
    set assigned_user_id = auth.uid(),
        updated_at = clock_timestamp(),
        version = followup_row.version + 1
    where followup_row.organization_id = current_organization_id
      and followup_row.lead_id = target_lead.id
      and followup_row.status in ('OPEN', 'OVERDUE')
      and followup_row.assigned_user_id is distinct from auth.uid()
    returning followup_row.id
  )
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into moved_followup_ids from moved;

  update public.lead_assignments
  set active = false
  where organization_id = current_organization_id
    and lead_id = target_lead.id
    and active;

  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id,
    auth.uid(), 'FRESH', 'MANUAL_ASSIGNMENT', auth.uid(), normalized_reason
  ) returning id into restored_assignment_id;

  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.branch_id, target_lead.team_id,
    target_lead.assigned_user_id, auth.uid(), auth.uid(), 'MANUAL_ASSIGNMENT', normalized_reason
  );

  insert into public.lead_stage_history (
    organization_id, lead_id, from_status, to_status, changed_by, reason
  ) values (
    current_organization_id, target_lead.id, target_lead.lifecycle_status, 'Contacted', auth.uid(),
    normalized_reason
  );

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, target_lead.customer_id, target_lead.id,
    'SALES_HANDOFF_CANCELLED', auth.uid(),
    jsonb_build_object(
      'previous_sales_consultant_id', target_lead.assigned_user_id,
      'previous_lifecycle_status', target_lead.lifecycle_status,
      'moved_followup_ids', to_jsonb(moved_followup_ids),
      'restored_telecaller_id', auth.uid(),
      'handoff_assignment_history_id', handoff_history.id,
      'restored_assignment_id', restored_assignment_id,
      'reason', normalized_reason
    )
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'lead.sales_handoff_cancelled', 'lead',
    target_lead.id::text, target_lead.branch_id,
    jsonb_build_object(
      'previous_sales_consultant_id', target_lead.assigned_user_id,
      'restored_telecaller_id', auth.uid(),
      'handoff_assignment_history_id', handoff_history.id,
      'restored_assignment_id', restored_assignment_id,
      'reason', normalized_reason
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'assigned_user_id', auth.uid(),
    'lifecycle_status', 'Contacted'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_handoff_candidates(target_lead_id uuid, target_search text DEFAULT ''::text)
 RETURNS TABLE(user_id uuid, full_name text, open_leads bigint, hot_leads bigint, recommended boolean, assignment_mode text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target_lead public.leads%rowtype;
  normalized_search text;
  qualified_mode public.assignment_mode;
  customer_owner_id uuid;
begin
  if target_lead_id is null then
    raise exception using errcode = '22023', message = 'LEAD_ID_REQUIRED';
  end if;
  normalized_search := left(btrim(coalesce(target_search, '')), 160);

  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.id = target_lead_id
    and lead_row.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  -- The telecaller who handed the lead to Sales picks the next consultant
  -- when moving it (reassign_sales_handoff).
  if app_private.is_telecaller_handoff_viewer(target_lead.organization_id, target_lead.id, auth.uid())
    and app_private.has_permission(target_lead.organization_id, 'lead.update')
  then
    null;
  elsif not app_private.can_access_record(
      target_lead.organization_id,
      target_lead.branch_id,
      target_lead.team_id,
      target_lead.assigned_user_id
    )
    or not (
      app_private.has_permission(target_lead.organization_id, 'lead.assign')
      or (
        coalesce(target_lead.assigned_user_id = auth.uid(), false)
        and app_private.has_permission(target_lead.organization_id, 'lead.update')
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;

  select team_row.qualified_assignment_mode into qualified_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = target_lead.organization_id;

  -- Recommend continuity without hiding any other eligible consultant.
  -- An explicit choice is validated by transfer_lead_to_sales.
  customer_owner_id := app_private.same_customer_owner(
    target_lead.organization_id, target_lead.team_id, target_lead.normalized_phone,
    target_lead.customer_id, target_lead.id, 'QUALIFIED'
  );

  return query
  with eligible as (
    select member_row.user_id,
      profile_row.full_name,
      member_row.last_qualified_assigned_at,
      member_row.joined_at
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.active
      and member_row.eligible_for_qualified_leads
      and profile_row.active
      and profile_row.deleted_at is null
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.organization_id = target_lead.organization_id
          and assignment_row.user_id = member_row.user_id
          and assignment_row.active
          and role_row.role_key = 'sales_consultant'
      )
  ), loaded as (
    select eligible_row.*,
      coalesce(book.open_leads, 0)::bigint as open_leads,
      coalesce(book.hot_leads, 0)::bigint as hot_leads
    from eligible eligible_row
    left join lateral (
      select count(*)::bigint as open_leads,
        count(*) filter (where lead_row.temperature = 'HOT')::bigint as hot_leads
      from public.leads lead_row
      where lead_row.organization_id = target_lead.organization_id
        and lead_row.team_id = target_lead.team_id
        and lead_row.assigned_user_id = eligible_row.user_id
        and lead_row.deleted_at is null
        and lead_row.lifecycle_status <> 'Lost'
    ) book on true
  ), ranked as (
    -- The recommendation is a property of the team, not of the search box, so
    -- it is decided before any name filter is applied. It mirrors the order
    -- transfer_lead_to_sales uses for an automatic pick.
    select loaded_row.*,
      row_number() over (
        order by case when loaded_row.user_id = customer_owner_id then 0 else 1 end asc,
          case when qualified_mode = 'ROUND_ROBIN' then 0 else loaded_row.open_leads end asc,
          loaded_row.last_qualified_assigned_at asc nulls first,
          loaded_row.joined_at asc,
          loaded_row.user_id
      ) = 1 as recommended
    from loaded loaded_row
  )
  select ranked_row.user_id,
    ranked_row.full_name,
    ranked_row.open_leads,
    ranked_row.hot_leads,
    ranked_row.recommended,
    case
      when customer_owner_id is not null then 'SAME_CUSTOMER'
      else coalesce(qualified_mode::text, 'MANUAL_ASSIGNMENT')
    end
  from ranked ranked_row
  where normalized_search = ''
    or ranked_row.full_name ilike '%' || normalized_search || '%'
  order by ranked_row.recommended desc, ranked_row.open_leads asc, ranked_row.full_name, ranked_row.user_id
  limit 50;
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
  -- The telecaller who handed the lead to Sales keeps reading its timeline,
  -- as they already read its detail page.
  if not app_private.has_permission(org, 'lead.view')
    or not (
      app_private.can_access_lead(lead_row.id)
      or app_private.is_telecaller_handoff_viewer(org, lead_row.id, auth.uid())
    ) then
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
        when 'SALES_HANDOFF_CANCELLED' then
          'Transfer to ' || coalesce(handoff_consultant.full_name, 'Sales') || ' cancelled'
        when 'SALES_HANDOFF_REASSIGNED' then
          'Transfer to ' || coalesce(handoff_consultant.full_name, 'Sales')
            || ' cancelled, moved to ' || coalesce(next_consultant.full_name, 'another consultant')
        when 'LEAD_TAKEN_OVER' then 'Taken over on first contact'
        when 'CALL_LINKED' then 'Call on another enquiry linked here'
        when 'CALL_UNLINKED' then 'Linked call removed'
        else initcap(replace(activity_row.activity_type, '_', ' '))
      end,
      coalesce(
        case when activity_row.metadata ? 'channel'
          then 'via ' || initcap(replace(activity_row.metadata->>'channel', '_', ' ')) end,
        nullif(activity_row.metadata->>'summary', ''),
        nullif(btrim(activity_row.metadata->>'reason'), '')
      ),
      actor.full_name, activity_row.activity_type, '{}'::jsonb
    from public.activities activity_row
    left join public.profiles actor on actor.id = activity_row.actor_id
    left join public.profiles handoff_consultant
      on activity_row.activity_type in ('SALES_HANDOFF_CANCELLED', 'SALES_HANDOFF_REASSIGNED')
     and handoff_consultant.organization_id = org
     and handoff_consultant.id::text = activity_row.metadata->>'previous_sales_consultant_id'
    left join public.profiles next_consultant
      on activity_row.activity_type = 'SALES_HANDOFF_REASSIGNED'
     and next_consultant.organization_id = org
     and next_consultant.id::text = activity_row.metadata->>'new_sales_consultant_id'
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

commit;
