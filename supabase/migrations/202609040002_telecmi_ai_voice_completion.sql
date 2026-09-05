begin;

-- A crashed worker at its final numbered attempt must still be recoverable after
-- the lease expires. External stages use stable idempotency references, so the
-- same attempt can safely resume without charging or creating a second result.
drop function if exists public.claim_ai_call_processing_jobs(text, integer);
create or replace function public.claim_ai_call_processing_jobs(
  target_worker_id text,
  target_batch_size integer default 2
)
returns table (
  id uuid, organization_id uuid, branch_id uuid, call_id uuid, lead_id uuid,
  recording_id uuid, lease_token uuid, object_bucket text, object_key text,
  mime_type text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_worker_id), '') is null
    or target_batch_size not between 1 and 10 then
    raise exception using errcode = '22023', message = 'INVALID_AI_CALL_CLAIM';
  end if;
  return query
  with candidates as (
    select job_row.id
    from public.ai_call_processing_jobs job_row
    where (
      (job_row.status in ('QUEUED', 'RETRY') and job_row.attempt_count < 7)
      or (
        job_row.status = 'PROCESSING'
        and job_row.lease_expires_at < now()
        and job_row.attempt_count <= 7
      )
    )
    order by job_row.created_at, job_row.id
    limit target_batch_size
    for update skip locked
  ), claimed as (
    update public.ai_call_processing_jobs job_row
    set status = 'PROCESSING',
        attempt_count = least(7, job_row.attempt_count + 1),
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + interval '15 minutes',
        safe_error_code = null,
        updated_at = now()
    from candidates
    where job_row.id = candidates.id
    returning job_row.*
  )
  select claimed.id, claimed.organization_id, claimed.branch_id, claimed.call_id,
    call_row.lead_id, claimed.recording_id, claimed.lease_token,
    file_row.bucket, file_row.object_key, file_row.mime_type
  from claimed
  join public.calls call_row
    on call_row.id = claimed.call_id
   and call_row.organization_id = claimed.organization_id
  join public.call_recordings recording_row
    on recording_row.id = claimed.recording_id
   and recording_row.organization_id = claimed.organization_id
  join public.object_files file_row
    on file_row.id = recording_row.object_file_id
   and file_row.organization_id = claimed.organization_id
   and file_row.resource_type = 'call'
   and file_row.resource_id = claimed.call_id
   and file_row.deleted_at is null;
end;
$$;

