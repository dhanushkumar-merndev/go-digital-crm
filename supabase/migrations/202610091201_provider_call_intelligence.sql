begin;

-- TeleCMI's Speech IVR feature supplies its own transcript (and possibly a
-- summary) for a call. That text is the provider's, costs no AI credit, and
-- must not be confused with a Groq run, so transcript and summary rows now
-- carry their source:
--   AI        our Groq pipeline (every existing row)
--   TELECMI   delivered by TeleCMI for a CHUB call
--   AI_AGENT  produced by the PIOPIY AI agent during an AI call
--
-- save_provider_call_intelligence stores TeleCMI's text against the CRM call
-- the webhook already matched. One TELECMI transcript and one TELECMI summary
-- per call: a redelivery or a later, fuller delivery replaces the earlier one.

alter table public.call_transcripts
  add column if not exists source text not null default 'AI';
alter table public.ai_call_summaries
  add column if not exists source text not null default 'AI';

alter table public.call_transcripts drop constraint if exists call_transcripts_source_check;
alter table public.call_transcripts
  add constraint call_transcripts_source_check check (source in ('AI', 'TELECMI', 'AI_AGENT'));
alter table public.ai_call_summaries drop constraint if exists ai_call_summaries_source_check;
alter table public.ai_call_summaries
  add constraint ai_call_summaries_source_check check (source in ('AI', 'TELECMI', 'AI_AGENT'));

create unique index if not exists call_transcripts_provider_source_unique_idx
  on public.call_transcripts (organization_id, call_id, source)
  where source in ('TELECMI', 'AI_AGENT');
create unique index if not exists ai_call_summaries_provider_source_unique_idx
  on public.ai_call_summaries (organization_id, call_id, source)
  where source in ('TELECMI', 'AI_AGENT');

create or replace function public.save_provider_call_intelligence(
  target_organization_id uuid,
  target_call_id uuid,
  target_source text,
  target_transcript text,
  target_speaker_turns jsonb,
  target_summary text,
  target_language text,
  target_provider_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  normalized_source text := upper(btrim(coalesce(target_source, '')));
  transcript_text text := nullif(btrim(coalesce(target_transcript, '')), '');
  summary_text text := nullif(btrim(coalesce(target_summary, '')), '');
  turns jsonb := coalesce(target_speaker_turns, '[]'::jsonb);
  transcript_id uuid;
  summary_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_call_id is null
    or normalized_source not in ('TELECMI', 'AI_AGENT')
    or (transcript_text is null and summary_text is null and jsonb_typeof(turns) = 'array'
        and jsonb_array_length(turns) = 0)
    or char_length(coalesce(transcript_text, '')) > 1000000
    or char_length(coalesce(summary_text, '')) > 20000
    or char_length(coalesce(target_language, '')) > 40
    or char_length(coalesce(target_provider_reference, '')) > 255
    or jsonb_typeof(turns) <> 'array'
    or jsonb_array_length(turns) > 10000
    or exists (
      select 1 from jsonb_array_elements(turns) turn
      where jsonb_typeof(turn) <> 'object'
        or coalesce(turn ->> 'speaker', '') not in ('AGENT', 'CUSTOMER', 'UNKNOWN')
        or nullif(btrim(turn ->> 'text'), '') is null
        or char_length(turn ->> 'text') > 12000
    ) then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_CALL_INTELLIGENCE';
  end if;

  select * into call_row from public.calls
  where id = target_call_id and organization_id = target_organization_id;
  if not found then
    raise exception using errcode = '22023', message = 'CALL_NOT_FOUND';
  end if;

  -- Speaker turns without a flat text still make a readable transcript.
  if transcript_text is null and jsonb_array_length(turns) > 0 then
    select string_agg(
      case turn ->> 'speaker' when 'AGENT' then 'Agent: ' when 'CUSTOMER' then 'Customer: ' else '' end
        || btrim(turn ->> 'text'),
      E'\n' order by ordinality)
    into transcript_text
    from jsonb_array_elements(turns) with ordinality as entries(turn, ordinality);
  end if;

  if transcript_text is not null then
    insert into public.call_transcripts (
      organization_id, call_id, source, transcript_text, raw_transcript_text, speaker_turns,
      speaker_separation_method, language, provider_reference, status, updated_at
    ) values (
      call_row.organization_id, call_row.id, normalized_source, transcript_text, transcript_text,
      turns,
      case when jsonb_array_length(turns) > 0 then 'PROVIDER_CHANNEL' else null end,
      nullif(btrim(target_language), ''), nullif(btrim(target_provider_reference), ''),
      'COMPLETED', now()
    )
    on conflict (organization_id, call_id, source) where source in ('TELECMI', 'AI_AGENT')
    do update set
      transcript_text = excluded.transcript_text,
      raw_transcript_text = excluded.raw_transcript_text,
      speaker_turns = excluded.speaker_turns,
      speaker_separation_method = excluded.speaker_separation_method,
      language = coalesce(excluded.language, public.call_transcripts.language),
      provider_reference = coalesce(excluded.provider_reference, public.call_transcripts.provider_reference),
      status = 'COMPLETED',
      updated_at = now()
    returning id into transcript_id;
  end if;

  if summary_text is not null then
    insert into public.ai_call_summaries (
      organization_id, call_id, source, summary, model_reference
    ) values (
      call_row.organization_id, call_row.id, normalized_source, left(summary_text, 20000),
      nullif(btrim(target_provider_reference), '')
    )
    on conflict (organization_id, call_id, source) where source in ('TELECMI', 'AI_AGENT')
    do update set summary = excluded.summary, model_reference = excluded.model_reference
    returning id into summary_id;
  end if;

  insert into public.audit_logs (
    organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    call_row.organization_id, call_row.branch_id, null, 'call.provider_intelligence_saved', 'call',
    call_row.id,
    jsonb_build_object(
      'source', normalized_source,
      'transcript_saved', transcript_id is not null,
      'summary_saved', summary_id is not null,
      'speaker_turns', jsonb_array_length(turns)
    )
  );

  return jsonb_build_object(
    'call_id', call_row.id,
    'transcript_id', transcript_id,
    'summary_id', summary_id
  );
end;
$$;

revoke all on function public.save_provider_call_intelligence(uuid, uuid, text, text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_provider_call_intelligence(uuid, uuid, text, text, jsonb, text, text, text)
  to service_role;

commit;
