import { z } from 'npm:zod@4';
import { decryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import {
  createTwilioBridgeCall,
  normalizedE164,
  type TwilioVoiceCredential,
} from '../_shared/twilio-voice.ts';

const schema = z.object({
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  lead_id: z.uuid(),
  request_id: z.uuid(),
});

function xmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  let callId: string | null = null;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The provider call request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: context, error: contextError } = await client.rpc(
      'create_provider_call_request',
      {
        target_connection_id: parsed.data.connection_id,
        target_lead_id: parsed.data.lead_id,
        target_request_id: parsed.data.request_id,
      },
    );
    if (contextError || !context)
      return failure(
        'PROVIDER_CALL_NOT_AUTHORIZED',
        'The provider call could not be authorized for this lead.',
        requestId,
        403,
      );
    const callContext = z
      .object({
        call_id: z.uuid(),
        organization_id: z.uuid(),
        branch_id: z.uuid(),
        connection_id: z.uuid(),
        provider_key: z.literal('twilio_voice'),
        caller_phone: z.string(),
        customer_phone: z.string(),
        replayed: z.boolean(),
      })
      .parse(context);
    callId = callContext.call_id;
    if (callContext.organization_id !== parsed.data.organization_id)
      throw new Error('ORGANIZATION_CONTEXT_MISMATCH');
    const admin = serviceClient();
    if (callContext.replayed) {
      const { data: existingCall } = await admin
        .from('calls')
        .select('provider_call_id,status')
        .eq('id', callContext.call_id)
        .eq('organization_id', callContext.organization_id)
        .maybeSingle();
      if (existingCall?.provider_call_id)
        return success(
          {
            call_id: callContext.call_id,
            provider_call_id: existingCall.provider_call_id,
            status: existingCall.status,
            replayed: true,
          },
          requestId,
        );
      return failure(
        'PROVIDER_CALL_REQUEST_IN_PROGRESS',
        'This provider call request is already being processed.',
        requestId,
        409,
      );
    }
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', callContext.organization_id)
      .eq('connected_account_id', callContext.connection_id)
      .maybeSingle();
    if (!secret) throw new Error('TWILIO_CREDENTIAL_NOT_CONFIGURED');
    const credential = await decryptJson<TwilioVoiceCredential>(secret.encrypted_payload);
    const callbackBase = Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL')?.replace(/\/$/, '');
    if (!callbackBase) throw new Error('PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING');
    const callback = `${callbackBase}/provider-webhook-twilio?connection_id=${callContext.connection_id}&call_id=${callContext.call_id}`;
    const dialAction = `${callback}&kind=dial`;
    const recordingCallback = `${callback}&kind=recording`;
    const customerPhone = normalizedE164(callContext.customer_phone);
    const twilioNumber = normalizedE164(credential.phone_number);
    const twiml =
      `<Response><Dial callerId="${xmlAttribute(twilioNumber)}" answerOnBridge="true" ` +
      `record="record-from-answer-dual" action="${xmlAttribute(dialAction)}" method="POST" ` +
      `recordingStatusCallback="${xmlAttribute(recordingCallback)}" ` +
      `recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">` +
      `<Number>${customerPhone}</Number></Dial></Response>`;
    const started = await createTwilioBridgeCall({
      credential,
      consultantPhone: callContext.caller_phone,
      customerPhone,
      twiml,
      statusCallback: `${callback}&kind=status`,
    });
    const { error: updateError } = await admin
      .from('calls')
      .update({ provider_call_id: started.providerCallId, status: 'PENDING' })
      .eq('id', callContext.call_id)
      .eq('organization_id', callContext.organization_id)
      .eq('connection_id', callContext.connection_id)
      .is('provider_call_id', null);
    if (updateError) throw updateError;
    return success(
      {
        call_id: callContext.call_id,
        provider_call_id: started.providerCallId,
        status: started.status,
      },
      requestId,
      201,
    );
  } catch {
    if (callId)
      await serviceClient()
        .from('calls')
        .update({ status: 'FAILED', ended_at: new Date().toISOString() })
        .eq('id', callId)
        .is('provider_call_id', null);
    return failure(
      'TWILIO_CALL_START_FAILED',
      'The Twilio call could not be started. Try a normal phone call or contact an administrator.',
      requestId,
      502,
    );
  }
});
