import { z } from 'npm:zod@4';
import { decryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import {
  createTelecmiClickToCall,
  describeTelecmiFailure,
  parseTelecmiCallMode,
  TelecmiError,
  type TelecmiCredential,
} from '../_shared/telecmi.ts';

const schema = z.object({
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  lead_id: z.uuid(),
  request_id: z.uuid(),
});

type DescribedFailure = { code: string; message: string; status: number };

// create_provider_call_request raises one of a fixed set of messages. Passing
// the matching one back is what tells a telecaller whether the lead is out of
// scope or their own mobile was never mapped to a TeleCMI agent -- two very
// different fixes that a single "not authorized" would hide.
const rpcFailures: Record<string, DescribedFailure> = {
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    message: 'You do not have permission to place calls.',
    status: 403,
  },
  CALL_LEAD_NOT_AUTHORIZED: {
    code: 'CALL_LEAD_NOT_AUTHORIZED',
    message: 'This lead is outside your branch, team, or record scope.',
    status: 403,
  },
  CALL_PROVIDER_SCOPE_DENIED: {
    code: 'CALL_PROVIDER_SCOPE_DENIED',
    message: 'This dealership line is not mapped to the lead branch.',
    status: 403,
  },
  TELECMI_CALLER_MAPPING_NOT_CONFIGURED: {
    code: 'TELECMI_CALLER_MAPPING_NOT_CONFIGURED',
    message:
      'Your mobile number is not mapped to a TeleCMI agent on this connection. Ask a Client Admin to add it under the dealership line.',
    status: 409,
  },
};

// Failures raised locally before or after the provider request. They are
// separated from the TeleCMI vocabulary so a configuration gap on our side is
// never reported as a provider rejection.
const localFailures: Record<string, DescribedFailure> = {
  TELECMI_CREDENTIAL_NOT_CONFIGURED: {
    code: 'TELECMI_CREDENTIAL_NOT_CONFIGURED',
    message:
      'The stored TeleCMI credential for this dealership line is missing. Ask a Client Admin to reconnect TeleCMI.',
    status: 409,
  },
  PHONE_NOT_INTERNATIONAL: {
    code: 'CALL_CUSTOMER_PHONE_NOT_DIALABLE',
    message:
      'The customer number is not dialable. Save it with the country code, for example 91 followed by the 10-digit mobile.',
    status: 422,
  },
  TELECMI_USER_ID_INVALID: {
    code: 'TELECMI_USER_ID_INVALID',
    message:
      'The TeleCMI agent id mapped to your mobile is malformed. Ask a Client Admin to re-provision your agent.',
    status: 409,
  },
  TELECMI_REQUEST_ID_MISSING: {
    code: 'TELECMI_REQUEST_ID_MISSING',
    message: 'TeleCMI accepted the request but returned no call reference. Try again.',
    status: 502,
  },
};

function describeCallStartFailure(error: unknown): DescribedFailure {
  if (error instanceof TelecmiError) return describeTelecmiFailure(error);
  const local = error instanceof Error ? localFailures[error.message] : undefined;
  return (
    local ?? {
      code: 'TELECMI_CALL_START_FAILED',
      message:
        'The dealership call could not be started. Ask a Client Admin to check your mobile mapping.',
      status: 502,
    }
  );
}

function describeRpcFailure(message: string | null | undefined): DescribedFailure {
  for (const [raised, described] of Object.entries(rpcFailures))
    if (message?.includes(raised)) return described;
  return {
    code: 'PROVIDER_CALL_NOT_AUTHORIZED',
    message: 'The TeleCMI call could not be authorized for this lead.',
    status: 403,
  };
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
    if (contextError || !context) {
      const described = describeRpcFailure(contextError?.message);
      return failure(described.code, described.message, requestId, described.status);
    }

    const callContext = z
      .object({
        call_id: z.uuid(),
        organization_id: z.uuid(),
        branch_id: z.uuid(),
        connection_id: z.uuid(),
        provider_key: z.literal('telecmi'),
        provider_user_id: z.string().nullable(),
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
        .select('provider_request_id,status')
        .eq('id', callContext.call_id)
        .eq('organization_id', callContext.organization_id)
        .maybeSingle();
      if (existingCall?.provider_request_id)
        return success(
          {
            call_id: callContext.call_id,
            provider_request_id: existingCall.provider_request_id,
            status: existingCall.status,
            replayed: true,
          },
          requestId,
        );
      return failure(
        'PROVIDER_CALL_REQUEST_IN_PROGRESS',
        'This TeleCMI call request is already being processed.',
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
    if (!secret) throw new Error('TELECMI_CREDENTIAL_NOT_CONFIGURED');
    const credential = await decryptJson<TelecmiCredential>(secret.encrypted_payload);
    // Which device rings is the tenant's choice, not this function's: a TeleCMI
    // app without the follow-me entitlement can only ring the logged-in client.
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('connection_config')
      .eq('id', callContext.connection_id)
      .eq('organization_id', callContext.organization_id)
      .maybeSingle();
    const connectionConfig =
      connection?.connection_config && typeof connection.connection_config === 'object'
        ? (connection.connection_config as Record<string, unknown>)
        : {};
    const started = await createTelecmiClickToCall({
      credential,
      userId: callContext.provider_user_id ?? undefined,
      customerPhone: callContext.customer_phone,
      callId: callContext.call_id,
      leadId: parsed.data.lead_id,
      callMode: parseTelecmiCallMode(connectionConfig.outbound_call_mode),
    });
    const { error: updateError } = await admin
      .from('calls')
      .update({ provider_request_id: started.providerRequestId, status: 'PENDING' })
      .eq('id', callContext.call_id)
      .eq('organization_id', callContext.organization_id)
      .eq('connection_id', callContext.connection_id)
      .is('provider_request_id', null);
    if (updateError) throw updateError;

    return success(
      {
        call_id: callContext.call_id,
        provider_request_id: started.providerRequestId,
        status: started.status,
      },
      requestId,
      201,
    );
  } catch (error) {
    if (callId)
      await serviceClient()
        .from('calls')
        .update({ status: 'FAILED', ended_at: new Date().toISOString() })
        .eq('id', callId)
        .is('provider_request_id', null);
    const described = describeCallStartFailure(error);
    return failure(described.code, described.message, requestId, described.status);
  }
});
