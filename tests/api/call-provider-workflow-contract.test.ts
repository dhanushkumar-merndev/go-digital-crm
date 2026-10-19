import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(path, 'utf8');
}

const migration = source('supabase/migrations/202608200006_call_manual_recording_upload.sql');
const telecmiMigration = source('supabase/migrations/202609030001_telecmi_ai_voice_automation.sql');
const api = source('src/features/calls/call-workspace-api.ts');
const workspace = source('src/features/calls/call-workspace.tsx');
const customerActions = source('src/features/customers/customer-360-actions.tsx');
const leadWorkspace = source('src/features/leads/lead-workspace.tsx');
const start = source('supabase/functions/call-provider-start/index.ts');
const webhook = source('supabase/functions/provider-webhook-telecmi/index.ts');
const callFlow = source('supabase/functions/provider-call-flow-telecmi/index.ts');
const telecmi = source('supabase/functions/_shared/telecmi.ts');
const connect = source('supabase/functions/integration-connect-telecmi/index.ts');
const integrationWorkspace = source('src/features/integrations/integration-workspace.tsx');
const agentEditor = source('src/features/integrations/telecmi-agent-editor.tsx');
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
    // The ringing device is asserted in 'outbound call mode' -- it is a tenant
    // setting now, so pinning a literal here would re-encode the old bug.
    expect(telecmi).toContain('callMode?: TelecmiCallMode');
    expect(workspace).toContain('Call through CRM');
  });

  it('authenticates TeleCMI callbacks and durably stores a bounded receipt', () => {
    expect(webhook).toContain('constantTimeEqual(suppliedToken, credential.webhook_secret)');
    expect(webhook).toContain('credential.app_id');
    expect(webhook).toContain(".from('provider_events')\n      .insert(");
    expect(webhook).toContain("receiptError.code !== '23505'");
    expect(webhook).toContain(".select('id,received_at,payload_hash')");
    expect(webhook).toContain('constantTimeEqual(existing.payload_hash, payloadHash)');
    expect(webhook).toContain('return response(409)');
    expect(webhook).toContain("event_type: 'TELECMI_CALL_EVENT'");
    // Click-to-call keeps TeleCMI's call_id; an inbound call has none and is
    // identified by conversation_uuid, shared by both of its legs.
    expect(webhook).toContain('text(payload.call_id, 255) ||');
    expect(webhook).toContain(
      "(inbound ? text(payload.conversation_uuid, 255) || providerLegId : '')",
    );
    expect(webhook).toContain('const providerLegId = text(payload.cmiuuid');
    expect(webhook).toContain('provider_leg_id: providerLegId || null');
    expect(webhook).not.toContain('provider-recording-ingest');
    expect(webhook).not.toContain('providerRecordingUrl:');
  });

  it('leases the durable receipt before reconciling calls and queuing recording ingestion', () => {
    expect(dispatch).toContain("event.event_type === 'TELECMI_CALL_EVENT'");
    expect(dispatch).toContain('dispatchTelecmiCall');
    expect(dispatch).toContain("connection.provider_key !== 'telecmi'");
    // The call is moved by the same database function the webhook runs, so the
    // dispatcher and the webhook can never disagree about a transition.
    expect(dispatch).toContain("supabase.rpc('apply_telecmi_call_event'");
    expect(dispatch).not.toContain(".from('calls')");
    expect(dispatch).toContain('providerRecordingIngest');
    expect(dispatch).toContain('tasks.trigger');
    expect(dispatch).toContain("provider: 'telecmi'");
    expect(dispatch).toContain("if (!receipt.inbound && receipt.leg !== 'b') return false");
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

describe('provider call failure reporting', () => {
  it('names the specific reason a TeleCMI call start failed instead of one generic code', () => {
    // A bare catch used to collapse an unmapped mobile, a missing credential,
    // an undialable number and a TeleCMI rejection into one 502, which left a
    // telecaller and a Client Admin with nothing to act on.
    expect(start).toContain('describeTelecmiFailure');
    expect(start).toContain('TELECMI_CALLER_MAPPING_NOT_CONFIGURED');
    expect(start).toContain('TELECMI_CREDENTIAL_NOT_CONFIGURED');
    expect(start).toContain('CALL_CUSTOMER_PHONE_NOT_DIALABLE');
    expect(start).toContain('CALL_PROVIDER_SCOPE_DENIED');
    expect(start).toContain('CALL_LEAD_NOT_AUTHORIZED');
    expect(start).not.toContain('} catch {');
  });

  it('keeps the Edge reason on screen instead of the supabase-js FunctionsHttpError', () => {
    expect(api).toContain('class ProviderCallStartError');
    expect(api).toContain('context instanceof Response');
    expect(api).toContain('readProviderCallError');
    expect(workspace).toContain('providerCall.error instanceof ProviderCallStartError');
    expect(customerActions).toContain('start.error instanceof ProviderCallStartError');
  });

  it('never returns a provider secret in a call-start failure', () => {
    expect(start).not.toContain('app_secret');
    expect(start).not.toContain('error.message}`');
  });
});

describe('outbound call mode', () => {
  it('takes the ringing device from the tenant connection instead of hardcoding follow-me', () => {
    // TeleCMI gates follow-me per app and answers `420: Follow-me calls are not
    // allowed for this app` when it is off, so a hardcoded followme: true made
    // every call fail on such an account.
    expect(telecmi).toContain('export type TelecmiCallMode');
    expect(telecmi).toContain('parseTelecmiCallMode');
    expect(telecmi).toContain('webrtc: !followMe');
    expect(telecmi).toContain('followme: followMe');
    expect(telecmi).not.toContain('followme: true');
    expect(start).toContain('parseTelecmiCallMode(connectionConfig.outbound_call_mode)');
  });

  it('defaults to the logged-in client and lets a Client Admin choose follow-me', () => {
    expect(telecmi).toContain("defaultTelecmiCallMode: TelecmiCallMode = 'WEBRTC'");
    expect(connect).toContain(
      "outbound_call_mode: z.enum(['WEBRTC', 'FOLLOW_ME']).default('WEBRTC')",
    );
    expect(connect).toContain('outbound_call_mode: input.outbound_call_mode');
    expect(integrationWorkspace).toContain('Outbound call rings');
    expect(integrationWorkspace).toContain('outboundCallMode');
  });
});

describe('call feedback', () => {
  it('leaves the call feedback to the live bar, not the generic save toast', () => {
    // The global mutation cache toasts "Saved successfully / Your changes have
    // been applied" for every mutation, and starting a call ran two of them.
    // LiveCallBar now follows the call instead, so the dialog stays silent.
    expect(customerActions).toContain('meta: { toast: false }');
    expect(customerActions).toContain('LiveCallBar takes over from here');
    expect(customerActions).not.toContain("title: 'Calling ' + customerName");
  });

  it('keeps the contact record silent so it does not double-toast the call', () => {
    expect(leadWorkspace).toContain('meta: { toast: false }');
    // A failed contact record must still say so.
    expect(leadWorkspace).toContain('Contact was not recorded');
  });
});

describe('stored app secret', () => {
  it('reuses the encrypted secret when a re-save leaves the field blank', () => {
    // Editing the caller ID should not send a Client Admin back to TeleCMI to
    // fetch the secret again. The secret is still never returned to a browser.
    // An untouched field posts '', which must mean "keep the stored secret".
    expect(connect).toContain('z.preprocess(');
    expect(connect).toContain("value.trim() === '' ? undefined : value");
    expect(connect).toContain('input.app_secret ?? previousCredential?.app_secret');
    expect(connect).toContain('TELECMI_APP_SECRET_REQUIRED');
    expect(connect).toContain('An App Secret is required for a new connection.');
  });

  it('shows that one is stored without ever rendering its value', () => {
    expect(integrationWorkspace).toContain('existingSecretStored');
    expect(integrationWorkspace).toContain('required={!existingSecretStored}');
    expect(integrationWorkspace).toContain('Leave this blank to keep it');
    // Provisioning talks to TeleCMI directly and cannot reuse a stored secret.
    expect(agentEditor).toContain('Enter the App Secret above to create an agent in TeleCMI.');
    // Every rejected field used to be reported as an IVR problem.
    expect(connect).not.toContain('TeleCMI IVR settings are invalid.');
    expect(connect).toContain('Check the ${field');
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

describe('TeleCMI inbound IVR call log', () => {
  const inboundMigration = source('supabase/migrations/202610091303_telecmi_inbound_call_log.sql');

  it('treats only TeleCMI inbound calls the CRM did not start as inbound', () => {
    expect(webhook).toContain(
      "text(payload.direction, 20).toLowerCase() === 'inbound' && !crmCallId && !providerRequestId",
    );
    expect(webhook).toContain("admin.rpc('apply_telecmi_inbound_call_event'");
    expect(webhook).toContain("caller_phone: inbound ? text(payload.from, 40).replace(/\\D/g, '')");
    expect(dispatch).toContain("supabase.rpc('apply_telecmi_inbound_call_event'");
    expect(dispatch).toContain("inbound: receipt.direction === 'inbound'");
  });

  it('logs one call row per conversation and never creates a lead or customer', () => {
    expect(inboundMigration).toContain(
      'on conflict (organization_id, connection_id, provider_call_id)',
    );
    expect(inboundMigration).toContain("'INBOUND',\n      'PROVIDER', 'HUMAN', 'RINGING'");
    expect(inboundMigration).not.toMatch(/insert into public\.(leads|customers)/);
    expect(inboundMigration).toContain("message = 'SERVICE_ROLE_REQUIRED'");
    expect(inboundMigration).toContain("'call.inbound_logged'");
  });

  it('marks an unanswered inbound call as a missed call and lets the call-end record decide', () => {
    expect(inboundMigration).toContain(
      "next_status := 'FAILED';\n      next_outcome := 'NO_ANSWER';",
    );
    expect(inboundMigration).toContain(
      "next_status := 'COMPLETED';\n      next_outcome := 'CONNECTED';",
    );
  });

  it('gives the call to the answering agent, else the lead owner, else the least-loaded telecaller', () => {
    expect(inboundMigration).toContain('owner_id := agent_profile_id;');
    expect(inboundMigration).toContain('owner_id := lead_match.assigned_user_id;');
    expect(inboundMigration).toContain("member_row.member_type::text = 'TELECALLER_BDC'");
    expect(inboundMigration).toContain("missed_row.outcome = 'NO_ANSWER'");
  });
});

describe('inbound caller shown on the Calls list and turned into a lead', () => {
  const listMigration = source('supabase/migrations/202610091351_call_list_caller_phone.sql');
  const leadMigration = source('supabase/migrations/202610091401_create_lead_from_call.sql');
  const dialog = source('src/features/calls/create-lead-from-call-dialog.tsx');

  it('shows and searches the caller number only when no lead or customer resolves', () => {
    expect(listMigration).toContain('else call_row.caller_phone\n      end as phone');
    expect(listMigration).toContain(
      "else app_private.normalize_phone_digits(coalesce(call_row.normalized_caller_phone, ''))",
    );
    expect(listMigration).toContain('Text-patched from the deployed pg_get_functiondef');
  });

  it('creates the lead through create_lead and links the call in one transaction', () => {
    expect(leadMigration).toContain(
      'app_private.can_access_call(call_row.organization_id, call_row.id)',
    );
    expect(leadMigration).toContain("errcode = 'PT409', message = 'CALL_ALREADY_HAS_LEAD'");
    expect(leadMigration).toContain('new_lead_id := public.create_lead(');
    expect(leadMigration).toContain('call_row.normalized_caller_phone,');
    expect(leadMigration).toContain("'call.lead_created_from_call'");
    expect(leadMigration).toContain('for update;');
    expect(leadMigration).not.toContain('to anon');
  });

  it('lets the telecaller who handled the call keep the new lead', () => {
    // No team: create_lead self-assigns for own-records users instead of round robin.
    expect(leadMigration).toMatch(/call_row\.branch_id,\n[\s\S]*?\n {4}null,\n {4}'Manual',/);
  });

  it('never takes the phone number from the browser', () => {
    expect(api).toContain("rpc('create_lead_from_call'");
    expect(api).not.toMatch(/create_lead_from_call[\s\S]{0,200}lead_phone/);
    expect(dialog).toContain(
      "(call.direction === 'INBOUND' || call.call_source === 'PERSONAL_MANUAL') &&",
    );
    expect(dialog).toContain('!call.lead_id &&\n    !call.customer_id');
    // The pre-filled path also takes the number from the call, not the form.
    expect(api).toContain("rpc('create_lead_from_call_review'");
    expect(api).not.toMatch(/create_lead_from_call_review[\s\S]{0,400}phone/);
  });
});
