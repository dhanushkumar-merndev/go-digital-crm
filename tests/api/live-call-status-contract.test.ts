import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isLiveCallStatus,
  liveCallSchema,
  liveCallStatuses,
  normalizeLiveCallStatus,
} from '../../src/features/calls/live-call-status';

const migration = readFileSync('supabase/migrations/202609240002_live_call_status.sql', 'utf8');
const dispatch = readFileSync('trigger/provider-event-dispatch.ts', 'utf8');
const bar = readFileSync('src/features/calls/live-call-bar.tsx', 'utf8');
const shell = readFileSync('src/components/shared/crm-shell.tsx', 'utf8');
const callDialog = readFileSync('src/features/customers/customer-360-actions.tsx', 'utf8');

describe('active call lookup', () => {
  it('returns only the caller own provider call', () => {
    expect(migration).toContain('public.get_active_call_status()');
    expect(migration).toContain('call_row.assigned_user_id = auth.uid()');
    expect(migration).toContain("call_row.call_source = 'PROVIDER'");
    expect(migration).toContain('security definer');
    expect(migration).toContain(
      'revoke all on function public.get_active_call_status() from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_active_call_status() to authenticated',
    );
  });

  it('bounds both ends so an abandoned call cannot pin the bar open', () => {
    // TeleCMI can accept a click2call and then never send a webhook. Without
    // the lower bound those rows sit at PENDING forever and the bar would show
    // a permanent "Starting call".
    expect(migration).toContain("interval '5 minutes'");
    expect(migration).toContain("interval '25 seconds'");
    expect(migration).toContain("status in ('PENDING', 'RINGING', 'IN_PROGRESS')");
  });

  it('records when the customer leg answered, not when dialling began', () => {
    expect(migration).toContain('add column if not exists answered_at timestamptz');
    expect(dispatch).toContain(
      "if (nextStatus === 'IN_PROGRESS' && !call.answered_at) changes.answered_at = at;",
    );
    expect(dispatch).toContain("'answered_at',");
    expect(bar).toContain('call.answered_at ?? call.started_at');
  });

  it('times call milestones from webhook arrival, not from processing', () => {
    // TeleCMI sends no timestamp, and the dispatcher runs on a one-minute cron,
    // so stamping new Date() here made answered_at up to a minute late and
    // arbitrarily late whenever a backlog was drained.
    expect(dispatch).toContain(
      'const changes = telecmiCallChanges(call, receipt, event.received_at);',
    );
    expect(dispatch).not.toContain('telecmiCallChanges(call, receipt, new Date().toISOString())');
    // The claim RPC returns `setof public.provider_events`, so received_at is
    // already on the row; it only has to be carried on the type.
    expect(dispatch).toContain('received_at: string;');
  });
});

describe('live call status parsing', () => {
  it('treats only in-flight statuses as live', () => {
    expect(isLiveCallStatus('PENDING')).toBe(true);
    expect(isLiveCallStatus('RINGING')).toBe(true);
    expect(isLiveCallStatus('IN_PROGRESS')).toBe(true);
    expect(isLiveCallStatus('COMPLETED')).toBe(false);
    expect(isLiveCallStatus('FAILED')).toBe(false);
    expect(isLiveCallStatus('CANCELLED')).toBe(false);
  });

  it('covers every status the dispatcher can write', () => {
    for (const status of ['PENDING', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'])
      expect(liveCallStatuses).toContain(status);
  });

  it('degrades an unknown status instead of blanking the bar', () => {
    // A value added to the database later must not fail the parse and hide a
    // call that is actually ringing.
    expect(normalizeLiveCallStatus('QUEUED_FOR_RETRY')).toBe('PENDING');
    expect(normalizeLiveCallStatus('')).toBe('PENDING');
    expect(normalizeLiveCallStatus('in_progress')).toBe('IN_PROGRESS');
    expect(normalizeLiveCallStatus('Completed')).toBe('COMPLETED');
  });

  it('parses a full row the way the database returns it', () => {
    const parsed = liveCallSchema.parse({
      call_id: '0198c5d0-a3e7-7a31-9ab1-f12e50a0a991',
      status: 'ringing',
      outcome: null,
      lead_id: null,
      customer_id: null,
      customer_name: 'Ashok',
      phone: '6385275950',
      started_at: '2026-09-24T11:00:00Z',
      answered_at: null,
      ended_at: null,
      duration_seconds: null,
    });
    expect(parsed.status).toBe('RINGING');
    expect(isLiveCallStatus(parsed.status)).toBe(true);
  });
});

describe('live call bar', () => {
  it('shows each stage rather than one fire-and-forget toast', () => {
    expect(bar).toContain("title: 'Ringing you'");
    expect(bar).toContain("title: 'Connected'");
    expect(bar).toContain("title: 'Call ended'");
    expect(bar).toContain("call.outcome === 'NO_ANSWER' ? 'No answer' : 'Call failed'");
    expect(bar).toContain('aria-live="polite"');
    expect(bar).toContain('role="status"');
  });

  it('moves on realtime broadcasts instead of polling hard', () => {
    expect(bar).toContain('useTenantRealtimeInvalidation');
    expect(bar).toContain("resource: 'communications'");
    // A slow fallback only while a call is actually live.
    expect(bar).toContain('isLiveCallStatus(query.state.data.status) ? 10_000 : false');
  });

  it('is mounted once in the shell so it survives navigation', () => {
    expect(shell).toContain('<LiveCallBar />');
    expect(shell).toContain("from '@/features/calls/live-call-bar'");
  });

  it('replaced the call-start toast rather than doubling up with it', () => {
    expect(callDialog).not.toContain("title: 'Calling ' + customerName");
    expect(callDialog).toContain('meta: { toast: false }');
  });
});
