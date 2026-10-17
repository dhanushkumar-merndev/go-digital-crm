import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function fn(sql: string, name: string, terminator = '\n$$;') {
  const start = sql.search(
    new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`),
  );
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf(terminator, start));
}

const migration = source('supabase/migrations/202610171573_ai_agent_auto_call.sql');
const detailPatch = source('supabase/migrations/202610171593_lead_detail_call_language.sql');
const dispatcher = source('supabase/functions/_shared/auto-call.ts');
const statusWebhook = source('supabase/functions/provider-webhook-piopiy/index.ts');
const contextFunction = source('supabase/functions/ai-agent-call-context/index.ts');
const resultFunction = source('supabase/functions/provider-ai-agent-result/index.ts');
const config = source('supabase/config.toml');
const render = source('render.yaml');

describe('AI agent auto call: database contract', () => {
  it('re-bases claim_auto_call_jobs on the deployed text it replaces', () => {
    expect(migration).toContain("'9548e9ea6f2f9f5a58c154a205a08638'");
    const claim = fn(migration, 'public.claim_auto_call_jobs', '\n$function$;');
    expect(claim).toContain("auth.role() <> 'service_role'");
    // Same lead rules as keypad calls, DORMANT included (AGENTS.md 9.7).
    expect(claim).toContain("candidate.temperature is distinct from 'DORMANT'");
    expect(claim).toContain('candidate.first_contacted_at is null');
    expect(claim).toContain('candidate.assigned_user_id = dialer_row.user_id');
    // An AI call never starts without a valid script or enough credits.
    expect(claim).toContain("paused_reason = 'AI_SCRIPT_MISSING'");
    expect(claim).toContain("paused_reason = 'AI_CREDITS_EXHAUSTED'");
    expect(claim).toContain("balance_row.ledger_kind = 'AI'");
    // Only a hash of the context token is stored.
    expect(claim).toContain("encode(sha256(convert_to(ai_token, 'UTF8')), 'hex')");
    expect(claim).toContain("then 'AUTO_AI' else 'AUTO_IVR' end");
  });

  it('keeps AI calls apart from the retired AI_AGENT escalation calls', () => {
    expect(migration).toContain(
      "check (call_mode = any (array['HUMAN'::text, 'AI_AGENT'::text, 'AUTO_IVR'::text, 'AUTO_AI'::text]))",
    );
    expect(migration).toContain('auto_call_jobs_mode_payload');
  });

  it('accepts the agent only with the call’s own token, and only while the call is open', () => {
    const context = fn(migration, 'public.get_auto_ai_call_context');
    expect(context).toContain("auth.role() <> 'service_role'");
    expect(context).toContain('context_token_hash is distinct from');
    expect(context).toContain("message = 'AI_CALL_CLOSED'");
    expect(context).not.toContain("'phone'");
    const result = fn(migration, 'public.record_auto_ai_call_result');
    expect(result).toContain('context_token_hash is distinct from');
    expect(result).toContain("'replayed', true");
  });

  it('turns what the agent heard into suggestions only', () => {
    const result = fn(migration, 'public.record_auto_ai_call_result');
    expect(result).not.toContain('update public.leads');
    expect(result).toContain(
      'app_private.auto_ivr_field_value_valid(answer_item.key, answer_item.value)',
    );
    expect(result).toContain('insert into public.auto_ivr_call_results');
    // A refusal suggests DORMANT; nothing applies it without the telecaller.
    expect(result).toContain("suggestion_map := jsonb_build_object('temperature', 'DORMANT')");
    expect(migration).not.toMatch(/update public\.leads set[^;]*temperature/);
  });

  it('marks contact only for a real conversation', () => {
    const result = fn(migration, 'public.record_auto_ai_call_result');
    expect(result).toContain(
      "answered := outcome in ('ANSWERED_QUALIFIED', 'CALLBACK_REQUESTED', 'NOT_INTERESTED',",
    );
    expect(
      result.indexOf('if answered then\n    perform app_private.mark_auto_call_contact'),
    ).toBeGreaterThan(0);
  });

  it('charges AI credits once per answered call through the reservation ledger', () => {
    const result = fn(migration, 'public.record_auto_ai_call_result');
    expect(result).toContain('if answered and coalesce(credit_cost, 0) > 0 then');
    expect(result).toContain("'auto_ai_call:' || call_row.id::text");
    expect(result).toContain('public.commit_ai_credit_reservation(public.reserve_ai_credits(');
  });

  it('waits for the agent’s result when the status event arrives first', () => {
    const finalize = fn(migration, 'app_private.finalize_auto_ai_call_internal');
    expect(finalize).toContain("'pending_result', true");
    expect(finalize).toContain('not coalesce(target_force, false)');
    expect(statusWebhook).toContain('if (!result.pending_result)');
  });

  it('patches the live functions it extends and guards every patch', () => {
    for (const target of [
      'app_private.mark_auto_call_contact(uuid)',
      'public.verify_auto_contact(uuid)',
      'public.apply_auto_call_suggestions(uuid,text[],uuid)',
      'public.get_auto_call_result(uuid)',
      'public.get_my_auto_call_status()',
      'public.set_my_auto_call(boolean)',
      'public.get_auto_call_admin_workspace()',
      'app_private.enqueue_ai_call_processing()',
    ])
      expect(migration).toContain(`'${target}'::regprocedure`);
    expect(migration).toContain("raise exception '% anchor % not found exactly once'");
    expect(detailPatch).toContain("''call_language'', lead_row.call_language");
  });

  it('keeps service RPCs away from browsers', () => {
    for (const signature of [
      'public.finalize_auto_ai_call(uuid, uuid, text, integer, text)',
      'public.get_auto_ai_call_context(uuid, text)',
      'public.record_auto_ai_call_result(uuid, text, text, text, text, jsonb, jsonb, integer)',
    ]) {
      expect(migration).toContain(
        `revoke all on function ${signature} from public, anon, authenticated;`,
      );
      expect(migration).toContain(`grant execute on function ${signature} to service_role;`);
    }
    expect(migration).toContain(
      'grant execute on function public.save_auto_call_ai_settings(text, jsonb, integer, bigint) to authenticated;',
    );
    const settings = fn(migration, 'public.save_auto_call_ai_settings');
    expect(settings).toContain('app_private.can_manage_auto_call(current_organization_id)');
    expect(settings).toContain("errcode = 'PT409'");
    const language = fn(migration, 'public.set_lead_call_language');
    expect(language).toContain(
      "app_private.has_permission(lead_row.organization_id, 'lead.update')",
    );
    expect(language).toContain('app_private.can_access_record(');
    expect(language).toContain("'lead.call_language_changed'");
  });
});

describe('AI agent auto call: edge functions', () => {
  it('dials AI jobs through the AI call API with only the call reference', () => {
    expect(dispatcher).toContain("job.mode === 'AI_AGENT'");
    expect(dispatcher).toContain(
      'variables: { crm_call_id: job.call_id, context_token: job.context_token }',
    );
    expect(dispatcher).toContain("Deno.env.get('PIOPIY_AI_AGENT_ID')");
  });

  it('signs and validates every voice-agent request', () => {
    for (const handler of [contextFunction, resultFunction]) {
      expect(handler).toContain('readSignedAiAgentBody(request)');
      expect(handler).toContain("{ code: 'INVALID_SIGNATURE' }");
      expect(handler).toContain('schema.safeParse(body)');
    }
    expect(resultFunction).toContain('.max(400)');
    expect(config).toMatch(/\[functions\.ai-agent-call-context\]\nverify_jwt = false/);
    expect(config).toMatch(/\[functions\.provider-ai-agent-result\]\nverify_jwt = false/);
  });

  it('routes AI status events to the AI finalizer', () => {
    expect(statusWebhook).toContain(".in('call_mode', ['AUTO_IVR', 'AUTO_AI'])");
    expect(statusWebhook).toContain("'finalize_auto_ai_call'");
  });

  it('deploys the voice agent as an always-on worker with server-only secrets', () => {
    expect(render).toContain('name: go-digital-voice-agent');
    expect(render).toMatch(
      /type: worker\n\s+name: go-digital-voice-agent\n\s+runtime: docker\n\s+plan: starter/,
    );
    expect(render).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(AGENT|SARVAM|DEEPGRAM|GROQ)/);
  });
});
