import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_name: z.string().trim().min(2).max(160),
  organization_slug: z
    .string()
    .trim()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  legal_name: z.string().trim().max(200).optional(),
  gst_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .optional(),
  owner_name: z.string().trim().min(2).max(160),
  owner_email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  let invitedUserId: string | undefined;
  let provisioned = false;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The tenant invitation is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: context } = await client.rpc('get_access_context');
    if (
      !context ||
      context.destination !== 'CRM' ||
      context.role_key !== 'super-admin' ||
      context.mfa_satisfied !== true
    )
      return failure(
        'SUPER_ADMIN_MFA_REQUIRED',
        'Super Admin MFA is required to create a tenant.',
        requestId,
        403,
      );

    const appBase = Deno.env.get('APP_BASE_URL')?.trim();
    if (!appBase) throw new Error('APP_BASE_URL_MISSING');
    const baseUrl = new URL(appBase);
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password)
      throw new Error('APP_BASE_URL_INVALID');
    const inviteRedirect = new URL('/auth/invite', baseUrl.origin).toString();
    const admin = serviceClient();
    const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      parsed.data.owner_email,
      {
        redirectTo: inviteRedirect,
        data: {
          full_name: parsed.data.owner_name,
          invited_role: 'business_owner',
          organization_slug: parsed.data.organization_slug,
        },
      },
    );
    if (inviteError || !invitation.user) {
      return failure(
        'OWNER_INVITE_FAILED',
        'The Business Owner could not be invited. Check whether the email already exists.',
        requestId,
        409,
      );
    }
    invitedUserId = invitation.user.id;
    const { data: tenant, error: provisionError } = await admin.rpc('provision_tenant_owner', {
      target_actor_id: auth.user.id,
      target_owner_user_id: invitation.user.id,
      target_owner_email: parsed.data.owner_email,
      target_owner_name: parsed.data.owner_name,
      target_organization_name: parsed.data.organization_name,
      target_organization_slug: parsed.data.organization_slug,
      target_legal_name: parsed.data.legal_name ?? null,
      target_gst_number: parsed.data.gst_number ?? null,
      target_request_id: requestId,
    });
    if (provisionError) throw provisionError;
    provisioned = true;
    return success(
      {
        organization_id: tenant.organization_id,
        owner_user_id: tenant.owner_user_id,
        status: tenant.status,
        invite_status: 'SENT',
      },
      requestId,
      201,
    );
  } catch {
    if (invitedUserId && !provisioned) {
      // This user was created in this request only. Removing the orphan makes the
      // invitation unusable when the atomic tenant transaction could not commit.
      await serviceClient()
        .auth.admin.deleteUser(invitedUserId, false)
        .catch(() => undefined);
    }
    return failure(
      'TENANT_PROVISION_FAILED',
      'The tenant could not be created; no usable invitation was retained.',
      requestId,
      500,
    );
  }
});