-- New automated voice calls are identified by call_mode and their configured
-- agent, not by the retired connected-account capability from the old screen.
create or replace function public.get_ai_voice_call_workspace(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.view') then
    raise exception using errcode = '42501', message = 'AI_VOICE_CALL_VIEW_PERMISSION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in ('ALL', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception using errcode = '22023', message = 'INVALID_AI_VOICE_CALL_STATUS_FILTER';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);

  return (
    with scoped_calls as materialized (
      select
        call_row.id,
        call_row.organization_id,
        call_row.lead_id,
        call_row.customer_id,
        call_row.started_at,
        call_row.ended_at,
        call_row.duration_seconds,
        call_row.outcome,
        call_row.status,
        coalesce(agent_row.name, 'AI voice agent') as provider_name,
        branch_row.name as branch_name,
        telecaller_row.full_name as telecaller_name,
        case
          when app_private.has_permission(current_organization_id, 'customer.view')
            and customer_row.id is not null
            and app_private.can_access_customer(current_organization_id, customer_row.id)
            then customer_row.full_name
          when app_private.has_permission(current_organization_id, 'lead.view')
            and lead_row.id is not null and app_private.can_access_lead(lead_row.id)
            then lead_row.customer_name
          else null
        end as customer_name,
        case
          when app_private.has_permission(current_organization_id, 'customer.view')
            and customer_row.id is not null
            and app_private.can_access_customer(current_organization_id, customer_row.id)
            then customer_row.primary_phone
          when app_private.has_permission(current_organization_id, 'lead.view')
            and lead_row.id is not null and app_private.can_access_lead(lead_row.id)
            then lead_row.phone
          else null
        end as phone,
        case
          when app_private.has_permission(current_organization_id, 'customer.view')
            and customer_row.id is not null
            and app_private.can_access_customer(current_organization_id, customer_row.id)
            then app_private.normalize_phone_digits(customer_row.normalized_phone)
          when app_private.has_permission(current_organization_id, 'lead.view')
            and lead_row.id is not null and app_private.can_access_lead(lead_row.id)
            then app_private.normalize_phone_digits(lead_row.normalized_phone)
          else ''
        end as search_phone
      from public.calls call_row
      left join public.ai_voice_agents agent_row
        on agent_row.organization_id = call_row.organization_id
       and agent_row.id = call_row.ai_voice_agent_id
      join public.branches branch_row
        on branch_row.organization_id = call_row.organization_id
       and branch_row.id = call_row.branch_id
      join public.profiles telecaller_row
        on telecaller_row.organization_id = call_row.organization_id
       and telecaller_row.id = call_row.assigned_user_id
      left join public.leads lead_row
        on lead_row.organization_id = call_row.organization_id
       and lead_row.id = call_row.lead_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on customer_row.organization_id = call_row.organization_id
       and customer_row.id = coalesce(call_row.customer_id, lead_row.customer_id)
       and customer_row.deleted_at is null
      where call_row.organization_id = current_organization_id
        and call_row.call_source = 'PROVIDER'
        and call_row.call_mode = 'AI_AGENT'
        and app_private.can_access_record(
          call_row.organization_id, call_row.branch_id,
          call_row.team_id, call_row.assigned_user_id
        )
    ), filtered_calls as materialized (
      select * from scoped_calls
      where (
        normalized_status = 'ALL'
        or (normalized_status = 'PENDING' and upper(status) in ('PENDING', 'RINGING', 'IN_PROGRESS'))
        or upper(status) = normalized_status
      )
      and (
        normalized_search = ''
        or lower(coalesce(customer_name, '')) like '%' || normalized_search || '%'
        or lower(provider_name) like '%' || normalized_search || '%'
        or lower(branch_name) like '%' || normalized_search || '%'
        or lower(telecaller_name) like '%' || normalized_search || '%'
        or (search_phone_digits <> '' and search_phone like '%' || search_phone_digits || '%')
      )
    ), page_rows as materialized (
      select * from filtered_calls
      order by started_at desc, id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'generated_at', now(),
      'records', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', page_row.id,
          'lead_id', page_row.lead_id,
          'customer_id', page_row.customer_id,
          'customer_name', page_row.customer_name,
          'phone', page_row.phone,
          'provider_name', page_row.provider_name,
          'branch_name', page_row.branch_name,
          'telecaller_name', page_row.telecaller_name,
          'status', page_row.status,
          'outcome', page_row.outcome,
          'started_at', page_row.started_at,
          'ended_at', page_row.ended_at,
          'duration_seconds', page_row.duration_seconds,
          'recording_available', exists (
            select 1 from public.call_recordings recording_row
            join public.object_files file_row
              on file_row.organization_id = recording_row.organization_id
             and file_row.id = recording_row.object_file_id
             and file_row.resource_type = 'call'
             and file_row.resource_id = recording_row.call_id
             and file_row.deleted_at is null
            where recording_row.organization_id = page_row.organization_id
              and recording_row.call_id = page_row.id
          ),
          'transcript_available', exists (
            select 1 from public.call_transcripts transcript_row
            where transcript_row.organization_id = page_row.organization_id
              and transcript_row.call_id = page_row.id
              and upper(transcript_row.status) in ('READY', 'COMPLETED')
          )
        ) order by page_row.started_at desc, page_row.id desc)
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select count(*)::integer from filtered_calls),
      'kpis', jsonb_build_object(
        'initiated_today', (select count(*)::integer from scoped_calls
          where started_at >= date_trunc('day', now())),
        'connected_today', (select count(*)::integer from scoped_calls
          where started_at >= date_trunc('day', now())
            and (upper(coalesce(outcome, '')) = 'CONNECTED'
              or upper(status) in ('IN_PROGRESS', 'COMPLETED'))),
        'callbacks_open', (select count(*)::integer from scoped_calls
          where upper(coalesce(outcome, '')) = 'CALLBACK_REQUIRED'),
        'recordings_ready_today', (select count(*)::integer from scoped_calls scoped_row
          where scoped_row.started_at >= date_trunc('day', now()) and exists (
            select 1 from public.call_recordings recording_row
            join public.object_files file_row
              on file_row.organization_id = recording_row.organization_id
             and file_row.id = recording_row.object_file_id
             and file_row.resource_type = 'call'
             and file_row.resource_id = recording_row.call_id
             and file_row.deleted_at is null
            where recording_row.organization_id = scoped_row.organization_id
              and recording_row.call_id = scoped_row.id
          ))
      ),
      'has_verified_provider', exists (
        select 1 from public.ai_voice_agents agent_row
        where agent_row.organization_id = current_organization_id
          and agent_row.active and agent_row.auto_call_enabled
          and agent_row.deleted_at is null
          and app_private.can_access_branch(current_organization_id, agent_row.branch_id)
      )
    )
  );
