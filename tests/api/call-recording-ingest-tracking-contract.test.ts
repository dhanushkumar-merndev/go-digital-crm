import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(path, 'utf8');
}

const migration = source('supabase/migrations/202610091101_call_recording_ingest_tracking.sql');
const ingest = source('trigger/provider-recording-ingest.ts');
const minute = source('trigger/minute-dispatch.ts');

describe('provider recording ingest failure tracking', () => {
  it('records a safe failure code on every failed attempt and FAILED on the last one', () => {
    expect(ingest).toContain('const finalAttempt = ctx.attempt.number >= INGEST_MAX_ATTEMPTS;');
    expect(ingest).toContain('failure_code: safeIngestErrorCode(error)');
    expect(ingest).toContain("...(finalAttempt ? { status: 'FAILED' } : {})");
    expect(ingest).toContain(".neq('status', 'READY')");
    // The run still fails so Trigger.dev retries it.
    expect(ingest).toMatch(/failure_code: safeIngestErrorCode\(error\)[\s\S]*?throw error;/);
  });

  it('never writes a raw provider or SDK message into the database', () => {
    expect(ingest).toContain('/^[A-Z0-9_]{3,100}$/.test(error.message)');
    expect(ingest).toContain("return 'TIGRIS_UPLOAD_FAILED';");
    expect(ingest).toContain("return 'PROVIDER_RECORDING_INGEST_FAILED';");
    expect(migration).toContain(
      "check (failure_code is null or failure_code ~ '^[A-Z0-9_]{3,100}$')",
    );
  });

  it('clears the failure and names the file when the recording becomes READY', () => {
    expect(ingest).toContain("status: 'READY', checksum, failure_code: null");
    expect(ingest).toContain(
      'original_file_name: recordingFileName(payload.callId, responseMimeType)',
    );
  });

  it('sweeps stuck TeleCMI recordings at most three times, ten minutes apart, service role only', () => {
    expect(migration).toContain(
      'public.claim_stuck_call_recordings(target_limit integer default 10)',
    );
    expect(migration).toContain(
      "raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'",
    );
    expect(migration).toContain('recording_row.sweep_count < 3');
    expect(migration).toContain("< now() - interval '10 minutes'");
    expect(migration).toContain("connection_row.provider_key = 'telecmi'");
    expect(migration).toContain('for update of recording_row skip locked');
    expect(migration).toContain(
      'revoke all on function public.claim_stuck_call_recordings(integer) from public, anon, authenticated;',
    );
  });

  it('re-triggers with a per-sweep idempotency key from the per-minute dispatch', () => {
    expect(ingest).toContain('`telecmi-recording:${row.recording_id}:sweep:${row.sweep_count}`');
    expect(minute).toContain('recording_sweep: runStuckRecordingSweep');
  });
});
