import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { describeTelecmiFailure, listTelecmiAgents } from '../_shared/telecmi.ts';
import { loadTelecmiCredential } from '../_shared/telecmi-agents.ts';
import {
  availableTelecmiAgents,
  telecmiAgentManagementList,
  type TelecmiAgentReservation,
} from '../_shared/telecmi-agent-availability.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    app_id: z.coerce.number().int().positive().safe(),
    app_secret: z.string().trim().min(8).max(512).optional(),
  })
  .superRefine((input, context) => {
    if (!input.app_secret && !input.connection_id)
      context.addIssue({ code: 'custom', path: ['app_secret'], message: 'Enter the App Secret.' });
    if (
      new Set(input.branch_ids).size !== input.branch_ids.length ||
      (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1) ||
      (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length === 0) ||
      (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
    )
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Invalid branch scope.' });
  });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_PAYLOAD',
        'Enter the App ID, App Secret and a valid branch scope.',
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
        'Only a Client Admin can list agents within their assigned scope.',
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

    const observedAt = new Date().toISOString();
    const agents = await listTelecmiAgents({ app_id: input.app_id, app_secret: secret });
    const { error: reconcileError } = await admin.rpc('reconcile_telecmi_agent_removals', {
      target_organization_id: input.organization_id,
      target_external_account_id: String(input.app_id),
      target_agent_ids: agents.map((agent) => agent.agentId),
      target_actor_id: auth.user.id,
      target_observed_at: observedAt,
    });
    if (reconcileError) throw reconcileError;
    const { data: reservations, error } = await admin.rpc('get_telecmi_agent_reservations', {
      target_organization_id: input.organization_id,
      target_external_account_id: String(input.app_id),
      excluded_connection_id: input.connection_id ?? null,
    });
    if (error) throw error;
    const { data: allReservations, error: allReservationsError } = await admin.rpc(
      'get_telecmi_agent_reservations',
      {
        target_organization_id: input.organization_id,
        target_external_account_id: String(input.app_id),
        excluded_connection_id: null,
      },
    );
    if (allReservationsError) throw allReservationsError;
    // TeleCMI's response includes softphone passwords. Only the adapter's safe
    // display fields are returned, never credentials or the raw provider body.
    return success(
      {
        all_agents: telecmiAgentManagementList(
          agents,
          (allReservations ?? []) as TelecmiAgentReservation[],
          input.app_id,
        ),
        agents: availableTelecmiAgents(
          agents,
          (reservations ?? []) as TelecmiAgentReservation[],
          input.app_id,
        ),
      },
      requestId,
    );
  } catch (error) {
    const described = describeTelecmiFailure(error);
    return failure(
      described.code,
      described.code === 'TELECMI_CONNECTION_FAILED'
        ? 'The available agents could not be loaded. Try again.'
        : described.message,
      requestId,
      described.status,
    );
  }
});
