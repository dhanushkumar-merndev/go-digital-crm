-- AI "Generate review" on the public feedback form: rounds instead of a flat
-- five per link (product decision 2026-10-22).
--
-- A lead's link gets 10 AI generations, then a 10-minute pause, then 10 more,
-- another pause, and a last 10. After 30 the AI is off for that link for good;
-- the customer can still edit by hand and submit. The count lives on the
-- feedback_requests row, which create_lead_review_request reuses when a link
-- is re-sent, so re-sending does not reset it.
--
-- Also: AI is offered whenever the platform model is available, not only when
-- the dealership connected its own OpenRouter key. The Edge function prefers
-- the dealership key and falls back to the platform Groq model; a missing
-- provider is refunded and the form composes the review locally.
--
-- The three functions are patched from their deployed text, with guards that
-- fail if a target moved or the old text survived.

begin;

alter table public.feedback_requests
  add column if not exists ai_rephrase_locked_until timestamptz;

do $patch$
declare
  definition text;
  patched text;
begin
  -- begin: 30 total, a 10-minute pause after every 10th.
  definition := pg_get_functiondef('public.begin_public_review_rephrase(text,uuid)'::regprocedure);
  patched := replace(definition,
    $old$  if feedback_row.ai_rephrase_count >= 5 then
    raise exception using errcode = 'P0001', message = 'REPHRASE_LIMIT_REACHED';
  end if;$old$,
    $new$  if feedback_row.ai_rephrase_count >= 30 then
    raise exception using errcode = 'P0001', message = 'REPHRASE_LIMIT_REACHED';
  end if;
  if feedback_row.ai_rephrase_locked_until > now() then
    raise exception using errcode = 'P0001', message = 'REPHRASE_COOLDOWN',
      detail = feedback_row.ai_rephrase_locked_until::text;
  end if;$new$);
  patched := replace(patched,
    $old$  update public.feedback_requests set ai_rephrase_count = ai_rephrase_count + 1
  where id = feedback_row.id;$old$,
    $new$  update public.feedback_requests
  set ai_rephrase_count = ai_rephrase_count + 1,
      ai_rephrase_locked_until = case
        when (ai_rephrase_count + 1) % 10 = 0 and ai_rephrase_count + 1 < 30
          then now() + interval '10 minutes'
        else ai_rephrase_locked_until
      end
  where id = feedback_row.id;$new$);
  if patched not like '%REPHRASE_COOLDOWN%' or patched like '%ai_rephrase_count >= 5%'
    or patched not like '%ai_rephrase_locked_until = case%' then
    raise exception 'begin_public_review_rephrase patch did not apply';
  end if;
  execute patched;

  -- refund: a refunded 10th generation must not leave its pause behind.
  definition := pg_get_functiondef('public.refund_public_review_rephrase(text,uuid)'::regprocedure);
  patched := replace(definition,
    $old$    update public.feedback_requests set ai_rephrase_count = greatest(ai_rephrase_count - 1, 0)
    where id = feedback_row.id;$old$,
    $new$    update public.feedback_requests
    set ai_rephrase_count = greatest(ai_rephrase_count - 1, 0),
        ai_rephrase_locked_until = case
          when ai_rephrase_count % 10 = 0 then null
          else ai_rephrase_locked_until
        end
    where id = feedback_row.id;$new$);
  if patched not like '%when ai_rephrase_count % 10 = 0 then null%' then
    raise exception 'refund_public_review_rephrase patch did not apply';
  end if;
  execute patched;

  -- form: platform AI counts as available; report the round state.
  definition := pg_get_functiondef('public.get_public_feedback_form(text)'::regprocedure);
  patched := replace(definition,
    $old$    'ai_available', ai_ready and feedback_row.ai_rephrase_count < 5,
    'ai_remaining', greatest(5 - feedback_row.ai_rephrase_count, 0)$old$,
    $new$    'ai_available', feedback_row.ai_rephrase_count < 30,
    'ai_remaining', greatest(30 - feedback_row.ai_rephrase_count, 0),
    'ai_round_remaining', case
      when feedback_row.ai_rephrase_count >= 30 then 0
      else 10 - feedback_row.ai_rephrase_count % 10
    end,
    'ai_locked_until', case
      when feedback_row.ai_rephrase_locked_until > now() then feedback_row.ai_rephrase_locked_until
    end,
    'ai_dealer_model', ai_ready$new$);
  if patched not like '%ai_round_remaining%' or patched like '%5 - feedback_row.ai_rephrase_count%' then
    raise exception 'get_public_feedback_form patch did not apply';
  end if;
  execute patched;
end;
$patch$;

commit;
