import { decryptJson } from '../_shared/crypto.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { validateTwilioSignature, type TwilioVoiceCredential } from '../_shared/twilio-voice.ts';

function response(status = 204) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

function outcomeFor(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'completed') return 'CONNECTED';
  if (normalized === 'busy') return 'BUSY';
  if (normalized === 'no-answer') return 'NO_ANSWER';
  if (normalized === 'canceled') return 'OTHER';
  if (normalized === 'failed') return 'OTHER';
  return null;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response(405);
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get('connection_id');
    const callId = url.searchParams.get('call_id');
    const kind = url.searchParams.get('kind');
    if (!connectionId || !callId || !kind) return response(400);
    const form = new URLSearchParams(await request.text());
    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,organization_id,provider_key,status')
      .eq('id', connectionId)
      .eq('provider_key', 'twilio_voice')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection) return response(404);
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', connection.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (!secret) return response(404);
    const credential = await decryptJson<TwilioVoiceCredential>(secret.encrypted_payload);
    const signature = request.headers.get('x-twilio-signature') ?? '';
    if (
      !(await validateTwilioSignature({
        url: request.url,
        form,
        signature,
        authToken: credential.auth_token,
      }))
    )
      return response(403);

    const providerCallId = form.get('CallSid');
    const { data: call } = await admin
      .from('calls')
      .select('id,organization_id,branch_id,provider_call_id')
      .eq('id', callId)
      .eq('organization_id', connection.organization_id)
      .eq('connection_id', connection.id)
      .maybeSingle();
    if (!call || (call.provider_call_id && providerCallId !== call.provider_call_id))
      return response(404);

    if (kind === 'status') {
      const providerStatus = (form.get('CallStatus') ?? '').toLowerCase();
      if (['failed', 'busy', 'no-answer', 'canceled'].includes(providerStatus))
        await admin
          .from('calls')
          .update({
            status: providerStatus === 'canceled' ? 'CANCELLED' : 'FAILED',
            outcome: outcomeFor(providerStatus),
            ended_at: new Date().toISOString(),
          })
          .eq('id', call.id);
      return response();
    }

    if (kind === 'dial') {
      const dialStatus = form.get('DialCallStatus') ?? '';
      const duration = Number(form.get('DialCallDuration') ?? '0');
      await admin
        .from('calls')
        .update({
          status: dialStatus.toLowerCase() === 'completed' ? 'COMPLETED' : 'FAILED',
          outcome: outcomeFor(dialStatus) ?? 'OTHER',
          ended_at: new Date().toISOString(),
          duration_seconds: Number.isSafeInteger(duration) && duration >= 0 ? duration : null,
          finalized_at: new Date().toISOString(),
        })
        .eq('id', call.id);
      return new Response('<Response></Response>', {
        status: 200,
        headers: { 'content-type': 'text/xml', 'cache-control': 'no-store' },
      });
    }

    if (kind === 'recording' && form.get('RecordingStatus') === 'completed') {
      const recordingSid = form.get('RecordingSid');
      const recordingUrl = form.get('RecordingUrl');
      const duration = Number(form.get('RecordingDuration') ?? '0');
      if (!recordingSid || !recordingUrl) return response(400);
      let { data: recording } = await admin
        .from('call_recordings')
        .select('id')
        .eq('organization_id', call.organization_id)
        .eq('call_id', call.id)
        .eq('provider_recording_id', recordingSid)
        .maybeSingle();
      if (!recording) {
        const inserted = await admin
          .from('call_recordings')
          .insert({
            organization_id: call.organization_id,
            call_id: call.id,
            source: 'PROVIDER_SYNC',
            status: 'PENDING',
            provider_recording_id: recordingSid,
            duration_seconds: Number.isSafeInteger(duration) && duration >= 0 ? duration : null,
          })
          .select('id')
          .single();
        if (inserted.error) {
          const existing = await admin
            .from('call_recordings')
            .select('id')
            .eq('organization_id', call.organization_id)
            .eq('call_id', call.id)
            .eq('provider_recording_id', recordingSid)
            .maybeSingle();
          if (!existing.data) throw inserted.error;
          recording = existing.data;
        } else recording = inserted.data;
      }
      if (!recording) throw new Error('RECORDING_METADATA_CREATE_FAILED');
      const triggerSecret = Deno.env.get('TRIGGER_SECRET_KEY');
      if (!triggerSecret) throw new Error('TRIGGER_SECRET_KEY_MISSING');
      const triggerResponse = await fetch(
        'https://api.trigger.dev/api/v1/tasks/provider-recording-ingest/trigger',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${triggerSecret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            payload: {
              organizationId: call.organization_id,
              branchId: call.branch_id,
              callId: call.id,
              recordingId: recording.id,
              connectionId: connection.id,
              provider: 'twilio_voice',
              providerRecordingUrl: `${recordingUrl}.mp3`,
              mimeType: 'audio/mpeg',
            },
            options: { idempotencyKey: `twilio-recording:${recordingSid}` },
          }),
        },
      );
      if (!triggerResponse.ok) throw new Error('RECORDING_INGEST_ENQUEUE_FAILED');
      return response();
    }
    return response(400);
  } catch {
    return response(500);
  }
});
