import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(path, 'utf8');
}

const migration = source('supabase/migrations/202608200006_call_manual_recording_upload.sql');
const api = source('src/features/calls/call-workspace-api.ts');
const workspace = source('src/features/calls/call-workspace.tsx');
const start = source('supabase/functions/call-provider-start/index.ts');
const webhook = source('supabase/functions/provider-webhook-twilio/index.ts');
const twilio = source('supabase/functions/_shared/twilio-voice.ts');
const ingest = source('trigger/provider-recording-ingest.ts');

describe('manual call recording workflow', () => {
  it('attaches only a scoped private audio object to a manual call and audits idempotently', () => {
    expect(migration).toContain('public.attach_manual_call_recording(');
    expect(migration).toContain("call_row.call_source <> 'PERSONAL_MANUAL'");
    expect(migration).toContain(
      "app_private.has_permission(call_row.organization_id, 'document.upload')",
    );
    expect(migration).toContain('app_private.can_access_call(');
    expect(migration).toContain("resource_type = 'call'");
    expect(migration).toContain("'call.manual_recording_attached'");
  });

  it('uploads directly to Tigris through the existing presign/finalize boundary', () => {
    expect(api).toContain("'presign-upload'");
    expect(api).toContain("'object-upload-finalize'");
    expect(api).toContain("'attach_manual_call_recording'");
    expect(workspace).toContain('Upload audio');
    expect(workspace).toContain('Stored privately in Tigris');
  });
});

describe('Twilio provider calling boundary', () => {
  it('resolves only a connected branch-mapped Twilio adapter without exposing secrets', () => {
    expect(migration).toContain('public.get_call_provider_options(');
    expect(migration).toContain("connection_row.provider_key = 'twilio_voice'");
    expect(migration).toContain("connection_row.status = 'CONNECTED'");
    expect(migration).toContain('public.integration_branch_mappings');
    expect(migration).not.toContain("'api_key_secret', connection_row");
  });

  it('creates an authorized provider placeholder before calling Twilio server-side', () => {
    expect(migration).toContain('public.create_provider_call_request(');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain("'call.provider_requested'");
    expect(start).toContain("'create_provider_call_request'");
    expect(start).toContain('decryptJson<TwilioVoiceCredential>');
    expect(start).toContain('createTwilioBridgeCall');
    expect(twilio).toContain('https://api.twilio.com/2010-04-01/Accounts/');
    expect(workspace).toContain('Call with IVR');
  });

  it('validates signed Twilio callbacks and moves provider recordings through Trigger and Tigris', () => {
    expect(webhook).toContain("request.headers.get('x-twilio-signature')");
    expect(webhook).toContain('validateTwilioSignature');
    expect(webhook).toContain('provider-recording-ingest/trigger');
    expect(webhook).not.toContain('providerRecordingUrl: request');
    expect(ingest).toContain("payload.provider === 'twilio_voice'");
    expect(ingest).toContain('integration_credentials');
    expect(ingest).toContain('new Upload({');
  });
});

describe('assigned dealership header', () => {
  it('resolves the active branch assignment and does not duplicate it in consultant follow-up filters', () => {
    expect(migration).toContain('public.get_assigned_dealership_name()');
    expect(migration).toContain('public.team_members');
    expect(migration).toContain('public.user_branch_access');
    expect(workspace).toContain('Select customer or lead');
  });
});
