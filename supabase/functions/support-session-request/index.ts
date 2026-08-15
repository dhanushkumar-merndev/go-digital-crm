import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  purpose: z.string().trim().min(10).max(500),
  permissions: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  duration_minutes: z.int().min(5).max(60).default(30),
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
      return failure('INVALID_PAYLOAD', 'The support request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data, error } = await client.rpc('request_support_session', {
      target_organization_id: parsed.data.organization_id,
      support_purpose: parsed.data.purpose,
      capability_keys: parsed.data.permissions,
      requested_minutes: parsed.data.duration_minutes,
    });
    if (error)
      return failure(
        'SUPPORT_REQUEST_REJECTED',
        'The support request could not be created.',
        requestId,
        error.code === '42501' ? 403 : 409,
      );
    return success({ support_request: data }, requestId, 201);
  } catch {
    return failure(
      'SUPPORT_REQUEST_FAILED',
      'The support request could not be created.',
      requestId,
      500,
    );
  }
});
