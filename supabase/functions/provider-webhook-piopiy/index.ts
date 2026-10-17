import { dialNextAutoCalls, loadPiopiyConnection } from '../_shared/auto-call.ts';
import { constantTimeEqual } from '../_shared/crypto.ts';
import { piopiyCallEvent } from '../_shared/piopiy.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { enqueueTriggerTask } from '../_shared/trigger-task.ts';

// PIOPIY call status / CDR callback for auto calls, keypad and AI alike.
// Matching is by PIOPIY's call id on this connection; an event for a call we
// do not know is acknowledged and ignored. Finalizing is idempotent, so
// redelivery is safe. An answered AI call stays open until the voice agent
// posts its result (provider-ai-agent-result), which then dials the next lead.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ code: 405 }, 405);
  const url = new URL(request.url);
  const connectionId = url.searchParams.get('connection_id') ?? '';
  const token = url.searchParams.get('token') ?? '';
  if (!UUID.test(connectionId) || !token) return json({ code: 400 }, 400);
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ code: 413 }, 413);
    let raw: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') raw = parsed;
    } catch {
      raw = Object.fromEntries(new URLSearchParams(text).entries());
    }
    const admin = serviceClient();
    const connection = await loadPiopiyConnection(admin, connectionId);
    if (!connection || !constantTimeEqual(token, connection.credential.webhook_secret))
      return json({ code: 403 }, 403);

    const event = piopiyCallEvent(raw);
    if (!event.callId || !event.terminal) return json({ code: 200, applied: false });
    const { data: call } = await admin
      .from('calls')
      .select('id, call_mode')
      .eq('organization_id', connection.organizationId)
      .eq('connection_id', connection.id)
      .eq('provider_call_id', event.callId)
      .in('call_mode', ['AUTO_IVR', 'AUTO_AI'])
      .maybeSingle();
    if (!call) return json({ code: 200, applied: false });

    const { data: finalized, error } = await admin.rpc(
      call.call_mode === 'AUTO_AI' ? 'finalize_auto_ai_call' : 'finalize_auto_ivr_call',
      {
        target_connection_id: connection.id,
        target_call_id: call.id,
        target_provider_status: event.status,
        target_duration_seconds: event.durationSeconds,
        target_recording_ref: event.recordingRef,
      },
    );
    if (error) return json({ code: 500 }, 500);
    const result = finalized as {
      organization_id: string;
      branch_id: string;
      call_id: string;
      recording_id: string | null;
      pending_result?: boolean;
    };
    if (result.recording_id && event.recordingUrl) {
      await enqueueTriggerTask(
        'provider-recording-ingest',
        {
          organizationId: result.organization_id,
          branchId: result.branch_id,
          callId: result.call_id,
          recordingId: result.recording_id,
          providerRecordingUrl: event.recordingUrl,
          mimeType: event.recordingUrl.toLowerCase().includes('.wav') ? 'audio/wav' : 'audio/mpeg',
        },
        `auto-call-recording:${result.recording_id}`,
      ).catch(() => null);
    }
    // The telecaller's next lead is dialled now rather than at the next minute.
    if (!result.pending_result)
      await dialNextAutoCalls(admin, `piopiy-webhook:${call.id}`, 5).catch(() => null);
    return json({ code: 200, applied: true });
  } catch {
    return json({ code: 500 }, 500);
  }
});
