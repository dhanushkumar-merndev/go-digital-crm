import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liveCallSchema } from '../../src/features/calls/live-call-status';

const migration = readFileSync(
  'supabase/migrations/20260928180000_telecmi_live_call_apply.sql',
  'utf8',
);
const webhook = readFileSync('supabase/functions/provider-webhook-telecmi/index.ts', 'utf8');
const dispatch = readFileSync('trigger/provider-event-dispatch.ts', 'utf8');

describe('TeleCMI live call apply', () => {
  it('moves the call inside the webhook instead of waiting for the dispatcher cron', () => {
    // The live call bar sat on "Starting call" because the only code that moved
    // a call ran on a one-minute Trigger.dev cron; when that was not running,
    // the call never left PENDING.
    expect(webhook).toContain("admin.rpc('apply_telecmi_call_event'");
    expect(dispatch).toContain("supabase.rpc('apply_telecmi_call_event'");
  });

  it('re-applies a redelivered receipt rather than skipping it', () => {
    expect(webhook).toContain('storedReceipt = existing;');
  });

  it('asks TeleCMI to redeliver only on transient failures', () => {
    expect(webhook).toContain(
      "if (applyError && !applyError.code?.startsWith('22')) throw applyError;",
    );
  });

  it('is callable by the service role only', () => {
    expect(migration).toContain("if auth.role() <> 'service_role' then");
    expect(migration).toContain('from public, anon, authenticated;');
    expect(migration).toContain('to service_role;');
    expect(migration).toContain('security definer');
    expect(migration).toContain("set search_path = ''");
  });

  it('treats only the customer leg answering as connected', () => {
    expect(migration).toContain("customer_leg := receipt_leg is distinct from 'a';");
    expect(migration).toContain("next_status := 'IN_PROGRESS';");
    expect(migration).toContain(
      'next_agent_answered_at := coalesce(next_agent_answered_at, event_at);',
    );
  });

  it('ends a call whose employee leg was never answered', () => {
    // TeleCMI never dials the customer in that case, so no customer-leg CDR
    // arrives; the agent-leg CDR is the only signal the call is over.
    expect(migration).toContain('elsif not terminal and call_row.answered_at is null then');
  });

  it('takes billed duration from the customer leg only', () => {
    expect(migration).toContain(
      'if receipt_duration is not null and receipt_duration > coalesce(next_duration, -1) then',
    );
  });

  it('marks the lead contacted once, when the call first connects', () => {
    expect(migration).toContain("and upper(coalesce(call_row.outcome, '')) <> 'CONNECTED';");
    expect(migration).toContain('perform public.record_telecmi_connected_call(');
  });

  it('keeps a connected conversation on the bar past five minutes', () => {
    expect(migration).toContain("call_row.status in ('PENDING', 'RINGING')");
    expect(migration).toContain("interval '2 hours'");
    expect(migration).toContain("'agent_answered_at', call_row.agent_answered_at");
  });

  it('parses a response that predates agent_answered_at', () => {
    const parsed = liveCallSchema.parse({
      call_id: '0198c5d0-a3e7-7a31-9ab1-f12e50a0a991',
      status: 'RINGING',
      outcome: null,
      lead_id: null,
      customer_id: null,
      customer_name: 'Gokul',
      phone: '9742606830',
      started_at: '2026-09-28T11:36:26Z',
      answered_at: null,
      ended_at: null,
      duration_seconds: null,
    });
    expect(parsed.agent_answered_at).toBeNull();
  });
});
