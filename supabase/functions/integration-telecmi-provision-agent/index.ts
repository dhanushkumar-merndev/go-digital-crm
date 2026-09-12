import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';
import {
  addTelecmiUser,
  describeTelecmiFailure,
  normalizeTelecmiExtension,
  normalizeTelecmiPhone,
} from '../_shared/telecmi.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    app_id: z.coerce.number().int().positive().safe(),
    app_secret: z.string().trim().min(8).max(512),
    extension: z
      .string()
      .trim()
      .regex(/^\d{3}$/),
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().min(8).max(20),
    // The Client Admin chooses the agent's softphone password so the CRM never
    // has to hand a generated credential back to a browser.
    password: z.string().min(8).max(64),
  })
  .superRefine((input, context) => {
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
    try {
      normalizeTelecmiExtension(input.extension);
      normalizeTelecmiPhone(input.phone);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'Invalid extension or mobile.',
      });
    }
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
      return failure('INVALID_PAYLOAD', 'The TeleCMI agent details are invalid.', requestId, 422);
    const input = parsed.data;

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: scopePermitted } = await client.rpc('authorize_telecmi_management_scope', {
      target_organization_id: input.organization_id,
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
    });
    if (!scopePermitted)
      return failure(
        'BRANCH_SCOPE_DENIED',
        'Provisioning a TeleCMI agent exceeds your authority.',
        requestId,
        403,
      );

    const created = await addTelecmiUser({
      credential: { app_id: input.app_id, app_secret: input.app_secret },
      extension: input.extension,
      name: input.name,
      phone: input.phone,
      password: input.password,
    });

    // Only the resulting mapping is returned; the app secret and the agent
    // password are never echoed back to the caller.
    return success(
      { user_id: created.userId, extension: created.extension, phone: created.phone },
      requestId,
      201,
    );
  } catch (error) {
    const described = describeTelecmiFailure(error);
    return failure(described.code, described.message, requestId, described.status);
  }
});
