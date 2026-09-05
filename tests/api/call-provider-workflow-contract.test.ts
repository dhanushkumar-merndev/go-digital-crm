import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(path, 'utf8');
}

const migration = source('supabase/migrations/202608200006_call_manual_recording_upload.sql');
const telecmiMigration = source('supabase/migrations/202609030001_telecmi_ai_voice_automation.sql');
const api = source('src/features/calls/call-workspace-api.ts');
const workspace = source('src/features/calls/call-workspace.tsx');
const start = source('supabase/functions/call-provider-start/index.ts');
const webhook = source('supabase/functions/provider-webhook-telecmi/index.ts');
const callFlow = source('supabase/functions/provider-call-flow-telecmi/index.ts');
const telecmi = source('supabase/functions/_shared/telecmi.ts');
const dispatch = source('trigger/provider-event-dispatch.ts');
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

describe('TeleCMI provider calling boundary', () => {
  it('contains no Twilio references in the active call-provider runtime', () => {
    expect(
      [api, workspace, start, webhook, callFlow, telecmi, dispatch, ingest].join('\n'),
    ).not.toMatch(/twilio/i);
  });

  it('resolves only a connected branch-mapped TeleCMI adapter without exposing secrets', () => {
    expect(telecmiMigration).toContain('public.get_call_provider_options(');
    expect(telecmiMigration).toContain("connection_row.provider_key = 'telecmi'");
    expect(telecmiMigration).toContain("connection_row.status = 'CONNECTED'");
    expect(telecmiMigration).toContain('public.integration_branch_mappings');
    expect(api).toContain("provider_key: z.literal('telecmi')");
    expect(api).not.toContain('app_secret');
  });

  it('creates an authorized provider placeholder before calling TeleCMI server-side', () => {
    expect(telecmiMigration).toContain('public.create_provider_call_request(');
    expect(telecmiMigration).toContain('app_private.can_access_record(');
    expect(telecmiMigration).toContain("'call.provider_requested'");
    expect(start).toContain("'create_provider_call_request'");
    expect(start).toContain('decryptJson<TelecmiCredential>');
    expect(start).toContain('createTelecmiClickToCall');
    expect(telecmi).toContain("'/v2/webrtc/click2call'");
    expect(telecmi).toContain('webrtc: false');
    expect(telecmi).toContain('followme: true');
    expect(workspace).toContain('Call through CRM');
  });

  it('authenticates TeleCMI callbacks and durably stores a bounded receipt', () => {
    expect(webhook).toContain('constantTimeEqual(suppliedToken, credential.webhook_secret)');
    expect(webhook).toContain('credential.app_id');
    expect(webhook).toContain(".from('provider_events').insert(");
    expect(webhook).toContain("receiptError.code !== '23505'");
    expect(webhook).toContain(".select('payload_hash')");
    expect(webhook).toContain('constantTimeEqual(existing.payload_hash, payloadHash)');
    expect(webhook).toContain('return response(409)');
    expect(webhook).toContain("event_type: 'TELECMI_CALL_EVENT'");
    expect(webhook).toContain('const providerCallId = text(payload.call_id');
    expect(webhook).toContain('const providerLegId = text(payload.cmiuuid');
    expect(webhook).toContain('provider_leg_id: providerLegId || null');
    expect(webhook).not.toContain('provider-recording-ingest');
    expect(webhook).not.toContain('providerRecordingUrl:');
  });

  it('leases the durable receipt before reconciling calls and queuing recording ingestion', () => {
    expect(dispatch).toContain("event.event_type === 'TELECMI_CALL_EVENT'");
    expect(dispatch).toContain('dispatchTelecmiCall');
    expect(dispatch).toContain("connection.provider_key !== 'telecmi'");
    expect(dispatch).toContain(".from('calls')");
    expect(dispatch).toContain('providerRecordingIngest');
    expect(dispatch).toContain('tasks.trigger');
    expect(dispatch).toContain("provider: 'telecmi'");
    expect(dispatch).toContain("if (receipt.leg !== 'b') return null");
    expect(dispatch).toContain("rpc('record_telecmi_connected_call'");
    expect(ingest).toContain("payload.provider === 'telecmi'");
    expect(ingest).toContain('integration_credentials');
    expect(ingest).toContain("new URL('https://rest.telecmi.com/v2/play')");
    expect(ingest).toContain('new Upload({');
  });

  it('supports IVR, team, and bounded parallel-agent HTTP call flows', () => {
    expect(callFlow).toContain("action: 'ivr'");
    expect(callFlow).toContain("action: 'team'");
    expect(callFlow).toContain('result: agents');
    expect(callFlow).toContain('timeout: 20');
    expect(callFlow).toContain('slice(0, 50)');
    expect(callFlow).toContain('constantTimeEqual(token, credential.webhook_secret)');
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
