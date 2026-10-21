-- AI call suggestions cover the lead's requirements (product decision 2026-10-21).
--
-- AGENTS.md section 19 lists variant, budget, purchase timeline, finance,
-- exchange, test drive and competitor mentions among the fields AI may suggest;
-- the worker only offered identity, stage, temperature and follow-up. These keys
-- are now accepted from the worker, reviewed like the rest (Suggest -> Review ->
-- Apply) and, once approved, written through update_lead_requirements so the
-- version check and audit trail stay in one place.
--
-- The three bodies below were checked against pg_get_functiondef on the live
-- project before editing (2026-10-21); only the key lists, the decision limit
-- and the requirements branch differ.

begin;

create or replace function public.save_ai_call_analysis_result(
  target_job_id uuid,
  target_lease_token uuid,
  target_normalized_transcript text,
  target_speaker_turns jsonb,
  target_separation_method text,
  target_summary text,
  target_suggestions jsonb,
  target_analysis_model_reference text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.ai_call_processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_normalized_transcript), '') is null
    or char_length(target_normalized_transcript) > 1000000
    or jsonb_typeof(target_speaker_turns) <> 'array'
    or jsonb_array_length(target_speaker_turns) > 10000
    or jsonb_typeof(target_suggestions) <> 'object'
    or exists (
      select 1 from jsonb_array_elements(target_speaker_turns) turn
      where jsonb_typeof(turn) <> 'object'
        or coalesce(turn ->> 'speaker', '') not in ('AGENT', 'CUSTOMER', 'UNKNOWN')
        or nullif(btrim(turn ->> 'text'), '') is null
        or char_length(turn ->> 'text') > 12000
    )
    or exists (
      select 1 from jsonb_object_keys(target_suggestions) suggestion_key
      where suggestion_key not in (
        'customer_name', 'phone', 'email', 'interested_model', 'lifecycle_status',
        'temperature', 'next_followup_at', 'lost_reason', 'variant', 'budget_max',
        'purchase_timeline', 'finance_required', 'exchange_required', 'test_drive_required',
        'competitors'
      )
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AI_ANALYSIS_RESULT';
  end if;
  select * into job_row from public.ai_call_processing_jobs
  where id = target_job_id and lease_token = target_lease_token and status = 'PROCESSING'
  for update;
  if not found then return false; end if;
  update public.call_transcripts set
    transcript_text = btrim(target_normalized_transcript),
    speaker_turns = target_speaker_turns,
    speaker_separation_method = nullif(btrim(target_separation_method), ''),
    analysis_model_reference = nullif(btrim(target_analysis_model_reference), ''),
    status = 'COMPLETED', updated_at = now()
  where organization_id = job_row.organization_id and processing_job_id = job_row.id;
  if not found then
    raise exception using errcode = 'P0001', message = 'AI_TRANSCRIPTION_NOT_SAVED';
  end if;
  if nullif(btrim(target_summary), '') is not null then
    insert into public.ai_call_summaries (
      organization_id, call_id, processing_job_id, summary, model_reference
    ) values (
      job_row.organization_id, job_row.call_id, job_row.id,
      left(btrim(target_summary), 12000), nullif(btrim(target_analysis_model_reference), '')
    ) on conflict (organization_id, processing_job_id) do update set
      summary = excluded.summary, model_reference = excluded.model_reference;
  end if;
  if target_suggestions <> '{}'::jsonb then
    insert into public.ai_extraction_runs (
      organization_id, call_id, lead_id, processing_job_id, status, suggestions
    ) select job_row.organization_id, job_row.call_id, call_row.lead_id,
      job_row.id, 'COMPLETED', target_suggestions
    from public.calls call_row
    where call_row.id = job_row.call_id
      and call_row.organization_id = job_row.organization_id
    on conflict (organization_id, processing_job_id) do update set
      status = 'COMPLETED', suggestions = excluded.suggestions;
  end if;
  return true;
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
  requirements_patch jsonb := '{}'::jsonb;
  current_requirements jsonb;
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
    or jsonb_array_length(target_decisions) not between 1 and 15
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
      'temperature', 'next_followup_at', 'lost_reason', 'variant', 'budget_max',
      'purchase_timeline', 'finance_required', 'exchange_required', 'test_drive_required',
      'competitors'
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
    if decision_row.decision in ('APPLIED', 'EDITED') and decision_row.field_key in (
      'variant', 'budget_max', 'purchase_timeline', 'finance_required', 'exchange_required',
      'test_drive_required', 'competitors'
    ) then
      -- Requirement fields belong to lead_requirements, not the lead row.
      requirements_patch := requirements_patch
        || jsonb_build_object(decision_row.field_key, resolved_value);
      accepted_fields := array_append(accepted_fields, decision_row.field_key);
    elsif decision_row.decision in ('APPLIED', 'EDITED') then
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

  if requirements_patch <> '{}'::jsonb then
    -- update_lead_requirements replaces the whole row, so merge the approved
    -- fields over what the lead already has; it checks scope, bumps the
    -- version and writes the audit row.
    current_requirements := app_private.lead_requirements_json(lead_record.id);
    perform public.update_lead_requirements(
      lead_record.id,
      (current_requirements ->> 'version')::bigint,
      coalesce(current_requirements - 'version' - 'updated_at', '{}'::jsonb) || requirements_patch,
      md5(target_request_id::text || ':requirements')::uuid
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

create or replace function public.create_lead_from_call_review(
  target_call_id uuid,
  target_customer_name text,
  target_email text,
  target_interested_model text,
  target_decisions jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  extraction_record public.ai_extraction_runs%rowtype;
  previous_metadata jsonb;
  normalized_name text := nullif(btrim(coalesce(target_customer_name, '')), '');
  normalized_email text := lower(nullif(btrim(coalesce(target_email, '')), ''));
  normalized_model text := nullif(btrim(coalesce(target_interested_model, '')), '');
  decisions jsonb := coalesce(target_decisions, '[]'::jsonb);
  lead_decisions jsonb;
  created jsonb;
  new_lead_id uuid;
  new_customer_id uuid;
  review_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_call_id is null or target_request_id is null
    or jsonb_typeof(decisions) <> 'array'
    or jsonb_array_length(decisions) > 15
    or normalized_name is null or char_length(normalized_name) > 200
    or (normalized_email is not null and (
      char_length(normalized_email) > 320 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    ))
    or (normalized_model is not null and char_length(normalized_model) > 200)
  then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_FROM_CALL_REQUEST';
  end if;

  select * into call_row from public.calls where id = target_call_id for update;
  if not found or not app_private.can_access_call(call_row.organization_id, call_row.id) then
    raise exception using errcode = '42501', message = 'CALL_ACCESS_DENIED';
  end if;

  select audit_row.metadata into previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = call_row.organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'call.lead_created_from_review';
  if found then
    if previous_metadata ->> 'call_id' is distinct from call_row.id::text then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata -> 'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  if call_row.lead_id is not null then
    raise exception using errcode = 'PT409', message = 'CALL_ALREADY_HAS_LEAD';
  end if;
  if nullif(btrim(coalesce(call_row.normalized_caller_phone, '')), '') is null then
    raise exception using errcode = '22023', message = 'CALL_HAS_NO_CALLER_PHONE';
  end if;

  new_lead_id := public.create_lead(
    call_row.organization_id,
    call_row.branch_id,
    null,
    'Manual',
    normalized_name,
    call_row.normalized_caller_phone,
    normalized_email,
    case when call_row.call_source = 'PERSONAL_MANUAL'
      then 'Phone call recording' else 'TeleCMI inbound call' end,
    null,
    normalized_model
  );
  select customer_id into new_customer_id from public.leads where id = new_lead_id;

  update public.calls set
    lead_id = new_lead_id,
    customer_id = coalesce(customer_id, new_customer_id),
    version = version + 1,
    updated_at = now()
  where id = call_row.id;

  update public.ai_extraction_runs set lead_id = new_lead_id
  where organization_id = call_row.organization_id
    and call_id = call_row.id
    and lead_id is null;

  select * into extraction_record
  from public.ai_extraction_runs extraction_row
  where extraction_row.organization_id = call_row.organization_id
    and extraction_row.call_id = call_row.id
  order by extraction_row.created_at desc, extraction_row.id desc
  limit 1;

  if extraction_record.id is not null then
    -- The identity fields went into the new lead as the user confirmed them;
    -- record that review so the suggestions are not offered again.
    insert into public.ai_field_reviews (
      organization_id, extraction_run_id, field_key, suggested_value,
      applied_value, decision, reviewed_by, reviewed_at
    )
    select
      extraction_record.organization_id,
      extraction_record.id,
      used.field_key,
      extraction_record.suggestions -> used.field_key,
      to_jsonb(used.value_used),
      case
        when used.value_used is null then 'REJECTED'
        when extraction_record.suggestions -> used.field_key = to_jsonb(used.value_used) then 'APPLIED'
        else 'EDITED'
      end,
      auth.uid(),
      now()
    from (values
      ('customer_name', normalized_name),
      ('phone', call_row.normalized_caller_phone),
      ('email', normalized_email),
      ('interested_model', normalized_model)
    ) as used(field_key, value_used)
    where extraction_record.suggestions ? used.field_key;

    select coalesce(jsonb_agg(decision.value), '[]'::jsonb) into lead_decisions
    from jsonb_array_elements(decisions) decision(value)
    where decision.value ->> 'field_key' not in (
      'customer_name', 'phone', 'email', 'interested_model'
    );
    if jsonb_array_length(lead_decisions) > 0 then
      review_result := public.review_ai_call_fields(
        extraction_record.id,
        lead_decisions,
        md5(target_request_id::text || ':review')::uuid
      );
    end if;
  elsif jsonb_array_length(decisions) > 0 then
    raise exception using errcode = 'P0002', message = 'AI_FIELD_REVIEW_NOT_FOUND';
  end if;

  result := jsonb_build_object(
    'call_id', call_row.id,
    'lead_id', new_lead_id,
    'customer_id', new_customer_id,
    'accepted_fields', coalesce(review_result -> 'accepted_fields', '[]'::jsonb),
    'replayed', false
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    call_row.organization_id, auth.uid(), 'call.lead_created_from_review', 'call',
    call_row.id::text, call_row.branch_id, target_request_id,
    jsonb_build_object(
      'call_id', call_row.id,
      'lead_id', new_lead_id,
      'extraction_run_id', extraction_record.id,
      'result', result
    )
  );

  return result;
end;
$$;

-- The review screen compares each suggestion with the lead's current value;
-- requirement fields live in lead_requirements, not on the lead row.
create function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  occurrences integer := (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text);
begin
  if occurrences <> 1 then
    raise exception 'PATCH_ANCHOR_% for %: expected 1 occurrence, found %',
      md5(old_text), target, occurrences;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;

select pg_temp.patch_function(
  'public.get_ai_call_field_review(uuid)',
  $old$              else to_jsonb(lead_row) -> suggested.key
$old$,
  $new$              else coalesce(
                to_jsonb(lead_row) -> suggested.key,
                app_private.lead_requirements_json(lead_row.id) -> suggested.key
              )
$new$
);

commit;
