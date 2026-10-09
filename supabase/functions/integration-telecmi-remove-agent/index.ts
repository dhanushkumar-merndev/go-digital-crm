import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import {
  describeTelecmiFailure,
  listTelecmiAgents,
  normalizeTelecmiPhone,
  removeTelecmiUser,
} from '../_shared/telecmi.ts';
import { loadTelecmiCredential } from '../_shared/telecmi-agents.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    request_id: z.uuid(),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    app_id: z.coerce.number().int().positive().safe(),
    app_secret: z.string().trim().min(8).max(512).optional(),
    agent_id: z.string().regex(/^\d{1,12}_\d{1,12}$/),
  })
  .superRefine((input, context) => {
    if (
      (!input.app_secret && !input.connection_id) ||
      input.agent_id.split('_')[1] !== String(input.app_id) ||
      new Set(input.branch_ids).size !== input.branch_ids.length ||
      (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0) ||
      (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1) ||
      (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length === 0)
    )
      context.addIssue({ code: 'custom', message: 'Invalid agent credentials or scope.' });
  });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  let claim: { organizationId: string; requestId: string; actorId: string } | null = null;
  let providerRemoved = false;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_PAYLOAD',
        'Select an agent from this TeleCMI app and a valid connection scope.',
        requestId,
        422,
      );
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const [{ data: permitted, error: scopeError }, { data: context, error: contextError }] =
      await Promise.all([
        client.rpc('authorize_telecmi_management_scope', {
          target_organization_id: input.organization_id,
          target_scope_mode: input.scope_mode,
          target_branch_ids: input.branch_ids,
        }),
        client.rpc('get_access_context'),
      ]);
    const access = context as {
      destination?: string;
      organization_id?: string;
      role_key?: string;
      mfa_satisfied?: boolean;
    } | null;
    if (
      scopeError ||
      contextError ||
      !permitted ||
      access?.destination !== 'CRM' ||
      access.organization_id !== input.organization_id ||
      access.role_key !== 'client-admin' ||
      access.mfa_satisfied !== true
    )
      return failure(
        'CLIENT_ADMIN_REQUIRED',
        'Only a Client Admin can remove agents within their assigned scope.',
        requestId,
        403,
      );
    const admin = serviceClient();
    if (input.connection_id) {
      const { data: allowed, error } = await client.rpc('authorize_integration_connection_action', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id,
        target_permission: 'integration.manage',
      });
      if (error || !allowed)
        return failure(
          'BRANCH_SCOPE_DENIED',
          'The selected connection is outside your scope.',
          requestId,
          403,
        );
    }
    let secret = input.app_secret;
    if (!secret && input.connection_id) {
      const stored = await loadTelecmiCredential(admin, input.organization_id, input.connection_id);
      if (stored.app_id !== input.app_id)
        return failure(
          'TELECMI_APP_SECRET_REQUIRED',
          'Enter the App Secret for the changed App ID.',
          requestId,
          422,
        );
      secret = stored.app_secret;
    }
    if (!secret)
      return failure('TELECMI_APP_SECRET_REQUIRED', 'Enter the App Secret.', requestId, 422);
    const credential = { app_id: input.app_id, app_secret: secret };
    const agents = await listTelecmiAgents(credential);
    const agent = agents.find((candidate) => candidate.agentId === input.agent_id);
    let phone: string | null = null;
    try {
      phone = normalizeTelecmiPhone(agent?.phone ?? '');
    } catch {
      /* An agent without a mobile can still occupy a seat. */
    }
    const { data: claimed, error: claimError } = await admin.rpc('begin_telecmi_agent_removal', {
      target_organization_id: input.organization_id,
      target_external_account_id: String(input.app_id),
      target_agent_id: input.agent_id,
      target_phone: phone,
      target_actor_id: auth.user.id,
      target_request_id: input.request_id,
    });
    if (claimError) throw claimError;
    const result = claimed as { claimed: boolean; status: string };
    if (!result.claimed) {
      if (result.status === 'COMPLETED')
        return success({ removed: true, agent_id: input.agent_id }, requestId);
      return failure(
        'TELECMI_REMOVAL_IN_PROGRESS',
        'This removal request is already being processed. Refresh the agent list.',
        requestId,
        409,
      );
    }
    claim = {
      organizationId: input.organization_id,
      requestId: input.request_id,
      actorId: auth.user.id,
    };
    if (agent) await removeTelecmiUser({ credential, userId: agent.agentId });
    providerRemoved = true;
    const { error: finishError } = await admin.rpc('finish_telecmi_agent_removal', {
      target_organization_id: claim.organizationId,
      target_request_id: claim.requestId,
      target_actor_id: claim.actorId,
      target_status: 'COMPLETED',
      target_error_code: null,
    });
    if (finishError) throw finishError;
    return success({ removed: true, agent_id: input.agent_id }, requestId);
  } catch (error) {
    const described = describeTelecmiFailure(error);
    if (
      claim &&
      !providerRemoved &&
      [
        'TELECMI_IP_NOT_ALLOWED',
        'TELECMI_AUTH_REJECTED',
        'TELECMI_INSUFFICIENT_BALANCE',
        'TELECMI_EXTENSION_TAKEN',
        'TELECMI_USER_LIMIT_REACHED',
      ].includes(described.code)
    ) {
      const finished = await Promise.resolve(
        serviceClient().rpc('finish_telecmi_agent_removal', {
          target_organization_id: claim.organizationId,
          target_request_id: claim.requestId,
          target_actor_id: claim.actorId,
          target_status: 'FAILED',
          target_error_code: described.code,
        }),
      ).catch(() => undefined);
      if (finished && !finished.error) claim = null;
    }
    if (providerRemoved)
      return failure(
        'TELECMI_REMOVAL_STATUS_PENDING',
        'The agent was removed from TeleCMI, but its CRM status could not be saved. Refresh the agent list.',
        requestId,
        502,
      );
    if (claim)
      return failure(
        'TELECMI_REMOVAL_OUTCOME_UNKNOWN',
        'The removal outcome could not be confirmed. This agent remains protected. Refresh the existing-agent list after two minutes to check its status.',
        requestId,
        502,
      );
    const code = error && typeof error === 'object' && 'message' in error ? error.message : null;
    if (code === 'TELECMI_AGENT_IN_USE')
      return failure(
        code,
        'This agent or mobile is already used in the CRM. Unassign it and save the connection before removing it.',
        requestId,
        409,
      );
    if (code === 'CLIENT_ADMIN_REQUIRED')
      return failure(code, 'Only a Client Admin can remove agents.', requestId, 403);
    if (code === 'REQUEST_ID_CONFLICT')
      return failure(code, 'Refresh the agent list before retrying.', requestId, 409);
    return failure(
      described.code,
      described.code === 'TELECMI_CONNECTION_FAILED'
        ? 'The agent could not be removed. Refresh the list and try again.'
        : described.message,
      requestId,
      described.status,
    );
  }
});
