import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const dataScopeSchema = z.enum([
  'OWN_RECORDS',
  'OWN_TEAM',
  'ONE_BRANCH',
  'SELECTED_BRANCHES',
  'ALL_BRANCHES',
  'ORGANIZATION',
]);

const schema = z.object({
  mode: z.enum(['USER_ADMIN', 'CLIENT_ADMIN_BOOTSTRAP']),
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  full_name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(32).optional(),
  employee_id: z.string().trim().max(64).optional(),
  role_id: z.uuid(),
  data_scope: dataScopeSchema,
  scope_branch_id: z.uuid().nullable().optional(),
  selected_branch_ids: z.array(z.uuid()).max(100).default([]),
  team_ids: z.array(z.uuid()).max(50).default([]),
  active: z.boolean().default(true),
  mfa_required: z.boolean().default(false),
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

function validAppBase(value: string | undefined) {
  if (!value?.trim()) throw new Error('APP_BASE_URL_MISSING');
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('APP_BASE_URL_INVALID');
  return parsed.origin;
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  let invitedUserId: string | undefined;
  let actorId: string | undefined;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The user invitation is invalid.', requestId, 422);

    const client = authenticatedClient(request);
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    actorId = auth.user.id;
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
    if (prior?.action === 'tenant_user.invited' && prior.result)
      return success(prior.result, requestId);
    if (prior?.action === 'tenant_user.invite_compensation_failed')
      return failure(
        'AUTH_ORPHAN_REQUIRES_REMEDIATION',
        'A prior invitation attempt requires administrator remediation.',
        requestId,
        409,
      );

    const admin = serviceClient();
    const inviteRedirect = new URL(
      '/auth/invite',
      validAppBase(Deno.env.get('APP_BASE_URL')),
    ).toString();
    const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      parsed.data.email,
      {
        redirectTo: inviteRedirect,
        data: {
          full_name: parsed.data.full_name,
          invitation_mode: parsed.data.mode,
        },
      },
    );
    if (inviteError || !invitation.user)
      return failure(
        'USER_INVITE_FAILED',
        'The user could not be invited. Check whether the email is already registered.',
        requestId,
        409,
      );
    invitedUserId = invitation.user.id;

    const { data: result, error: provisionError } = await admin.rpc('provision_tenant_user', {
      target_actor_id: auth.user.id,
      target_user_id: invitation.user.id,
      target_email: parsed.data.email,
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
    if (provisionError) throw provisionError;
    invitedUserId = undefined;
    return success(result, requestId, 201);
  } catch {
    if (invitedUserId && actorId) {
      const admin = serviceClient();
      // A transport failure can happen after PostgreSQL committed. Recover the
      // audited result before attempting compensation so a valid profile is
      // never separated from its Auth identity.
      const { data: committed } = await admin
        .from('audit_logs')
        .select('metadata')
        .eq('actor_id', actorId)
        .eq('request_id', requestId)
        .eq('action', 'tenant_user.invited')
        .maybeSingle();
      const recovered = (committed?.metadata as { result?: unknown } | null)?.result;
      if (recovered) return success(recovered, requestId, 201);
      const { error: compensationError } = await admin.auth.admin.deleteUser(invitedUserId, false);
      if (compensationError) {
        await admin.rpc('record_tenant_user_invite_compensation_failure', {
          target_actor_id: actorId,
          target_user_id: invitedUserId,
          target_request_id: requestId,
          failure_code: 'AUTH_USER_DELETE_FAILED',
        });
        return failure(
          'AUTH_ORPHAN_REQUIRES_REMEDIATION',
          'Provisioning failed and the unused Auth invitation requires administrator remediation.',
          requestId,
          500,
        );
      }
    }
    return failure(
      'USER_PROVISION_FAILED',
      'The user could not be provisioned; no usable invitation was retained.',
      requestId,
      500,
    );
  }
});
