import { decryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { constantTimeEqual, type TelecmiCredential } from '../_shared/telecmi.ts';
import { extractTelecmiSpeech, unrecognisedPayloadFields } from '../_shared/telecmi-speech.ts';

// Speech IVR transcripts can be long; CDRs and live events are a few hundred bytes.
const MAX_BODY_BYTES = 2_000_000;

// Every field TeleCMI documents for CHUB CDRs and live events. Anything else is
// reported by name in extra_fields so an undocumented Speech IVR payload shows
// its shape on the first delivery without storing what the customer said.
const DOCUMENTED_FIELDS = new Set([
  'appid',
  'app_id',
  'custom',
  'extra_params',
  'request_id',
  'call_id',
  'cmiuuid',
  'conversation_uuid',
  'type',
  'leg',
  'status',
  'time',
  'end_time',
  'answeredsec',
  'billedsec',
  'duration',
  'waitedsec',
  'record',
  'filename',
  'voicemail',
  'voicename',
  'virtual_number',
  'callerid',
  'from',
  'to',
  'user',
  'agent',
  'name',
  'direction',
  'hangup_reason',
  'team',
  'ivr_name',
  'rate',
  'notes',
  'region',
]);

function response(status = 204) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

function objectValue(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown, maximum = 500) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, maximum)
    : '';
}

function nonnegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 86_400 ? parsed : null;
}

