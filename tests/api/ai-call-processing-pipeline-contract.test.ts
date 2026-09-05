import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220031_ai_call_processing_pipeline.sql');
const idempotencyMigration = source(
  'supabase/migrations/202608220032_ai_call_processing_idempotency.sql',
);
const telecmiAiMigration = source(
  'supabase/migrations/202609030001_telecmi_ai_voice_automation.sql',
);
const completionMigration = source(
  'supabase/migrations/202609040002_telecmi_ai_voice_completion.sql',
);
const telecmiSaveMigration = source(
  'supabase/migrations/202609040003_telecmi_connection_atomic_save.sql',
);
const aiVoiceWebhookApplyMigration = source(
  'supabase/migrations/202609040005_ai_voice_webhook_atomic_apply.sql',
);
const worker = source('trigger/ai-call-processing.ts');
const telecmi = source('supabase/functions/integration-connect-telecmi/index.ts');
const telecmiAdapter = source('supabase/functions/_shared/telecmi.ts');
const aiVoiceWebhook = source('supabase/functions/provider-webhook-ai-voice/index.ts');
const creditRoadmap = source('docs/ai-credit-roadmap.md');

describe('IVR recording AI processing contract', () => {
  it('leases finalized provider or manual recordings and safely reclaims the final attempt', () => {
    expect(migration).toContain('ai_call_processing_jobs');
    expect(migration).toContain("new.status <> 'READY' or new.object_file_id is null");
    expect(telecmiAiMigration).toContain("call_source in ('PROVIDER', 'PERSONAL_MANUAL')");
    expect(idempotencyMigration).toContain('ai_call_processing_jobs_org_call_recording_unique_idx');
    expect(completionMigration).toContain('for update skip locked');
    expect(completionMigration).toContain("job_row.status = 'PROCESSING'");
    expect(completionMigration).toContain('job_row.lease_expires_at < now()');
    expect(completionMigration).toContain('job_row.attempt_count <= 7');
    expect(completionMigration).toContain('attempt_count = least(7, job_row.attempt_count + 1)');
  });

  it('meters both tenant and platform AI providers and reverses only terminal uncommitted work', () => {
    expect(worker).toContain(
      'new GetObjectCommand({ Bucket: job.object_bucket, Key: job.object_key })',
    );
    expect(worker).toContain('{ expiresIn: 600 }');
    expect(worker).toContain('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(worker).toContain('https://api.groq.com/openai/v1/chat/completions');
    expect(worker).toContain("rpc('reserve_ai_credits'");
    expect(worker).toContain("rpc('commit_ai_credit_reservation'");
    expect(worker).not.toMatch(/provider\.billingMode\s*===\s*['"]PLATFORM_CREDITS/);
    expect(telecmiAiMigration).toContain('pg_advisory_xact_lock');
    expect(telecmiAiMigration).toContain("status in ('RESERVED', 'COMMITTED', 'REVERSED')");
    expect(telecmiAiMigration).toContain("reservation.status = 'RESERVED'");
    expect(telecmiAiMigration).toContain("'AI call processing exhausted its bounded retries'");
    expect(worker).toContain(".eq('processing_job_id', job.id)");
    expect(worker).toContain('target_job_id: job.id');
    expect(telecmiAiMigration).toContain(
      'select job_row.organization_id, job_row.call_id, call_row.lead_id',
    );
    expect(worker).toContain("billingMode: 'TENANT_CONNECTION'");
    expect(worker).toContain("billingMode: 'PLATFORM_CREDITS'");
    expect(worker).toContain('speaker_turns: analysis.speakerTurns');
    expect(worker).not.toContain('NEXT_PUBLIC_');
    expect(creditRoadmap).toContain('does not bypass the CRM credit meter');
    expect(creditRoadmap).not.toContain(
      "A tenant's own Groq connection does not consume platform credits",
    );
  });

  it('lets only a Client Admin configure TeleCMI within an exact branch scope', () => {
    expect(telecmiAdapter).toContain("'/v2/analysis'");
    expect(telecmi).toContain('testTelecmiCredential(credential)');
    expect(telecmi).toContain("rpc('authorize_telecmi_management_scope'");
    expect(telecmiAiMigration).toContain('app_private.is_client_admin(target_organization_id)');
    expect(telecmiAiMigration).toContain('public.authorize_integration_scope(');
    expect(telecmi).toContain("input.scope_mode === 'ALL_BRANCHES'");
    expect(telecmi).toContain('input.branch_ids.length !== 0');
    expect(telecmi).toContain("rpc('save_telecmi_connection'");
    expect(telecmiSaveMigration).toContain("'CONNECTION_SCOPE'");
    expect(telecmiSaveMigration).toContain("target_scope_mode <> 'ALL_BRANCHES'");
    expect(telecmi).toContain('const encryptedPayload = await encryptJson(credential)');
    expect(telecmi).toContain('target_encrypted_payload: encryptedPayload');
    expect(telecmi).not.toContain('NEXT_PUBLIC_');
  });

  it('applies signed AI voice callbacks atomically and records canonical lead history', () => {
    expect(aiVoiceWebhook).toContain('declaredLength > 512_000');
    expect(aiVoiceWebhook).toContain("'apply_ai_voice_call_event'");
    expect(aiVoiceWebhook).not.toContain(".from('calls')");
    expect(aiVoiceWebhook).not.toContain(".from('leads')");
    expect(aiVoiceWebhookApplyMigration).toContain("status = 'PROCESSING'");
    expect(aiVoiceWebhookApplyMigration).toContain('lease_token = target_lease_token');
    expect(aiVoiceWebhookApplyMigration).toContain('for update');
    expect(aiVoiceWebhookApplyMigration).toContain("call_mode = 'AI_AGENT'");
    expect(aiVoiceWebhookApplyMigration).toContain(
      "when call_row.status in ('COMPLETED', 'FAILED', 'CANCELLED') then false",
    );
    expect(aiVoiceWebhookApplyMigration).toContain('insert into public.lead_stage_history');
    expect(aiVoiceWebhookApplyMigration).toContain("'Contacted', null, 'Connected AI voice call'");
    expect(aiVoiceWebhookApplyMigration).toContain('insert into public.call_recordings');
    expect(aiVoiceWebhookApplyMigration).toContain("'call.ai_voice_event_applied'");
    expect(aiVoiceWebhookApplyMigration).toContain('to service_role');
  });
});
