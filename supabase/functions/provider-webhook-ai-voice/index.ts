import { constantTimeEqual, hmacSha256Hex, sha256Base64Url } from '../_shared/crypto.ts';
import { serviceClient } from '../_shared/supabase.ts';

type WebhookClaim = {
  claimed?: boolean;
  replayed?: boolean;
  event_id?: string;
  lease_token?: string;
};

type AiVoicePayload = {
  event_id?: string;
  call_id?: string;
  status?: string;
  outcome?: string;
  duration_seconds?: number;
  recording_id?: string;
  recording_url?: string;
  recording_mime_type?: string;
  metadata?: { organization_id?: string; crm_call_id?: string; lead_id?: string };
};

type AppliedCallEvent = {
  call_id?: string;
  branch_id?: string;
  call_status?: string;
  recording_id?: string | null;
  recording_status?: string | null;
};

function json(status: number, code: string) {
  return new Response(JSON.stringify({ ok: status < 400, code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function noContent() {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

function safeCode(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_]{3,100}$/.test(message) ? message : 'AI_VOICE_WEBHOOK_FAILED';
}

async function verifySignature(request: Request, rawBody: string) {
  const secret = Deno.env.get('AI_VOICE_WEBHOOK_SECRET')?.trim() ?? '';
  const timestamp = request.headers.get('x-ai-voice-timestamp')?.trim() ?? '';
  const supplied = request.headers.get('x-ai-voice-signature')?.trim().toLocaleLowerCase() ?? '';
  if (secret.length < 32 || !/^\d{10}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(supplied))
    return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > 300
  )
    return false;
  const expected = `sha256=${await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
  return constantTimeEqual(supplied, expected);
}

function normalizedCallStatus(value: unknown) {
  if (typeof value !== 'string') return null;
  switch (value.trim().toUpperCase()) {
    case 'QUEUED':
    case 'PENDING':
      return 'PENDING';
    case 'RINGING':
      return 'RINGING';
    case 'ANSWERED':
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'NO_ANSWER':
    case 'BUSY':
    case 'FAILED':
      return 'FAILED';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return null;
  }
}

function validatedRecordingUrl(value: string) {
  if (value.length > 2048) throw new Error('AI_VOICE_RECORDING_URL_INVALID');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('AI_VOICE_RECORDING_URL_INVALID');
  return url.toString();
}

function validatedRecordingMimeType(value: string | undefined) {
  const normalized = (value || 'audio/mpeg').split(';', 1)[0]?.trim().toLocaleLowerCase() ?? '';
  if (
    !['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'].includes(
      normalized,
    )
  )
    throw new Error('AI_VOICE_RECORDING_MIME_INVALID');
  return normalized;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, 'METHOD_NOT_ALLOWED');
  let claimedEventId: string | null = null;
  let leaseToken: string | null = null;
  const admin = serviceClient();
  try {
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > 512_000)
      return json(413, 'PAYLOAD_TOO_LARGE');
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 512_000)
      return json(413, 'PAYLOAD_TOO_LARGE');
    if (!(await verifySignature(request, rawBody))) return json(401, 'INVALID_SIGNATURE');
    let payload: AiVoicePayload;
    try {
      payload = JSON.parse(rawBody) as AiVoicePayload;
    } catch {
      return json(400, 'INVALID_JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return json(422, 'INVALID_EVENT');
    const metadata: Record<string, unknown> =
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
    const organizationId =
      typeof metadata.organization_id === 'string' ? metadata.organization_id.trim() : '';
    const crmCallId = typeof metadata.crm_call_id === 'string' ? metadata.crm_call_id.trim() : '';
    const providerCallId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
    const providerEventId = typeof payload.event_id === 'string' ? payload.event_id.trim() : '';
    const nextStatus = normalizedCallStatus(payload.status);
    if (!organizationId || !crmCallId || !providerCallId || !providerEventId || !nextStatus)
      return json(422, 'INVALID_EVENT');
    if (
      payload.duration_seconds !== undefined &&
      (!Number.isSafeInteger(payload.duration_seconds) ||
        payload.duration_seconds < 0 ||
        payload.duration_seconds > 86_400)
    )
      return json(422, 'INVALID_DURATION');
    if (
      payload.outcome !== undefined &&
      (typeof payload.outcome !== 'string' || payload.outcome.trim().length > 100)
    )
      return json(422, 'INVALID_OUTCOME');
    let recordingUrl: string | null = null;
    let recordingProviderId: string | null = null;
    let recordingMimeType: string | null = null;
    if (nextStatus === 'COMPLETED' && payload.recording_url !== undefined) {
      try {
        if (typeof payload.recording_url !== 'string' || !payload.recording_url.trim())
          throw new Error('AI_VOICE_RECORDING_URL_INVALID');
        recordingUrl = validatedRecordingUrl(payload.recording_url);
        if (payload.recording_id !== undefined && typeof payload.recording_id !== 'string')
          throw new Error('AI_VOICE_RECORDING_ID_INVALID');
        if (
          payload.recording_mime_type !== undefined &&
          typeof payload.recording_mime_type !== 'string'
        )
          throw new Error('AI_VOICE_RECORDING_MIME_INVALID');
        recordingProviderId = payload.recording_id?.trim() || providerCallId;
        if (recordingProviderId.length > 255) throw new Error('AI_VOICE_RECORDING_ID_INVALID');
        recordingMimeType = validatedRecordingMimeType(payload.recording_mime_type);
      } catch (error) {
        return json(422, safeCode(error));
      }
    }
    const payloadHash = await sha256Base64Url(rawBody);
    const { data: claimed, error: claimError } = await admin.rpc('claim_ai_voice_webhook_event', {
      target_organization_id: organizationId,
      target_call_id: crmCallId,
      target_provider_event_id: providerEventId,
      target_provider_call_id: providerCallId,
      target_payload_hash: payloadHash,
    });
    if (claimError) return json(422, 'WEBHOOK_IDENTITY_REJECTED');
    const claim = claimed as WebhookClaim;
    if (!claim.claimed) return noContent();
    if (!claim.event_id || !claim.lease_token) throw new Error('AI_VOICE_WEBHOOK_CLAIM_INVALID');
    claimedEventId = claim.event_id;
    leaseToken = claim.lease_token;
    const { data: appliedData, error: applyError } = await admin.rpc('apply_ai_voice_call_event', {
      target_event_id: claim.event_id,
      target_lease_token: claim.lease_token,
      target_organization_id: organizationId,
      target_call_id: crmCallId,
      target_provider_call_id: providerCallId,
      target_next_status: nextStatus,
      target_outcome: payload.outcome?.trim() || null,
      target_duration_seconds: payload.duration_seconds ?? null,
      target_recording_provider_id: recordingProviderId,
    });
    if (applyError) throw applyError;
    const applied = appliedData as AppliedCallEvent | null;
    if (!applied?.call_id || !applied.branch_id)
      throw new Error('AI_VOICE_CALL_EVENT_APPLY_INVALID');
    if (recordingUrl && recordingMimeType && applied.recording_id) {
      if (applied.recording_status !== 'READY') {
        const triggerSecret = Deno.env.get('TRIGGER_SECRET_KEY');
        if (!triggerSecret) throw new Error('TRIGGER_SECRET_KEY_MISSING');
        const triggered = await fetch(
          'https://api.trigger.dev/api/v1/tasks/provider-recording-ingest/trigger',
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${triggerSecret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              payload: {
                organizationId,
                branchId: applied.branch_id,
                callId: applied.call_id,
                recordingId: applied.recording_id,
                providerRecordingUrl: recordingUrl,
                mimeType: recordingMimeType,
              },
              options: { idempotencyKey: `ai-voice-recording:${applied.recording_id}` },
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!triggered.ok) throw new Error('RECORDING_INGEST_ENQUEUE_FAILED');
      }
    }
    const completed = await admin.rpc('complete_ai_voice_webhook_event', {
      target_event_id: claimedEventId,
      target_lease_token: leaseToken,
    });
    if (completed.error || !completed.data) throw new Error('AI_VOICE_WEBHOOK_LEASE_LOST');
    return noContent();
  } catch (error) {
    if (claimedEventId && leaseToken)
      await admin.rpc('fail_ai_voice_webhook_event', {
        target_event_id: claimedEventId,
        target_lease_token: leaseToken,
        target_safe_error_code: safeCode(error),
      });
    return json(503, safeCode(error));
  }
});