Deno.serve(async (request) => {
  if (!['POST', 'GET'].includes(request.method)) return response(405);
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get('connection_id');
    const suppliedToken = url.searchParams.get('token') ?? '';
    if (!connectionId || !suppliedToken) return response(400);
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return response(413);

    const rawBody = request.method === 'POST' ? await request.text() : '';
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return response(413);
    const payload =
      request.method === 'POST'
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(url.searchParams.entries());
    const admin = serviceClient();
    const { data: connection, error: connectionError } = await admin
      .from('connected_accounts')
      .select('id,organization_id,provider_key,status')
      .eq('id', connectionId)
      .eq('provider_key', 'telecmi')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) return response(404);
    const { data: secret, error: secretError } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', connection.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (secretError) throw secretError;
    if (!secret) return response(404);
    const credential = await decryptJson<TelecmiCredential>(secret.encrypted_payload);
    if (!constantTimeEqual(suppliedToken, credential.webhook_secret)) return response(403);
    if (Number(payload.appid ?? payload.app_id) !== credential.app_id) return response(403);

    const extra = { ...objectValue(payload.custom), ...objectValue(payload.extra_params) };
    const crmCallId = text(extra.crm_call_id, 80);
    const providerRequestId = text(payload.request_id, 255);
    // A call to the IVR number: TeleCMI says inbound, and the CRM did not start it.
    const inbound =
      text(payload.direction, 20).toLowerCase() === 'inbound' && !crmCallId && !providerRequestId;
    // TeleCMI shares call_id across both bridged legs. cmiuuid identifies one
    // leg only, so retaining it as the call identity would split one CRM call.
    // Inbound events carry no call_id; conversation_uuid is their shared id.
    const providerLegId = text(payload.cmiuuid, 255);
    const providerCallId =
      text(payload.call_id, 255) ||
      (inbound ? text(payload.conversation_uuid, 255) || providerLegId : '');
    if (!crmCallId && !providerRequestId && !providerCallId && !providerLegId) return response(422);
    const eventId = [
      providerLegId || providerCallId || providerRequestId || crmCallId,
      text(payload.type, 80) || 'call',
      text(payload.leg, 40) || 'single',
      text(payload.status, 80) || 'unknown',
      text(payload.time, 80) || text(payload.end_time, 80) || 'undated',
    ]
      .join(':')
      .slice(0, 500);
    const speech = extractTelecmiSpeech(payload);
    const extraFields = unrecognisedPayloadFields(payload, DOCUMENTED_FIELDS);
    const safePayload = {
      crm_call_id: crmCallId || null,
      provider_request_id: providerRequestId || null,
      provider_call_id: providerCallId || null,
      provider_leg_id: providerLegId || null,
      event_type: text(payload.type, 80) || 'call',
      leg: text(payload.leg, 40) || null,
      status: text(payload.status, 80).toUpperCase() || null,
      duration_seconds: nonnegativeInteger(
        payload.answeredsec ?? payload.billedsec ?? payload.duration,
      ),
      recorded: payload.record === true || text(payload.record, 10).toLowerCase() === 'true',
      recording_file: text(payload.filename, 255) || null,
      direction: inbound ? 'inbound' : text(payload.direction, 20).toLowerCase() || null,
      // Digits only: the caller's number is what a telecaller calls back.
      caller_phone: inbound ? text(payload.from, 40).replace(/\D/g, '').slice(0, 20) || null : null,
      agent_user_id: text(payload.user, 80) || null,
      ...(extraFields.length ? { extra_fields: extraFields } : {}),
      ...(speech
        ? {
            speech: {
              transcript_chars: speech.transcript?.length ?? 0,
              turns: speech.turns.length,
              summary_chars: speech.summary?.length ?? 0,
            },
          }
        : {}),
    };
    const payloadHash = await sha256Base64Url(rawBody || JSON.stringify(safePayload));
    const { data: receipt, error: receiptError } = await admin
      .from('provider_events')
      .insert({
        organization_id: connection.organization_id,
        connected_account_id: connection.id,
        provider_event_id: eventId,
        event_type: 'TELECMI_CALL_EVENT',
        payload_hash: payloadHash,
        payload: safePayload,
        status: 'RECEIVED',
      })
      .select('id,received_at')
      .single();
    let storedReceipt = receipt as { id: string; received_at: string } | null;
    if (receiptError) {
      if (receiptError.code !== '23505') throw receiptError;
      const { data: existing, error: existingError } = await admin
        .from('provider_events')
        .select('id,received_at,payload_hash')
        .eq('organization_id', connection.organization_id)
        .eq('connected_account_id', connection.id)
        .eq('provider_event_id', eventId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) return response(409);
      // A different body under the same event id is a conflict, except when it
      // carries Speech IVR text: TeleCMI may resend the CDR enriched with the
      // transcript, and refusing it would lose the transcript for good.
      if (!constantTimeEqual(existing.payload_hash, payloadHash) && !speech) return response(409);
      // A redelivery is applied again rather than skipped: the first delivery
      // may have stored its receipt and then failed before moving the call.
      storedReceipt = existing;
    }
    if (!storedReceipt) throw new Error('TELECMI_RECEIPT_NOT_STORED');

    // Move the call now, not on the next dispatcher cron tick. The live call
    // bar follows public.calls over realtime, so this is what makes "Ringing
    // you" -> "Calling customer" -> "Connected" -> "Call ended" track the phone
    // within a second. The dispatcher replays the same receipt later for
    // recording ingestion; the apply is idempotent, so the replay is a no-op.
    // An inbound call is logged (created on first sight) rather than matched to
    // a call the CRM placed.
    const { data: applied, error: applyError } = inbound
      ? await admin.rpc('apply_telecmi_inbound_call_event', {
          target_organization_id: connection.organization_id,
          target_connection_id: connection.id,
          target_received_at: storedReceipt.received_at,
          target_receipt: safePayload,
        })
      : await admin.rpc('apply_telecmi_call_event', {
          target_organization_id: connection.organization_id,
          target_connection_id: connection.id,
          target_provider_event_id: storedReceipt.id,
          target_received_at: storedReceipt.received_at,
          target_receipt: safePayload,
        });
    // A receipt the database rejects as malformed or unmappable stays stored for
    // the dispatcher to settle and report; asking TeleCMI to redeliver it would
    // not change the answer. Anything else is transient, so TeleCMI retries.
    if (applyError && !applyError.code?.startsWith('22')) throw applyError;

    // Speech IVR text belongs to the CRM call the receipt mapped to. It costs no
    // AI credit; an unmapped call keeps only the receipt (with speech sizes).
    const appliedCallId =
      applied && typeof applied === 'object' && 'call_id' in applied
        ? text((applied as { call_id: unknown }).call_id, 80)
        : '';
    if (speech && appliedCallId) {
      const { error: speechError } = await admin.rpc('save_provider_call_intelligence', {
        target_organization_id: connection.organization_id,
        target_call_id: appliedCallId,
        target_source: 'TELECMI',
        target_transcript: speech.transcript,
        target_speaker_turns: speech.turns,
        target_summary: speech.summary,
        target_language: speech.language,
        target_provider_reference: 'telecmi:speech_ivr',
      });
      if (speechError && !speechError.code?.startsWith('22')) throw speechError;
    }
    return response();
  } catch {
    return response(500);
  }
});
