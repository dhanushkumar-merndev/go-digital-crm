-- A reviewer must explicitly decide whether AI-extracted call values should update a lead.
-- This keeps model output as a suggestion until an authorized human accepts it.

create index if not exists ai_extraction_runs_call_recent_idx
  on public.ai_extraction_runs (organization_id, call_id, created_at desc, id)
  where call_id is not null;
create index if not exists ai_field_reviews_run_field_idx
  on public.ai_field_reviews (extraction_run_id, field_key, reviewed_at desc nulls last, id desc);

create or replace function public.get_ai_call_field_review(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  call_record public.calls%rowtype;
  extraction_record public.ai_extraction_runs%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_record from public.calls where id = target_call_id;
  if not found then raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND'; end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id, call_record.branch_id, call_record.team_id, call_record.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select * into extraction_record
  from public.ai_extraction_runs extraction_row
  where extraction_row.organization_id = call_record.organization_id
    and extraction_row.call_id = call_record.id
  order by extraction_row.created_at desc, extraction_row.id desc
  limit 1;

  return jsonb_build_object(
    'call', jsonb_build_object(
      'id', call_record.id,
      'lead_id', call_record.lead_id,
      'customer_name', coalesce((select lead_row.customer_name from public.leads lead_row where lead_row.id = call_record.lead_id), 'Customer'),
      'phone', coalesce((select lead_row.phone from public.leads lead_row where lead_row.id = call_record.lead_id), ''),
      'interested_model', (select lead_row.interested_model from public.leads lead_row where lead_row.id = call_record.lead_id),
      'started_at', call_record.started_at,
      'duration_seconds', call_record.duration_seconds
    ),
    'transcript', (
      select jsonb_build_object('text', transcript_row.transcript_text, 'language', transcript_row.language)
      from public.call_transcripts transcript_row
      where transcript_row.organization_id = call_record.organization_id and transcript_row.call_id = call_record.id
      order by transcript_row.created_at desc, transcript_row.id desc limit 1
    ),
    'summary', (
      select summary_row.summary from public.ai_call_summaries summary_row
      where summary_row.organization_id = call_record.organization_id and summary_row.call_id = call_record.id
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
          'current_value', case when call_record.lead_id is null then null
            else to_jsonb(lead_row) -> suggested.key end,
          'decision', coalesce(review_row.decision, 'PENDING'),
          'applied_value', review_row.applied_value
        ) order by suggested.key)
        from jsonb_each(extraction_record.suggestions) suggested
        left join public.leads lead_row on lead_row.id = call_record.lead_id
        left join lateral (
          select field_review.decision, field_review.applied_value
          from public.ai_field_reviews field_review
          where field_review.extraction_run_id = extraction_record.id
            and field_review.field_key = suggested.key
          order by field_review.reviewed_at desc nulls last, field_review.id desc limit 1
        ) review_row on true
      ), '[]'::jsonb)
    ) end
  );
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
declare
  extraction_record public.ai_extraction_runs%rowtype;
  lead_record public.leads%rowtype;
  decision_row record;
  resolved_value jsonb;
  existing_review_id uuid;
  accepted_fields text[] := array[]::text[];
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if target_request_id is null or jsonb_typeof(target_decisions) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_AI_FIELD_REVIEW_REQUEST';
  end if;
  select * into extraction_record from public.ai_extraction_runs where id = target_extraction_run_id for update;
  if not found or extraction_record.call_id is null or extraction_record.lead_id is null then
    raise exception using errcode = 'P0002', message = 'AI_FIELD_REVIEW_NOT_FOUND';
  end if;
  select * into lead_record from public.leads where id = extraction_record.lead_id for update;
  if not found or not app_private.has_permission(lead_record.organization_id, 'lead.update')
    or not app_private.can_access_lead(lead_record.id) then
    raise exception using errcode = '42501', message = 'LEAD_UPDATE_PERMISSION_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_extraction_run_id::text, 0));

  for decision_row in
    select value ->> 'field_key' as field_key, upper(value ->> 'decision') as decision,
      value -> 'value' as edited_value
    from jsonb_array_elements(target_decisions)
  loop
    if decision_row.field_key not in ('customer_name', 'phone', 'email', 'interested_model', 'lifecycle_status', 'temperature', 'next_followup_at')
      or decision_row.decision not in ('APPLIED', 'REJECTED', 'EDITED') then
      raise exception using errcode = '22023', message = 'INVALID_AI_FIELD_REVIEW_DECISION';
    end if;
    if not extraction_record.suggestions ? decision_row.field_key then
      raise exception using errcode = '22023', message = 'AI_FIELD_NOT_SUGGESTED';
    end if;
    resolved_value := case when decision_row.decision = 'EDITED' then decision_row.edited_value
      else extraction_record.suggestions -> decision_row.field_key end;
    if decision_row.decision = 'EDITED' and resolved_value is null then
      raise exception using errcode = '22023', message = 'AI_FIELD_EDIT_VALUE_REQUIRED';
    end if;

    if decision_row.decision in ('APPLIED', 'EDITED') then
      update public.leads set
        customer_name = case when decision_row.field_key = 'customer_name' then resolved_value #>> '{}' else customer_name end,
        phone = case when decision_row.field_key = 'phone' then resolved_value #>> '{}' else phone end,
        normalized_phone = case when decision_row.field_key = 'phone' then regexp_replace(resolved_value #>> '{}', '\\D', '', 'g') else normalized_phone end,
        email = case when decision_row.field_key = 'email' then nullif(resolved_value #>> '{}', '') else email end,
        interested_model = case when decision_row.field_key = 'interested_model' then nullif(resolved_value #>> '{}', '') else interested_model end,
        lifecycle_status = case when decision_row.field_key = 'lifecycle_status' then (resolved_value #>> '{}')::public.lead_lifecycle else lifecycle_status end,
        temperature = case when decision_row.field_key = 'temperature' then nullif(resolved_value #>> '{}', '')::public.lead_temperature else temperature end,
        next_followup_at = case when decision_row.field_key = 'next_followup_at' then nullif(resolved_value #>> '{}', '')::timestamptz else next_followup_at end,
        updated_at = now()
      where id = lead_record.id;
      accepted_fields := array_append(accepted_fields, decision_row.field_key);
    end if;

    select id into existing_review_id from public.ai_field_reviews
    where extraction_run_id = extraction_record.id and field_key = decision_row.field_key
    order by reviewed_at desc nulls last, id desc limit 1 for update;
    if existing_review_id is null then
      insert into public.ai_field_reviews (
        organization_id, extraction_run_id, field_key, suggested_value, applied_value,
        decision, reviewed_by, reviewed_at
      ) values (
        extraction_record.organization_id, extraction_record.id, decision_row.field_key,
        extraction_record.suggestions -> decision_row.field_key,
        case when decision_row.decision in ('APPLIED', 'EDITED') then resolved_value else null end,
        decision_row.decision, auth.uid(), now()
      );
    else
      update public.ai_field_reviews set
        suggested_value = extraction_record.suggestions -> decision_row.field_key,
        applied_value = case when decision_row.decision in ('APPLIED', 'EDITED') then resolved_value else null end,
        decision = decision_row.decision, reviewed_by = auth.uid(), reviewed_at = now()
      where id = existing_review_id;
    end if;
  end loop;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    extraction_record.organization_id, auth.uid(), 'ai_call_fields.reviewed', 'ai_extraction_run',
    extraction_record.id::text, lead_record.branch_id, target_request_id,
    jsonb_build_object('lead_id', lead_record.id, 'accepted_fields', accepted_fields)
  );
  return jsonb_build_object('lead_id', lead_record.id, 'accepted_fields', accepted_fields);
end;
$$;

revoke all on function public.get_ai_call_field_review(uuid) from public, anon;
grant execute on function public.get_ai_call_field_review(uuid) to authenticated;
revoke all on function public.review_ai_call_fields(uuid, jsonb, uuid) from public, anon;
grant execute on function public.review_ai_call_fields(uuid, jsonb, uuid) to authenticated;
