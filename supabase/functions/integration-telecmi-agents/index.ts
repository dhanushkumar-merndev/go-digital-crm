import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import {
  describeTelecmiFailure,
  getTelecmiAccountBalance,
  listTelecmiAgents,
  TelecmiError,
} from '../_shared/telecmi.ts';
import {
  getTelecmiAgentDirectory,
  loadTelecmiCredential,
  phoneDigits,
  provisionTelecmiAgentForUser,
  TelecmiAgentProvisionError,
} from '../_shared/telecmi-agents.ts';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), organization_id: z.uuid(), connection_id: z.uuid() }),
  z.object({
    action: z.literal('provision'),
    organization_id: z.uuid(),
    connection_id: z.uuid(),
    user_id: z.uuid(),
  }),
  z.object({
    action: z.literal('set_seat_limit'),
    organization_id: z.uuid(),
    connection_id: z.uuid(),
    seat_limit: z.number().int().min(1).max(1000).nullable(),
  }),
]);

type AccessContext = { destination?: string; role_key?: string; mfa_satisfied?: boolean };

// Plan status plus the CRM side of each agent. TeleCMI being unreachable must
// not blank the card, so a provider failure is reported beside the CRM data.
async function planStatus(
  admin: ReturnType<typeof serviceClient>,
  organizationId: string,
  connectionId: string,
) {
  const directory = await getTelecmiAgentDirectory(admin, organizationId, connectionId);
  const credential = await loadTelecmiCredential(admin, organizationId, connectionId);
  const [agentsResult, balanceResult] = await Promise.allSettled([
    listTelecmiAgents(credential),
    getTelecmiAccountBalance(credential),
  ]);
  const agents = agentsResult.status === 'fulfilled' ? agentsResult.value : null;
  const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
  const providerFailure = [agentsResult, balanceResult].find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  const candidateByPhone = new Map(
    directory.candidates
      .map((candidate) => [phoneDigits(candidate.phone), candidate] as const)
      .filter(([digits]) => Boolean(digits)),
  );
  const mappedPhones = new Set(
    directory.mapped_agents.map((agent) => phoneDigits(agent.phone)).filter(Boolean),
  );
  const agentPhones = new Set((agents ?? []).map((agent) => phoneDigits(agent.phone)));
  const seatsUsed = agents?.length ?? null;

  return {
    seat_limit: directory.seat_limit,
    seats_used: seatsUsed,
    seats_left:
      directory.seat_limit === null || seatsUsed === null
        ? null
        : Math.max(0, directory.seat_limit - seatsUsed),
    balance: balance?.balance ?? null,
    sms_balance: balance?.smsBalance ?? null,
    expires_at: balance?.expiresAt ?? null,
    agents: (agents ?? []).map((agent) => {
      const digits = phoneDigits(agent.phone);
      const crmUser = digits ? candidateByPhone.get(digits) : undefined;
      return {
        agent_id: agent.agentId,
        name: agent.name,
        extension: agent.extension,
        phone: digits,
        crm_user_id: crmUser?.user_id ?? null,
        crm_user_name: crmUser?.full_name ?? null,
        linked: Boolean(digits && mappedPhones.has(digits)),
      };
    }),
    // Telecallers and consultants the line covers who cannot place a CRM call
    // yet: no mapped agent for their mobile.
    users_without_agent: directory.candidates
      .filter((candidate) => {
        const digits = phoneDigits(candidate.phone);
        return !digits || !mappedPhones.has(digits);
      })
      .map((candidate) => {
        const digits = phoneDigits(candidate.phone);
        return {
          user_id: candidate.user_id,
          full_name: candidate.full_name,
          role_key: candidate.role_key,
          phone: digits,
          telecmi_agent_exists: Boolean(digits && agentPhones.has(digits)),
        };
      }),
    provider_error: providerFailure
      ? (() => {
          const described = describeTelecmiFailure(providerFailure.reason);
          return { code: described.code, message: described.message };
        })()
      : null,
  };
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The TeleCMI agent request is invalid.', requestId, 422);
    const input = parsed.data;

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const [{ data: permitted }, { data: context }] = await Promise.all([
      client.rpc('authorize_integration_connection_action', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id,
        target_permission: 'integration.manage',
      }),
      client.rpc('get_access_context'),
    ]);
    const access = context as AccessContext | null;
    // TeleCMI is Client Admin configuration everywhere else in the CRM
    // (save_telecmi_connection); the database re-checks this on every write.
    if (
      !permitted ||
      access?.destination !== 'CRM' ||
      access.mfa_satisfied !== true ||
      access.role_key !== 'client-admin'
    )
      return failure(
        'CLIENT_ADMIN_REQUIRED',
        'Only a Client Admin can manage TeleCMI agents on this line.',
        requestId,
        403,
      );

    const admin = serviceClient();
    if (input.action === 'status')
      return success(
        await planStatus(admin, input.organization_id, input.connection_id),
        requestId,
      );

    if (input.action === 'set_seat_limit') {
      const { data, error } = await admin.rpc('set_telecmi_seat_limit', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id,
        target_seat_limit: input.seat_limit,
        target_actor_id: auth.user.id,
        target_request_id: requestId,
      });
      if (error) throw error;
      return success(data, requestId);
    }

    const result = await provisionTelecmiAgentForUser(admin, {
      organizationId: input.organization_id,
      connectionId: input.connection_id,
      userId: input.user_id,
      actorId: auth.user.id,
      requestId,
    });
    return success(result, requestId, result.status === 'CREATED' ? 201 : 200);
  } catch (error) {
    if (error instanceof TelecmiAgentProvisionError)
      return failure(error.code, error.userMessage, requestId, error.status);
    if (error instanceof TelecmiError) {
      const described = describeTelecmiFailure(error);
      return failure(described.code, described.message, requestId, described.status);
    }
    return failure(
      'TELECMI_AGENT_REQUEST_FAILED',
      'The TeleCMI agent request could not be completed.',
      requestId,
      500,
    );
  }
});
