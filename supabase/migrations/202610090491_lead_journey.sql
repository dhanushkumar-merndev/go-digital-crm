begin;
-- One lead's journey, and lead-scoped Customer 360 sections.
--
-- Customer 360 groups a customer's history by enquiry: the Timeline tab lists
-- the leads, and opening one shows that lead's journey -- who called and when,
-- stage and temperature changes, assignments, follow-ups, visits, test drives,
-- quotations, bookings and notes, each with the person who did it. Lead detail
-- shows the same journey.
--
-- Visibility: the caller must be able to see the lead. Each event family then
-- needs its own module permission. A call on a visible lead is shown as an
-- event (who, when, outcome, duration) because the handoff history belongs to
-- the lead; its notes and AI summary stay limited to callers who can open that
-- call.
--
-- The Sales Consultant section RPC gains `target_lead_id`, so Calls,
-- Follow-ups, Appointments and Messages can be narrowed to one enquiry in the
-- database rather than by filtering a page in the browser.

create or replace function public.get_lead_journey(
  target_lead_id uuid,
  target_cursor_at timestamptz default null,
  target_cursor_id uuid default null,
  target_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    where call_access and call_row.organization_id = org and call_row.lead_id = lead_row.id

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
$$;
revoke all on function public.get_lead_journey(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.get_lead_journey(uuid, timestamptz, uuid, integer) to authenticated;

-- Sales Consultant sections: optional lead filter. The signature changes, so the
-- patched text becomes a new overload and the old one is dropped.
do $$
declare
  old_signature regprocedure :=
    'public.get_sales_consultant_customer_360_section(uuid,text,integer,integer,timestamp with time zone,uuid)';
  definition text := pg_get_functiondef(old_signature);
  patch record;
  occurrences integer;
begin
  for patch in
    select * from (values
      ('target_cursor_id uuid DEFAULT NULL::uuid)',
       'target_cursor_id uuid DEFAULT NULL::uuid, target_lead_id uuid DEFAULT NULL::uuid)', 1),
      ('and call_row.customer_id = target_customer_id',
       'and call_row.customer_id = target_customer_id and (target_lead_id is null or call_row.lead_id = target_lead_id)', 2),
      ('and conversation_row.customer_id = target_customer_id',
       'and conversation_row.customer_id = target_customer_id and (target_lead_id is null or conversation_row.lead_id = target_lead_id)', 2),
      ('and followup_row.customer_id = target_customer_id',
       'and followup_row.customer_id = target_customer_id and (target_lead_id is null or followup_row.lead_id = target_lead_id)', 1),
      ('and followup_source.customer_id = target_customer_id',
       'and followup_source.customer_id = target_customer_id and (target_lead_id is null or followup_source.lead_id = target_lead_id)', 1),
      ('and appointment_row.customer_id = target_customer_id',
       'and appointment_row.customer_id = target_customer_id and (target_lead_id is null or appointment_row.lead_id = target_lead_id)', 1),
      ('and appointment_source.customer_id = target_customer_id',
       'and appointment_source.customer_id = target_customer_id and (target_lead_id is null or appointment_source.lead_id = target_lead_id)', 1)
    ) as p(old_text, new_text, expected)
  loop
    occurrences := (char_length(definition) - char_length(replace(definition, patch.old_text, '')))
      / char_length(patch.old_text);
    if occurrences <> patch.expected then
      raise exception 'SECTION_PATCH_ANCHOR "%": expected %, found %', patch.old_text, patch.expected, occurrences;
    end if;
    definition := replace(definition, patch.old_text, patch.new_text);
  end loop;
  execute definition;
  execute 'drop function ' || old_signature::text;
end;
$$;
revoke all on function public.get_sales_consultant_customer_360_section(uuid, text, integer, integer, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.get_sales_consultant_customer_360_section(uuid, text, integer, integer, timestamptz, uuid, uuid) to authenticated, service_role;

-- Sales Consultant core: the leads the picker offers. Same visibility as the
-- current opportunity (own assigned leads in allowed branches).
do $$
declare
  target regprocedure := 'public.get_sales_consultant_customer_360_core(uuid)';
  definition text := pg_get_functiondef(target);
  old_text text := $old$    'notes', notes_data
  );$old$;
  new_text text := $new$    'notes', notes_data,
    'lead_options', case when lead_access then coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', option_row.id,
          'source', option_row.source,
          'interested_model', option_row.interested_model,
          'lifecycle_status', option_row.lifecycle_status,
          'created_at', option_row.created_at
        ) order by option_row.created_at desc, option_row.id desc)
      from (
        select lead_row.id, lead_row.source, lead_row.interested_model, lead_row.lifecycle_status,
          lead_row.created_at
        from public.leads lead_row
        where lead_row.organization_id = current_organization_id
          and lead_row.customer_id = target_customer_id
          and lead_row.assigned_user_id = auth.uid()
          and lead_row.branch_id = any(allowed_branch_ids)
          and lead_row.deleted_at is null
        order by lead_row.created_at desc, lead_row.id desc
        limit 50
      ) option_row
    ), '[]'::jsonb) else '[]'::jsonb end
  );$new$;
begin
  if (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text) <> 1 then
    raise exception 'CORE_PATCH_ANCHOR_MISSING';
  end if;
  execute replace(definition, old_text, new_text);
end;
$$;

commit;
