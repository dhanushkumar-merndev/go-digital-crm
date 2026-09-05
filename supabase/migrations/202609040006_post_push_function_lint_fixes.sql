begin;

-- The member summary in the original timeline function referenced a CTE after
-- the statement that defined it. Replace that one reference with the same
-- day/member-scoped source query. The guarded patch keeps the large function's
-- remaining, already-reviewed behavior byte-for-byte intact.
do $migration$
declare
  function_definition text;
  broken_fragment constant text := E'    from activity_base;';
  fixed_fragment constant text := $replacement$    from (
      select case
        when activity_row.activity_type like 'CALL%' then 'CALL'
        when activity_row.activity_type like '%MESSAGE%'
          or activity_row.activity_type like '%WHATSAPP%' then 'MESSAGE'
        when activity_row.activity_type like '%FOLLOWUP%' then 'FOLLOW_UP'
        when activity_row.activity_type like '%TEST_DRIVE%' then 'TEST_DRIVE'
        when activity_row.activity_type like '%QUOTATION%' then 'QUOTATION'
        when activity_row.activity_type like '%TASK%' then 'TASK'
        when activity_row.activity_type like '%APPOINTMENT%' then 'APPOINTMENT'
        when activity_row.activity_type like '%NOTE%' then 'NOTE'
        else 'OTHER'
      end as activity_kind
      from public.activities activity_row
      join public.leads lead_row
        on lead_row.organization_id = activity_row.organization_id
       and lead_row.id = activity_row.lead_id
       and lead_row.assigned_user_id = target_member_id
       and lead_row.team_id = any(managed_team_ids)
       and lead_row.deleted_at is null
      join public.customers customer_row
        on customer_row.organization_id = activity_row.organization_id
       and customer_row.id = activity_row.customer_id
       and customer_row.deleted_at is null
      where activity_row.organization_id = current_organization_id
        and activity_row.occurred_at >= range_start
        and activity_row.occurred_at < range_end
    ) activity_base;$replacement$;
begin
  select pg_get_functiondef(
    'public.get_team_manager_activity_timeline(uuid,date,text,text,integer,integer,text,text)'::regprocedure
  ) into function_definition;
  if function_definition is null
    or position(broken_fragment in function_definition) = 0
    or (
      char_length(function_definition)
      - char_length(replace(function_definition, broken_fragment, ''))
    ) / char_length(broken_fragment) <> 1
  then
    raise exception using errcode = 'P0001', message = 'TEAM_ACTIVITY_FUNCTION_PATCH_MISMATCH';
  end if;
  execute replace(function_definition, broken_fragment, fixed_fragment);
end;
$migration$;

-- Use a normal SELECT INTO before RETURN. This avoids PL/pgSQL interpreting a
-- FROM-bearing return expression ambiguously and is friendlier to plpgsql_check.
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
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into call_record from public.calls where id = target_call_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id, call_record.branch_id,
      call_record.team_id, call_record.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select * into extraction_record
  from public.ai_extraction_runs extraction_row
  where extraction_row.organization_id = call_record.organization_id
    and extraction_row.call_id = call_record.id
  order by extraction_row.created_at desc, extraction_row.id desc
  limit 1;

  select jsonb_build_object(
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
      )
      from public.call_transcripts transcript_row
      where transcript_row.organization_id = call_record.organization_id
        and transcript_row.call_id = call_record.id
      order by transcript_row.created_at desc, transcript_row.id desc
      limit 1
    ),
    'summary', (
      select left(summary_row.summary, 20000)
      from public.ai_call_summaries summary_row
      where summary_row.organization_id = call_record.organization_id
        and summary_row.call_id = call_record.id
      order by summary_row.created_at desc, summary_row.id desc
      limit 1
    ),
    'extraction', case
      when extraction_record.id is null then null
      else jsonb_build_object(
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
            order by field_review.reviewed_at desc nulls last, field_review.id desc
            limit 1
          ) review_row on true
        ), '[]'::jsonb)
      )
    end
  ) into result
  from public.leads lead_row
  left join public.customers customer_row
    on customer_row.organization_id = call_record.organization_id
   and customer_row.id = coalesce(call_record.customer_id, lead_row.customer_id)
   and customer_row.deleted_at is null
  where lead_row.organization_id = call_record.organization_id
    and lead_row.id = call_record.lead_id;
  return result;
end;
$$;

-- Remove an obsolete row variable flagged by remote plpgsql_check.
create or replace function public.reverse_ai_credit_reservation(target_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return app_private.reverse_ai_credit_reservation(
    target_reservation_id, 'External AI work was not accepted'
  );
end;
$$;

revoke all on function public.get_ai_call_field_review(uuid) from public, anon;
grant execute on function public.get_ai_call_field_review(uuid) to authenticated;
revoke all on function public.reverse_ai_credit_reservation(uuid)
  from public, anon, authenticated;
grant execute on function public.reverse_ai_credit_reservation(uuid) to service_role;

commit;