end;
$$;

-- Keep the base call-detail RPC stable and fetch the bounded speaker projection
-- separately. This lets web and mobile render two people without returning an
-- unbounded transcript JSON document.
create or replace function public.get_call_speaker_transcript(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare call_record public.calls%rowtype; result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_record from public.calls where id = target_call_id;
  if not found then raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND'; end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id, call_record.branch_id,
      call_record.team_id, call_record.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select jsonb_build_object(
    'speaker_turns', coalesce((
      select jsonb_agg(turn_row.value order by turn_row.ordinality)
      from jsonb_array_elements(coalesce(transcript_row.speaker_turns, '[]'::jsonb))
        with ordinality as turn_row(value, ordinality)
      where turn_row.ordinality <= 500
    ), '[]'::jsonb),
    'speaker_separation_method', transcript_row.speaker_separation_method,
    'truncated', jsonb_array_length(coalesce(transcript_row.speaker_turns, '[]'::jsonb)) > 500
  ) into result
  from public.call_transcripts transcript_row
  where transcript_row.organization_id = call_record.organization_id
    and transcript_row.call_id = call_record.id
  order by transcript_row.created_at desc, transcript_row.id desc
  limit 1;
  return coalesce(result, jsonb_build_object(
    'speaker_turns', '[]'::jsonb,
    'speaker_separation_method', null,
    'truncated', false
  ));
end;
$$;

create unique index if not exists ai_field_review_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action = 'ai_call_fields.reviewed';

create or replace function public.get_ai_call_field_review(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare call_record public.calls%rowtype;
  extraction_record public.ai_extraction_runs%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_record from public.calls where id = target_call_id;
  if not found then raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND'; end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id, call_record.branch_id,
      call_record.team_id, call_record.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select * into extraction_record from public.ai_extraction_runs extraction_row
  where extraction_row.organization_id = call_record.organization_id
    and extraction_row.call_id = call_record.id
  order by extraction_row.created_at desc, extraction_row.id desc
  limit 1;

  return jsonb_build_object(
    'call', jsonb_build_object(
      'id', call_record.id,
      'lead_id', call_record.lead_id,
      'customer_name', coalesce(customer_row.full_name, lead_row.customer_name, 'Customer'),
      'phone', coalesce(customer_row.primary_phone, lead_row.phone, ''),
      'interested_model', lead_row.interested_model,
      'started_at', call_record.started_at,
      'duration_seconds', call_record.duration_seconds
    ),
    'transcript', (
      select jsonb_build_object(
        'text', left(transcript_row.transcript_text, 100000),
        'language', transcript_row.language,
        'speaker_turns', coalesce((
          select jsonb_agg(turn_row.value order by turn_row.ordinality)
          from jsonb_array_elements(coalesce(transcript_row.speaker_turns, '[]'::jsonb))
            with ordinality as turn_row(value, ordinality)
          where turn_row.ordinality <= 500
        ), '[]'::jsonb),
        'speaker_separation_method', transcript_row.speaker_separation_method,
        'truncated', char_length(coalesce(transcript_row.transcript_text, '')) > 100000
          or jsonb_array_length(coalesce(transcript_row.speaker_turns, '[]'::jsonb)) > 500
      ) from public.call_transcripts transcript_row
      where transcript_row.organization_id = call_record.organization_id
        and transcript_row.call_id = call_record.id
      order by transcript_row.created_at desc, transcript_row.id desc limit 1
    ),
    'summary', (
      select left(summary_row.summary, 20000) from public.ai_call_summaries summary_row
      where summary_row.organization_id = call_record.organization_id
        and summary_row.call_id = call_record.id
      order by summary_row.created_at desc, summary_row.id desc limit 1
    ),
    'extraction', case when extraction_record.id is null then null else jsonb_build_object(
      'id', extraction_record.id,
      'status', extraction_record.status,
      'created_at', extraction_record.created_at,
      'fields', coalesce((
        select jsonb_agg(jsonb_build_object(
          'field_key', suggested.key,
          'suggested_value', suggested.value,
          'current_value', case suggested.key
            when 'customer_name' then to_jsonb(coalesce(customer_row.full_name, lead_row.customer_name))
            when 'phone' then to_jsonb(coalesce(customer_row.primary_phone, lead_row.phone))
            when 'email' then to_jsonb(coalesce(customer_row.primary_email, lead_row.email))
            else to_jsonb(lead_row) -> suggested.key
          end,
          'decision', coalesce(review_row.decision, 'PENDING'),
          'applied_value', review_row.applied_value
        ) order by suggested.key)
        from jsonb_each(extraction_record.suggestions) suggested
        left join lateral (
          select field_review.decision, field_review.applied_value
          from public.ai_field_reviews field_review
          where field_review.extraction_run_id = extraction_record.id
            and field_review.field_key = suggested.key
          order by field_review.reviewed_at desc nulls last, field_review.id desc limit 1
        ) review_row on true
      ), '[]'::jsonb)
    ) end
  )
  from public.leads lead_row
  left join public.customers customer_row
    on customer_row.organization_id = call_record.organization_id
   and customer_row.id = coalesce(call_record.customer_id, lead_row.customer_id)
   and customer_row.deleted_at is null
  where lead_row.organization_id = call_record.organization_id
    and lead_row.id = call_record.lead_id;
end;
$$;

create or replace function public.review_ai_call_fields(
  target_extraction_run_id uuid,
  target_decisions jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare extraction_record public.ai_extraction_runs%rowtype;
  lead_record public.leads%rowtype;
  updated_lead public.leads%rowtype;
  customer_record public.customers%rowtype;
  decision_row record;
  resolved_value jsonb;
  lead_patch jsonb := '{}'::jsonb;
  existing_review_id uuid;
  primary_contact_id uuid;
  accepted_fields text[] := array[]::text[];
  previous_metadata jsonb;
  result jsonb;
  customer_identity_requested boolean := false;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null or jsonb_typeof(target_decisions) <> 'array'
    or jsonb_array_length(target_decisions) not between 1 and 8
    or exists (
      select 1 from jsonb_array_elements(target_decisions) decision(value)
      where jsonb_typeof(decision.value) <> 'object'
        or nullif(btrim(decision.value ->> 'field_key'), '') is null
        or upper(coalesce(decision.value ->> 'decision', '')) not in ('APPLIED', 'REJECTED', 'EDITED')
    )
    or exists (
      select 1 from (
        select decision.value ->> 'field_key' as field_key, count(*)
        from jsonb_array_elements(target_decisions) decision(value)
        group by decision.value ->> 'field_key'
        having count(*) > 1
      ) duplicate_decision
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AI_FIELD_REVIEW_REQUEST';
  end if;
  select * into extraction_record from public.ai_extraction_runs
  where id = target_extraction_run_id for update;
  if not found or extraction_record.call_id is null or extraction_record.lead_id is null then
    raise exception using errcode = 'P0002', message = 'AI_FIELD_REVIEW_NOT_FOUND';
  end if;
  select * into lead_record from public.leads
  where id = extraction_record.lead_id
    and organization_id = extraction_record.organization_id
    and deleted_at is null
  for update;
  if not found or not app_private.has_permission(lead_record.organization_id, 'lead.update')
    or not app_private.can_access_lead(lead_record.id)
    or not exists (
      select 1 from public.calls call_row
      where call_row.id = extraction_record.call_id
        and call_row.organization_id = extraction_record.organization_id
        and call_row.lead_id = extraction_record.lead_id
    ) then
    raise exception using errcode = '42501', message = 'LEAD_UPDATE_PERMISSION_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_extraction_run_id::text, 0));
  select audit_row.metadata into previous_metadata from public.audit_logs audit_row
  where audit_row.organization_id = extraction_record.organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'ai_call_fields.reviewed';
  if found then
    if previous_metadata ->> 'extraction_run_id' is distinct from target_extraction_run_id::text then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata -> 'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  for decision_row in
    select value ->> 'field_key' as field_key,
      upper(value ->> 'decision') as decision,
      value -> 'value' as edited_value
    from jsonb_array_elements(target_decisions)
  loop
    if decision_row.field_key not in (
      'customer_name', 'phone', 'email', 'interested_model', 'lifecycle_status',
      'temperature', 'next_followup_at', 'lost_reason'
    ) then
      raise exception using errcode = '22023', message = 'INVALID_AI_FIELD_REVIEW_DECISION';
    end if;
    if not extraction_record.suggestions ? decision_row.field_key then
      raise exception using errcode = '22023', message = 'AI_FIELD_NOT_SUGGESTED';
    end if;
    resolved_value := case when decision_row.decision = 'EDITED'
      then decision_row.edited_value
      else extraction_record.suggestions -> decision_row.field_key end;
    if decision_row.decision = 'EDITED' and resolved_value is null then
      raise exception using errcode = '22023', message = 'AI_FIELD_EDIT_VALUE_REQUIRED';
    end if;
    if decision_row.decision in ('APPLIED', 'EDITED') then
      lead_patch := lead_patch || jsonb_build_object(decision_row.field_key, resolved_value);
      accepted_fields := array_append(accepted_fields, decision_row.field_key);
      if decision_row.field_key in ('customer_name', 'phone', 'email') then
        customer_identity_requested := true;
      end if;
    end if;
  end loop;

  if lead_patch ? 'lost_reason'
    and coalesce(lead_patch ->> 'lifecycle_status', lead_record.lifecycle_status::text) <> 'Lost' then
    raise exception using errcode = '22023', message = 'LOST_REASON_REQUIRES_LOST_STATUS';
  end if;
  if customer_identity_requested and lead_record.customer_id is not null then
    if not app_private.has_permission(lead_record.organization_id, 'customer.update')
      or not app_private.can_access_customer(lead_record.organization_id, lead_record.customer_id) then
      raise exception using errcode = '42501', message = 'CUSTOMER_UPDATE_PERMISSION_REQUIRED';
    end if;
    select * into customer_record from public.customers
    where id = lead_record.customer_id
      and organization_id = lead_record.organization_id
      and deleted_at is null
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'LINKED_CUSTOMER_NOT_FOUND';
    end if;
  end if;

  updated_lead := lead_record;
  if lead_patch <> '{}'::jsonb then
    select * into updated_lead from public.update_lead(
      lead_record.id,
      lead_record.updated_at,
      lead_patch,
      'Approved AI call extraction'
    );
  end if;

  if customer_identity_requested and customer_record.id is not null then
    update public.customers set
      full_name = case when lead_patch ? 'customer_name'
        then updated_lead.customer_name else full_name end,
      primary_phone = case when lead_patch ? 'phone'
        then updated_lead.phone else primary_phone end,
      normalized_phone = case when lead_patch ? 'phone'
        then app_private.normalize_phone_digits(updated_lead.phone) else normalized_phone end,
      primary_email = case when lead_patch ? 'email'
        then updated_lead.email else primary_email end,
      updated_at = now()
    where id = customer_record.id and organization_id = customer_record.organization_id;

    if lead_patch ? 'phone' then
      select contact_row.id into primary_contact_id
      from public.customer_contacts contact_row
      where contact_row.organization_id = customer_record.organization_id
        and contact_row.customer_id = customer_record.id and contact_row.type = 'PHONE'
      order by contact_row.is_primary desc, contact_row.created_at, contact_row.id limit 1;
      update public.customer_contacts set is_primary = false
      where organization_id = customer_record.organization_id
        and customer_id = customer_record.id and type = 'PHONE';
      if primary_contact_id is null then
        insert into public.customer_contacts (
          organization_id, customer_id, type, value, normalized_value, is_primary
        ) values (
          customer_record.organization_id, customer_record.id, 'PHONE', updated_lead.phone,
          app_private.normalize_phone_digits(updated_lead.phone), true
        );
      else
        update public.customer_contacts set value = updated_lead.phone,
          normalized_value = app_private.normalize_phone_digits(updated_lead.phone),
          is_primary = true
        where id = primary_contact_id
          and organization_id = customer_record.organization_id;
      end if;
    end if;
    if lead_patch ? 'email' then
      primary_contact_id := null;
      select contact_row.id into primary_contact_id
      from public.customer_contacts contact_row
      where contact_row.organization_id = customer_record.organization_id
        and contact_row.customer_id = customer_record.id and contact_row.type = 'EMAIL'
      order by contact_row.is_primary desc, contact_row.created_at, contact_row.id limit 1;
      update public.customer_contacts set is_primary = false
      where organization_id = customer_record.organization_id
        and customer_id = customer_record.id and type = 'EMAIL';
      if updated_lead.email is not null then
        if primary_contact_id is null then
          insert into public.customer_contacts (
            organization_id, customer_id, type, value, normalized_value, is_primary
          ) values (
            customer_record.organization_id, customer_record.id, 'EMAIL', updated_lead.email,
            lower(updated_lead.email), true
          );
        else
          update public.customer_contacts set value = updated_lead.email,
            normalized_value = lower(updated_lead.email), is_primary = true
          where id = primary_contact_id
            and organization_id = customer_record.organization_id;
        end if;
      end if;
    end if;
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
    ) values (
      customer_record.organization_id, auth.uid(), 'customer.ai_fields_approved',
      'customer', customer_record.id::text, lead_record.branch_id,
      jsonb_build_object('lead_id', lead_record.id, 'extraction_run_id', extraction_record.id,
        'approved_identity_fields', to_jsonb(accepted_fields))
    );
  end if;

  for decision_row in
    select value ->> 'field_key' as field_key,
      upper(value ->> 'decision') as decision,
      value -> 'value' as edited_value
    from jsonb_array_elements(target_decisions)
  loop
    resolved_value := case when decision_row.decision = 'EDITED'
      then decision_row.edited_value
      else extraction_record.suggestions -> decision_row.field_key end;
    existing_review_id := null;
    select id into existing_review_id from public.ai_field_reviews
    where extraction_run_id = extraction_record.id
      and field_key = decision_row.field_key
    order by reviewed_at desc nulls last, id desc limit 1 for update;
    if existing_review_id is null then
      insert into public.ai_field_reviews (
        organization_id, extraction_run_id, field_key, suggested_value,
        applied_value, decision, reviewed_by, reviewed_at
      ) values (
        extraction_record.organization_id, extraction_record.id, decision_row.field_key,
        extraction_record.suggestions -> decision_row.field_key,
        case when decision_row.decision in ('APPLIED', 'EDITED') then resolved_value else null end,
        decision_row.decision, auth.uid(), now()
      );
    else
      update public.ai_field_reviews set
        suggested_value = extraction_record.suggestions -> decision_row.field_key,
        applied_value = case when decision_row.decision in ('APPLIED', 'EDITED')
          then resolved_value else null end,
        decision = decision_row.decision, reviewed_by = auth.uid(), reviewed_at = now()
      where id = existing_review_id;
    end if;
  end loop;

  result := jsonb_build_object(
    'lead_id', lead_record.id,
    'customer_id', lead_record.customer_id,
    'accepted_fields', to_jsonb(accepted_fields),
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    extraction_record.organization_id, auth.uid(), 'ai_call_fields.reviewed',
    'ai_extraction_run', extraction_record.id::text, lead_record.branch_id,
    target_request_id, jsonb_build_object(
      'extraction_run_id', extraction_record.id,
      'lead_id', lead_record.id,
      'accepted_fields', to_jsonb(accepted_fields),
      'result', result
    )
  );
  return result;
end;
$$;

revoke all on function public.claim_ai_call_processing_jobs(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_ai_call_processing_jobs(text, integer)
  to service_role;
revoke all on function public.get_ai_voice_call_workspace(text, integer, integer, text),
  public.get_call_speaker_transcript(uuid), public.get_ai_call_field_review(uuid),
  public.review_ai_call_fields(uuid, jsonb, uuid)
  from public, anon;
grant execute on function public.get_ai_voice_call_workspace(text, integer, integer, text),
  public.get_call_speaker_transcript(uuid), public.get_ai_call_field_review(uuid),
  public.review_ai_call_fields(uuid, jsonb, uuid)
  to authenticated;

commit;
