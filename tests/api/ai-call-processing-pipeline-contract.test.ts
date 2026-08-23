import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220031_ai_call_processing_pipeline.sql');
const idempotencyMigration = source('supabase/migrations/202608220032_ai_call_processing_idempotency.sql');
const worker = source('trigger/ai-call-processing.ts');
const twilio = source('supabase/functions/integration-connect-twilio/index.ts');

describe('IVR recording AI processing contract', () => {
  it('leases only finalized provider recordings and has a bounded retry state machine', () => {
    expect(migration).toContain('ai_call_processing_jobs');
    expect(migration).toContain("new.status <> 'READY' or new.object_file_id is null");
    expect(migration).toContain("call_source = 'PROVIDER'");
    expect(idempotencyMigration).toContain('ai_call_processing_jobs_org_call_recording_unique_idx');
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain("attempt_count < 7");
    expect(migration).toContain("status = case when attempt_count >= 7 then 'FAILED' else 'RETRY' end");
  });

  it('keeps recordings private, uses a short-lived Tigris URL only in the worker, and meters platform AI work', () => {
    expect(worker).toContain("new GetObjectCommand({ Bucket: job.object_bucket, Key: job.object_key })");
    expect(worker).toContain('{ expiresIn: 600 }');
    expect(worker).toContain("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(worker).toContain("https://api.groq.com/openai/v1/chat/completions");
    expect(worker).toContain("rpc('consume_platform_ai_credits'");
    expect(worker).toContain('processing_job_id: job.id');
    expect(worker).toContain('lead_id: job.lead_id');
    expect(worker).toContain("billingMode: 'TENANT_CONNECTION'");
    expect(worker).not.toContain('NEXT_PUBLIC_');
  });

  it('verifies Twilio server-side and maps a connection to allowed branches before secrets are encrypted', () => {
    expect(twilio).toContain('https://api.twilio.com/2010-04-01/Accounts/');
    expect(twilio).toContain("target_permission: 'integration.manage'");
    expect(twilio).toContain('authorize_integration_scope');
    expect(twilio).toContain("external_resource_type: 'CONNECTION_SCOPE'");
    expect(twilio).toContain('encryptJson({');
    expect(twilio).not.toContain('NEXT_PUBLIC_');
  });
});
