begin;

-- The legacy public.get_customer_360(uuid) contract remains unchanged for all
-- existing callers. Sales Consultant pages use the focused RPCs below so that
-- opening a customer never executes every module query eagerly.

create or replace function app_private.sales_consultant_customer_scope(
  target_customer_id uuid
)
returns table (
  organization_id uuid,
  branch_ids uuid[],
  permission_keys text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  current_permission_keys text[];
begin
  if auth.uid() is null or target_customer_id is null then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'role_key' <> 'sales-consultant'
    or access_context->>'organization_id' is null
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  current_permission_keys := app_private.sales_consultant_permissions(
    current_organization_id
  );
  if not ('customer.view' = any(current_permission_keys)) then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  allowed_branch_ids := app_private.sales_consultant_allowed_branches(
    current_organization_id
  );
  if cardinality(coalesce(allowed_branch_ids, array[]::uuid[])) = 0
    or not exists (
      select 1
      from public.customers customer_row
      where customer_row.organization_id = current_organization_id
        and customer_row.id = target_customer_id
        and customer_row.deleted_at is null
        and exists (
          select 1
          from public.leads lead_row
          where lead_row.organization_id = current_organization_id
            and lead_row.customer_id = customer_row.id
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(allowed_branch_ids)
            and lead_row.deleted_at is null
        )
    )
  then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  return query
  select current_organization_id, allowed_branch_ids, current_permission_keys;
end;
$$;

revoke all on function app_private.sales_consultant_customer_scope(uuid)
  from public, anon, authenticated;

create or replace function public.get_sales_consultant_customer_360_core(
  target_customer_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_data jsonb;
  current_opportunity jsonb := null;
  contacts_data jsonb := '[]'::jsonb;
  addresses_data jsonb := '[]'::jsonb;
  custom_fields_data jsonb := '[]'::jsonb;
  notes_data jsonb := '[]'::jsonb;
  lead_access boolean;
begin
  select scope_row.organization_id, scope_row.branch_ids, scope_row.permission_keys
  into current_organization_id, allowed_branch_ids, permission_keys
  from app_private.sales_consultant_customer_scope(target_customer_id) scope_row;

  lead_access := 'lead.view' = any(permission_keys);

  select jsonb_build_object(
    'id', customer_row.id,
    'full_name', customer_row.full_name,
    'primary_phone', customer_row.primary_phone,
    'primary_email', customer_row.primary_email,
    'created_at', customer_row.created_at,
    'updated_at', customer_row.updated_at
  )
  into customer_data
  from public.customers customer_row
  where customer_row.organization_id = current_organization_id
    and customer_row.id = target_customer_id
    and customer_row.deleted_at is null;

  if lead_access then
    select to_jsonb(opportunity_row)
    into current_opportunity
    from (
      select
        lead_row.id,
        lead_row.source,
        lead_row.source_detail,
        lead_row.campaign,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        case
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state,
        branch_row.name as branch_name,
        team_row.name as team_name,
        lead_row.assigned_user_id,
        profile_row.full_name as assigned_user_name,
        lead_row.created_at,
        lead_row.updated_at
      from public.leads lead_row
      join public.branches branch_row
        on branch_row.organization_id = lead_row.organization_id
       and branch_row.id = lead_row.branch_id
      left join public.teams team_row
        on team_row.organization_id = lead_row.organization_id
       and team_row.id = lead_row.team_id
      left join public.profiles profile_row
        on profile_row.organization_id = lead_row.organization_id
       and profile_row.id = lead_row.assigned_user_id
      where lead_row.organization_id = current_organization_id
        and lead_row.customer_id = target_customer_id
        and lead_row.assigned_user_id = auth.uid()
        and lead_row.branch_id = any(allowed_branch_ids)
        and lead_row.deleted_at is null
      order by lead_row.updated_at desc, lead_row.id desc
      limit 1
    ) opportunity_row;
  end if;

  -- The overview renders every returned identifier; 25 is a deliberate guard
  -- against malformed/imported customers with unbounded contact rows.
  select coalesce(jsonb_agg(to_jsonb(contact_row)
    order by contact_row.is_primary desc, contact_row.id), '[]'::jsonb)
  into contacts_data
  from (
    select contact_source.id, contact_source.type, contact_source.value,
      contact_source.is_primary
    from public.customer_contacts contact_source
    where contact_source.organization_id = current_organization_id
      and contact_source.customer_id = target_customer_id
    order by contact_source.is_primary desc, contact_source.created_at, contact_source.id
    limit 25
  ) contact_row;

  select coalesce(jsonb_agg(to_jsonb(address_row)
    order by address_row.id), '[]'::jsonb)
  into addresses_data
  from (
    select address_source.id, address_source.address_type,
      case when jsonb_typeof(address_source.address) = 'object'
        then address_source.address else '{}'::jsonb end as address
    from public.customer_addresses address_source
    where address_source.organization_id = current_organization_id
      and address_source.customer_id = target_customer_id
    order by address_source.created_at, address_source.id
    limit 10
  ) address_row;

  select coalesce(jsonb_agg(to_jsonb(field_row)
    order by field_row.label, field_row.definition_id), '[]'::jsonb)
  into custom_fields_data
  from (
    select definition_row.id as definition_id, definition_row.field_key,
      definition_row.label, definition_row.field_type, value_row.value
    from public.custom_field_definitions definition_row
    join public.custom_field_values value_row
      on value_row.organization_id = definition_row.organization_id
     and value_row.definition_id = definition_row.id
     and upper(value_row.resource_type) = 'CUSTOMER'
     and value_row.resource_id = target_customer_id
    where definition_row.organization_id = current_organization_id
      and upper(definition_row.module) = 'CUSTOMERS'
      and definition_row.active
    order by definition_row.label, definition_row.id
    limit 50
  ) field_row;

  -- The overview labels this card "Recent notes" and renders at most eight.
  select coalesce(jsonb_agg(to_jsonb(note_row)
    order by note_row.created_at desc, note_row.id desc), '[]'::jsonb)
  into notes_data
  from (
    select note_source.id, note_source.body,
      profile_row.full_name as created_by_name, note_source.created_at
    from public.notes note_source
    left join public.profiles profile_row
      on profile_row.organization_id = note_source.organization_id
     and profile_row.id = note_source.created_by
    where note_source.organization_id = current_organization_id
      and lower(note_source.resource_type) = 'customer'
      and note_source.resource_id = target_customer_id
      and note_source.deleted_at is null
    order by note_source.created_at desc, note_source.id desc
    limit 8
  ) note_row;

  return jsonb_build_object(
    'customer', customer_data,
    'current_opportunity', current_opportunity,
    'section_access', jsonb_build_object(
      'overview', true,
      'leads', lead_access,
      'calls', 'call.view' = any(permission_keys),
      'conversations', 'message.view' = any(permission_keys),
      'followups', lead_access and 'followup.view' = any(permission_keys),
      'appointments', 'appointment.view' = any(permission_keys),
      'test_drives', 'test_drive.view' = any(permission_keys)
        or 'test_drive.manage' = any(permission_keys),
      'quotations', 'quotation.view' = any(permission_keys)
        or 'quotation.manage' = any(permission_keys),
      'bookings', 'booking.view' = any(permission_keys)
        or 'booking.manage' = any(permission_keys),
      'vehicles', true,
      'documents', 'document.download' = any(permission_keys),
      'notes', true,
      'timeline', true,
      'exchange', false,
      'finance', false,
      'insurance', false,
      'rto', false,
      'delivery', false,
      'customer_care', false
    ),
    'contacts', contacts_data,
    'addresses', addresses_data,
    'custom_fields', custom_fields_data,
    'notes', notes_data
  );
end;
$$;

revoke all on function public.get_sales_consultant_customer_360_core(uuid)
  from public, anon;
grant execute on function public.get_sales_consultant_customer_360_core(uuid)
  to authenticated;

create or replace function public.get_sales_consultant_customer_360_section(
  target_customer_id uuid,
  target_section text,
  target_page integer default 1,
  target_page_size integer default 25,
  target_cursor_at timestamptz default null,
  target_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_section text := upper(btrim(coalesce(target_section, '')));
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  lead_access boolean;
  section_access boolean := false;
  offset_rows bigint;
  total_rows bigint := 0;
  records_data jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor_at timestamptz;
  next_cursor_id uuid;
begin
  if target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_360_PAGINATION';
  end if;
  if normalized_section not in (
    'LEADS', 'CALLS', 'CONVERSATIONS', 'FOLLOWUPS', 'APPOINTMENTS',
    'TEST_DRIVES', 'QUOTATIONS', 'BOOKINGS', 'VEHICLES', 'DOCUMENTS', 'TIMELINE'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_360_SECTION';
  end if;
  if (target_cursor_at is null) <> (target_cursor_id is null)
    or (normalized_section <> 'TIMELINE'
      and (target_cursor_at is not null or target_cursor_id is not null))
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_360_CURSOR';
  end if;

  select scope_row.organization_id, scope_row.branch_ids, scope_row.permission_keys
  into current_organization_id, allowed_branch_ids, permission_keys
  from app_private.sales_consultant_customer_scope(target_customer_id) scope_row;

  lead_access := 'lead.view' = any(permission_keys);
  section_access := case normalized_section
    when 'LEADS' then lead_access
    when 'CALLS' then 'call.view' = any(permission_keys)
    when 'CONVERSATIONS' then 'message.view' = any(permission_keys)
    when 'FOLLOWUPS' then lead_access and 'followup.view' = any(permission_keys)
    when 'APPOINTMENTS' then 'appointment.view' = any(permission_keys)
    when 'TEST_DRIVES' then 'test_drive.view' = any(permission_keys)
      or 'test_drive.manage' = any(permission_keys)
    when 'QUOTATIONS' then 'quotation.view' = any(permission_keys)
      or 'quotation.manage' = any(permission_keys)
    when 'BOOKINGS' then 'booking.view' = any(permission_keys)
      or 'booking.manage' = any(permission_keys)
    when 'VEHICLES' then true
    when 'DOCUMENTS' then 'document.download' = any(permission_keys)
    when 'TIMELINE' then true
    else false
  end;
  if not section_access then
    raise exception using errcode = '42501', message = 'CUSTOMER_360_SECTION_DENIED';
  end if;

  offset_rows := (target_page - 1)::bigint * target_page_size;

  if normalized_section = 'LEADS' then
    select count(*) into total_rows
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.customer_id = target_customer_id
      and lead_row.assigned_user_id = auth.uid()
      and lead_row.branch_id = any(allowed_branch_ids)
      and lead_row.deleted_at is null;

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.updated_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select lead_row.id, lead_row.source, lead_row.source_detail, lead_row.campaign,
        lead_row.interested_model, lead_row.lifecycle_status, lead_row.temperature,
        branch_row.name as branch_name, profile_row.full_name as assigned_user_name,
        lead_row.created_at, lead_row.updated_at
      from (
        select lead_source.id, lead_source.organization_id, lead_source.branch_id,
          lead_source.assigned_user_id, lead_source.source, lead_source.source_detail,
          lead_source.campaign, lead_source.interested_model,
          lead_source.lifecycle_status, lead_source.temperature,
          lead_source.created_at, lead_source.updated_at
        from public.leads lead_source
        where lead_source.organization_id = current_organization_id
          and lead_source.customer_id = target_customer_id
          and lead_source.assigned_user_id = auth.uid()
          and lead_source.branch_id = any(allowed_branch_ids)
          and lead_source.deleted_at is null
        order by lead_source.updated_at desc, lead_source.id desc
        limit target_page_size offset offset_rows
      ) lead_row
      join public.branches branch_row
        on branch_row.organization_id = lead_row.organization_id
       and branch_row.id = lead_row.branch_id
      left join public.profiles profile_row
        on profile_row.organization_id = lead_row.organization_id
       and profile_row.id = lead_row.assigned_user_id
    ) item;

  elsif normalized_section = 'CALLS' then
    select count(*) into total_rows
    from public.calls call_row
    where call_row.organization_id = current_organization_id
      and call_row.customer_id = target_customer_id
      and call_row.assigned_user_id = auth.uid()
      and call_row.branch_id = any(allowed_branch_ids);

    with page_calls as materialized (
      select call_row.id, call_row.organization_id, call_row.lead_id,
        call_row.assigned_user_id, call_row.direction, call_row.call_source,
        call_row.started_at, call_row.ended_at, call_row.duration_seconds,
        call_row.outcome, call_row.status
      from public.calls call_row
      where call_row.organization_id = current_organization_id
        and call_row.customer_id = target_customer_id
        and call_row.assigned_user_id = auth.uid()
        and call_row.branch_id = any(allowed_branch_ids)
      order by call_row.started_at desc, call_row.id desc
      limit target_page_size offset offset_rows
    ), recordings as materialized (
      select distinct on (recording_row.call_id)
        recording_row.call_id, recording_row.status
      from public.call_recordings recording_row
      join page_calls call_row on call_row.id = recording_row.call_id
      where recording_row.organization_id = current_organization_id
      order by recording_row.call_id, recording_row.created_at desc, recording_row.id desc
    ), transcripts as materialized (
      select distinct on (transcript_row.call_id)
        transcript_row.call_id, transcript_row.status
      from public.call_transcripts transcript_row
      join page_calls call_row on call_row.id = transcript_row.call_id
      where transcript_row.organization_id = current_organization_id
      order by transcript_row.call_id, transcript_row.created_at desc, transcript_row.id desc
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', call_row.id,
      'lead_id', call_row.lead_id,
      'direction', call_row.direction,
      'call_source', call_row.call_source,
      'started_at', call_row.started_at,
      'ended_at', call_row.ended_at,
      'duration_seconds', call_row.duration_seconds,
      'outcome', call_row.outcome,
      'status', call_row.status,
      'assigned_user_name', profile_row.full_name,
      'recording_status', recording_row.status,
      'transcript_status', transcript_row.status
    ) order by call_row.started_at desc, call_row.id desc), '[]'::jsonb)
    into records_data
    from page_calls call_row
    left join public.profiles profile_row
      on profile_row.organization_id = call_row.organization_id
     and profile_row.id = call_row.assigned_user_id
    left join recordings recording_row on recording_row.call_id = call_row.id
    left join transcripts transcript_row on transcript_row.call_id = call_row.id;

  elsif normalized_section = 'CONVERSATIONS' then
    select count(*) into total_rows
    from public.conversations conversation_row
    where conversation_row.organization_id = current_organization_id
      and conversation_row.customer_id = target_customer_id
      and conversation_row.assigned_user_id = auth.uid()
      and conversation_row.branch_id = any(allowed_branch_ids);

    with page_conversations as materialized (
      select conversation_row.id, conversation_row.organization_id,
        conversation_row.lead_id, conversation_row.assigned_user_id,
        conversation_row.channel, conversation_row.status, conversation_row.created_at
      from public.conversations conversation_row
      where conversation_row.organization_id = current_organization_id
        and conversation_row.customer_id = target_customer_id
        and conversation_row.assigned_user_id = auth.uid()
        and conversation_row.branch_id = any(allowed_branch_ids)
      order by conversation_row.created_at desc, conversation_row.id desc
      limit target_page_size offset offset_rows
    ), message_summary as materialized (
      select message_row.conversation_id, count(*)::bigint as message_count,
        max(message_row.sent_at) as latest_message_at
      from public.conversation_messages message_row
      join page_conversations conversation_row
        on conversation_row.id = message_row.conversation_id
      where message_row.organization_id = current_organization_id
      group by message_row.conversation_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', conversation_row.id,
      'lead_id', conversation_row.lead_id,
      'channel', conversation_row.channel,
      'status', conversation_row.status,
      'assigned_user_name', profile_row.full_name,
      'message_count', coalesce(message_row.message_count, 0),
      'latest_message_at', message_row.latest_message_at,
      'created_at', conversation_row.created_at
    ) order by conversation_row.created_at desc, conversation_row.id desc), '[]'::jsonb)
    into records_data
    from page_conversations conversation_row
    left join public.profiles profile_row
      on profile_row.organization_id = conversation_row.organization_id
     and profile_row.id = conversation_row.assigned_user_id
    left join message_summary message_row
      on message_row.conversation_id = conversation_row.id;

  elsif normalized_section = 'FOLLOWUPS' then
    select count(*) into total_rows
    from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.customer_id = target_customer_id
      and followup_row.assigned_user_id = auth.uid()
      and followup_row.branch_id = any(allowed_branch_ids)
      and (
        followup_row.lead_id is null
        or exists (
          select 1 from public.leads lead_row
          where lead_row.organization_id = current_organization_id
            and lead_row.id = followup_row.lead_id
            and lead_row.customer_id = target_customer_id
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(allowed_branch_ids)
            and lead_row.deleted_at is null
        )
      );

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.due_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select followup_row.id, followup_row.lead_id, followup_row.reason,
        followup_row.due_at, followup_row.status, followup_row.completed_at,
        profile_row.full_name as assigned_user_name
      from (
        select followup_source.id, followup_source.organization_id,
          followup_source.assigned_user_id, followup_source.lead_id,
          followup_source.reason, followup_source.due_at, followup_source.status,
          followup_source.completed_at
        from public.followups followup_source
        where followup_source.organization_id = current_organization_id
          and followup_source.customer_id = target_customer_id
          and followup_source.assigned_user_id = auth.uid()
          and followup_source.branch_id = any(allowed_branch_ids)
          and (
            followup_source.lead_id is null
            or exists (
              select 1 from public.leads lead_row
              where lead_row.organization_id = current_organization_id
                and lead_row.id = followup_source.lead_id
                and lead_row.customer_id = target_customer_id
                and lead_row.assigned_user_id = auth.uid()
                and lead_row.branch_id = any(allowed_branch_ids)
                and lead_row.deleted_at is null
            )
          )
        order by followup_source.due_at desc, followup_source.id desc
        limit target_page_size offset offset_rows
      ) followup_row
      left join public.profiles profile_row
        on profile_row.organization_id = followup_row.organization_id
       and profile_row.id = followup_row.assigned_user_id
    ) item;

  elsif normalized_section = 'APPOINTMENTS' then
    select count(*) into total_rows
    from public.appointments appointment_row
    where appointment_row.organization_id = current_organization_id
      and appointment_row.customer_id = target_customer_id
      and appointment_row.assigned_user_id = auth.uid()
      and appointment_row.branch_id = any(allowed_branch_ids)
      and (
        appointment_row.lead_id is null
        or (lead_access and exists (
          select 1 from public.leads lead_row
          where lead_row.organization_id = current_organization_id
            and lead_row.id = appointment_row.lead_id
            and lead_row.customer_id = target_customer_id
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(allowed_branch_ids)
            and lead_row.deleted_at is null
        ))
      );

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.scheduled_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select appointment_row.id, appointment_row.lead_id,
        appointment_row.appointment_type, appointment_row.scheduled_at,
        appointment_row.status, appointment_row.attendance_status,
        profile_row.full_name as assigned_user_name,
        branch_row.name as branch_name
      from (
        select appointment_source.id, appointment_source.organization_id,
          appointment_source.branch_id, appointment_source.assigned_user_id,
          appointment_source.lead_id, appointment_source.appointment_type,
          appointment_source.scheduled_at, appointment_source.status,
          appointment_source.attendance_status
        from public.appointments appointment_source
        where appointment_source.organization_id = current_organization_id
          and appointment_source.customer_id = target_customer_id
          and appointment_source.assigned_user_id = auth.uid()
          and appointment_source.branch_id = any(allowed_branch_ids)
          and (
            appointment_source.lead_id is null
            or (lead_access and exists (
              select 1 from public.leads lead_row
              where lead_row.organization_id = current_organization_id
                and lead_row.id = appointment_source.lead_id
                and lead_row.customer_id = target_customer_id
                and lead_row.assigned_user_id = auth.uid()
                and lead_row.branch_id = any(allowed_branch_ids)
                and lead_row.deleted_at is null
            ))
          )
        order by appointment_source.scheduled_at desc, appointment_source.id desc
        limit target_page_size offset offset_rows
      ) appointment_row
      join public.branches branch_row
        on branch_row.organization_id = appointment_row.organization_id
       and branch_row.id = appointment_row.branch_id
      left join public.profiles profile_row
        on profile_row.organization_id = appointment_row.organization_id
       and profile_row.id = appointment_row.assigned_user_id
    ) item;

  elsif normalized_section = 'TEST_DRIVES' then
    select count(*) into total_rows
    from public.test_drives drive_row
    where drive_row.organization_id = current_organization_id
      and drive_row.customer_id = target_customer_id
      and drive_row.assigned_user_id = auth.uid()
      and drive_row.branch_id = any(allowed_branch_ids);

    select coalesce(jsonb_agg((to_jsonb(item) - 'created_at')
      order by item.created_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select drive_row.id, drive_row.lead_id, drive_row.status,
        drive_row.started_at, drive_row.completed_at, drive_row.distance_meters,
        drive_row.duration_seconds, profile_row.full_name as assigned_user_name,
        branch_row.name as branch_name, drive_row.created_at
      from (
        select drive_source.id, drive_source.organization_id,
          drive_source.branch_id, drive_source.assigned_user_id,
          drive_source.lead_id, drive_source.status, drive_source.started_at,
          drive_source.completed_at, drive_source.distance_meters,
          drive_source.duration_seconds, drive_source.created_at
        from public.test_drives drive_source
        where drive_source.organization_id = current_organization_id
          and drive_source.customer_id = target_customer_id
          and drive_source.assigned_user_id = auth.uid()
          and drive_source.branch_id = any(allowed_branch_ids)
        order by drive_source.created_at desc, drive_source.id desc
        limit target_page_size offset offset_rows
      ) drive_row
      join public.branches branch_row
        on branch_row.organization_id = drive_row.organization_id
       and branch_row.id = drive_row.branch_id
      left join public.profiles profile_row
        on profile_row.organization_id = drive_row.organization_id
       and profile_row.id = drive_row.assigned_user_id
    ) item;

  elsif normalized_section = 'QUOTATIONS' then
    select count(*) into total_rows
    from public.quotations quotation_row
    where quotation_row.organization_id = current_organization_id
      and quotation_row.customer_id = target_customer_id
      and quotation_row.assigned_user_id = auth.uid()
      and quotation_row.branch_id = any(allowed_branch_ids)
      and quotation_row.deleted_at is null;

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.updated_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select quotation_row.id, quotation_row.lead_id, quotation_row.quotation_number,
        quotation_row.status, quotation_row.current_version, quotation_row.total_amount,
        quotation_row.approval_status, quotation_row.created_at, quotation_row.updated_at
      from public.quotations quotation_row
      where quotation_row.organization_id = current_organization_id
        and quotation_row.customer_id = target_customer_id
        and quotation_row.assigned_user_id = auth.uid()
        and quotation_row.branch_id = any(allowed_branch_ids)
        and quotation_row.deleted_at is null
      order by quotation_row.updated_at desc, quotation_row.id desc
      limit target_page_size offset offset_rows
    ) item;

  elsif normalized_section = 'BOOKINGS' then
    select count(*) into total_rows
    from public.bookings booking_row
    where booking_row.organization_id = current_organization_id
      and booking_row.customer_id = target_customer_id
      and booking_row.assigned_user_id = auth.uid()
      and booking_row.branch_id = any(allowed_branch_ids)
      and booking_row.deleted_at is null;

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.updated_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select booking_row.id, booking_row.lead_id, booking_row.booking_number,
        booking_row.status, booking_row.booking_amount, booking_row.total_value,
        booking_row.finance_required, booking_row.exchange_required,
        booking_row.expected_delivery_date, booking_row.created_at, booking_row.updated_at
      from public.bookings booking_row
      where booking_row.organization_id = current_organization_id
        and booking_row.customer_id = target_customer_id
        and booking_row.assigned_user_id = auth.uid()
        and booking_row.branch_id = any(allowed_branch_ids)
        and booking_row.deleted_at is null
      order by booking_row.updated_at desc, booking_row.id desc
      limit target_page_size offset offset_rows
    ) item;

  elsif normalized_section = 'VEHICLES' then
    select count(*) into total_rows
    from public.customer_vehicles vehicle_row
    where vehicle_row.organization_id = current_organization_id
      and vehicle_row.customer_id = target_customer_id;

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.created_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select vehicle_row.id, vehicle_row.registration, vehicle_row.brand,
        vehicle_row.model, vehicle_row.variant, vehicle_row.model_year,
        vehicle_row.created_at
      from public.customer_vehicles vehicle_row
      where vehicle_row.organization_id = current_organization_id
        and vehicle_row.customer_id = target_customer_id
      order by vehicle_row.created_at desc, vehicle_row.id desc
      limit target_page_size offset offset_rows
    ) item;

  elsif normalized_section = 'DOCUMENTS' then
    select count(*) into total_rows
    from public.object_files object_row
    where object_row.organization_id = current_organization_id
      and lower(object_row.resource_type) = 'customer'
      and object_row.resource_id = target_customer_id
      and object_row.deleted_at is null
      and (
        object_row.branch_id is null
        or object_row.branch_id = any(allowed_branch_ids)
      );

    select coalesce(jsonb_agg(to_jsonb(item)
      order by item.created_at desc, item.id desc), '[]'::jsonb)
    into records_data
    from (
      select object_row.id, object_row.original_file_name as file_name,
        object_row.mime_type, object_row.size_bytes, object_row.created_at
      from public.object_files object_row
      where object_row.organization_id = current_organization_id
        and lower(object_row.resource_type) = 'customer'
        and object_row.resource_id = target_customer_id
        and object_row.deleted_at is null
        and (
          object_row.branch_id is null
          or object_row.branch_id = any(allowed_branch_ids)
        )
      order by object_row.created_at desc, object_row.id desc
      limit target_page_size offset offset_rows
    ) item;

  elsif normalized_section = 'TIMELINE' then
    select count(*) into total_rows
    from public.activities activity_row
    where activity_row.organization_id = current_organization_id
      and activity_row.customer_id = target_customer_id
      and (
        (
          activity_row.lead_id is null
          and activity_row.activity_type in (
            'CUSTOMER_CREATED', 'CUSTOMER_CREATED_AND_LINKED', 'CUSTOMER_LINKED',
            'CUSTOMER_UPDATED', 'NOTE_ADDED'
          )
        )
        or (
          lead_access
          and exists (
            select 1 from public.leads lead_row
            where lead_row.organization_id = current_organization_id
              and lead_row.id = activity_row.lead_id
              and lead_row.customer_id = target_customer_id
              and lead_row.assigned_user_id = auth.uid()
              and lead_row.branch_id = any(allowed_branch_ids)
              and lead_row.deleted_at is null
          )
        )
      );

    with page_source as materialized (
      select activity_row.id, activity_row.lead_id, activity_row.activity_type,
        profile_row.full_name as actor_name, activity_row.occurred_at
      from public.activities activity_row
      left join public.profiles profile_row
        on profile_row.organization_id = activity_row.organization_id
       and profile_row.id = activity_row.actor_id
      where activity_row.organization_id = current_organization_id
        and activity_row.customer_id = target_customer_id
        and (
          (
            activity_row.lead_id is null
            and activity_row.activity_type in (
              'CUSTOMER_CREATED', 'CUSTOMER_CREATED_AND_LINKED', 'CUSTOMER_LINKED',
              'CUSTOMER_UPDATED', 'NOTE_ADDED'
            )
          )
          or (
            lead_access
            and exists (
              select 1 from public.leads lead_row
              where lead_row.organization_id = current_organization_id
                and lead_row.id = activity_row.lead_id
                and lead_row.customer_id = target_customer_id
                and lead_row.assigned_user_id = auth.uid()
                and lead_row.branch_id = any(allowed_branch_ids)
                and lead_row.deleted_at is null
            )
          )
        )
        and (
          target_cursor_at is null
          or (activity_row.occurred_at, activity_row.id)
            < (target_cursor_at, target_cursor_id)
        )
      order by activity_row.occurred_at desc, activity_row.id desc
      limit target_page_size + 1
      offset case when target_cursor_at is null then offset_rows else 0 end
    ), visible_page as materialized (
      select id, lead_id, activity_type, actor_name, occurred_at
      from page_source
      order by occurred_at desc, id desc
      limit target_page_size
    )
    select
      coalesce((
        select jsonb_agg(to_jsonb(activity_row)
          order by activity_row.occurred_at desc, activity_row.id desc)
        from visible_page activity_row
      ), '[]'::jsonb),
      (select count(*) > target_page_size from page_source),
      (select activity_row.occurred_at from visible_page activity_row
        order by activity_row.occurred_at, activity_row.id limit 1),
      (select activity_row.id from visible_page activity_row
        order by activity_row.occurred_at, activity_row.id limit 1)
    into records_data, has_more, next_cursor_at, next_cursor_id;

    if not has_more then
      next_cursor_at := null;
      next_cursor_id := null;
    end if;
  end if;

  if normalized_section <> 'TIMELINE' then
    has_more := total_rows > (target_page::bigint * target_page_size);
  end if;

  return jsonb_build_object(
    'section', lower(normalized_section),
    'records', records_data,
    'total', total_rows,
    'page', target_page,
    'page_size', target_page_size,
    'has_more', has_more,
    'next_cursor', case
      when next_cursor_at is null or next_cursor_id is null then null
      else jsonb_build_object('occurred_at', next_cursor_at, 'id', next_cursor_id)
    end
  );
end;
$$;

revoke all on function public.get_sales_consultant_customer_360_section(
  uuid, text, integer, integer, timestamptz, uuid
) from public, anon;
grant execute on function public.get_sales_consultant_customer_360_section(
  uuid, text, integer, integer, timestamptz, uuid
) to authenticated;

commit;
