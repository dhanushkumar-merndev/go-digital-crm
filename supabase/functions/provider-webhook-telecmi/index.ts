import { decryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { constantTimeEqual, type TelecmiCredential } from '../_shared/telecmi.ts';

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
    if (Number.isFinite(declaredLength) && declaredLength > 512_000) return response(413);

    const rawBody = request.method === 'POST' ? await request.text() : '';
    if (new TextEncoder().encode(rawBody).byteLength > 512_000) return response(413);
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
    // TeleCMI shares call_id across both bridged legs. cmiuuid identifies one
    // leg only, so retaining it as the call identity would split one CRM call.
    const providerCallId = text(payload.call_id, 255);
    const providerLegId = text(payload.cmiuuid, 255);
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
    };
    const payloadHash = await sha256Base64Url(rawBody || JSON.stringify(safePayload));
    const { error: receiptError } = await admin.from('provider_events').insert({
      organization_id: connection.organization_id,
      connected_account_id: connection.id,
      provider_event_id: eventId,
      event_type: 'TELECMI_CALL_EVENT',
      payload_hash: payloadHash,
      payload: safePayload,
      status: 'RECEIVED',
    });
    if (receiptError) {
      if (receiptError.code !== '23505') throw receiptError;
      const { data: existing, error: existingError } = await admin
        .from('provider_events')
        .select('payload_hash')
        .eq('organization_id', connection.organization_id)
        .eq('connected_account_id', connection.id)
        .eq('provider_event_id', eventId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing || !constantTimeEqual(existing.payload_hash, payloadHash)) return response(409);
    }
    return response();
  } catch {
    return response(500);
  }
});
