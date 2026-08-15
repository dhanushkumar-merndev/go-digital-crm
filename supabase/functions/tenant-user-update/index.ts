import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  mode: z.enum(['USER_ADMIN', 'CLIENT_ADMIN_BOOTSTRAP']),
  user_id: z.uuid(),
  expected_version: z.number().int().positive(),
  full_name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(32).optional(),
  employee_id: z.string().trim().max(64).optional(),
  role_id: z.uuid(),
  data_scope: z.enum([
    'OWN_RECORDS',
    'OWN_TEAM',
    'ONE_BRANCH',
    'SELECTED_BRANCHES',
    'ALL_BRANCHES',
    'ORGANIZATION',
  ]),
  scope_branch_id: z.uuid().nullable().optional(),
  selected_branch_ids: z.array(z.uuid()).max(100).default([]),
  team_ids: z.array(z.uuid()).max(50).default([]),
  active: z.boolean(),
  mfa_required: z.boolean(),
});

type AccessContext = {
  destination?: string;
  role_key?: string;
  mfa_satisfied?: boolean;
};

function authorizedForMode(context: AccessContext | null, mode: z.infer<typeof schema>['mode']) {
  if (!context || context.destination !== 'CRM' || context.mfa_satisfied !== true) return false;
  if (mode === 'CLIENT_ADMIN_BOOTSTRAP') return context.role_key === 'business-owner';
  return ['client-admin', 'system-administrator'].includes(context.role_key ?? '');
}

function mappedFailure(message: string | undefined, requestId: string) {
  if (message?.includes('STALE_USER_VERSION'))
    return failure(
      'STALE_USER_VERSION',
      'This user changed since it was opened. Refresh and try again.',
      requestId,
      409,
    );
  if (
    message?.includes('CEILING') ||
    message?.includes('AUTHORITY') ||
    message?.includes('ADMINISTRATION_REQUIRED') ||
    message?.includes('ROLE_DELEGATION_FORBIDDEN') ||
    message?.includes('CLIENT_ADMIN_ROLE_REQUIRED')
  )
    return failure(
      'USER_UPDATE_FORBIDDEN',
      'The requested user change exceeds your authority or data scope.',
      requestId,
      403,
    );
  if (message?.includes('TEAM_ALREADY_HAS_MANAGER'))
    return failure(
      'TEAM_ALREADY_HAS_MANAGER',
      'One of the selected teams already has a manager.',
      requestId,
      409,
    );
  return failure(
    'USER_UPDATE_FAILED',
    'The user could not be updated. Review the assignment and scope values.',
    requestId,
    422,
  );
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
      return failure('INVALID_PAYLOAD', 'The user update is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: context, error: contextError } = await client.rpc('get_access_context');
    if (contextError || !authorizedForMode(context as AccessContext | null, parsed.data.mode))
      return failure(
        'USER_ADMIN_MFA_REQUIRED',
        'An authorized administrator with MFA is required.',
        requestId,
        403,
      );

    const { data: previous } = await client.rpc('get_tenant_user_request_result', {
      target_request_id: requestId,
    });
    const prior = previous as { action?: string; result?: unknown } | null;
    if (prior?.action === 'tenant_user.updated' && prior.result)
      return success(prior.result, requestId);

    const { data: result, error } = await serviceClient().rpc('update_tenant_user_administration', {
      target_actor_id: auth.user.id,
      target_user_id: parsed.data.user_id,
      expected_version: parsed.data.expected_version,
      target_full_name: parsed.data.full_name,
      target_phone: parsed.data.phone ?? null,
      target_employee_id: parsed.data.employee_id ?? null,
      target_role_id: parsed.data.role_id,
      target_data_scope: parsed.data.data_scope,
      target_scope_branch_id: parsed.data.scope_branch_id ?? null,
      target_selected_branch_ids: parsed.data.selected_branch_ids,
      target_team_ids: parsed.data.team_ids,
      target_active: parsed.data.active,
      target_mfa_required: parsed.data.mfa_required,
      target_request_id: requestId,
      target_mode: parsed.data.mode,
    });
    if (error) {
      // Resolve an ambiguous transport result from the idempotent audit record
      // before reporting failure to the administrator.
      const { data: replayed } = await client.rpc('get_tenant_user_request_result', {
        target_request_id: requestId,
      });
      const recovered = replayed as { action?: string; result?: unknown } | null;
      if (recovered?.action === 'tenant_user.updated' && recovered.result)
        return success(recovered.result, requestId);
      return mappedFailure(error.message, requestId);
    }
    return success(result, requestId);
  } catch {
    return failure('USER_UPDATE_FAILED', 'The user could not be updated.', requestId, 500);
  }
});
