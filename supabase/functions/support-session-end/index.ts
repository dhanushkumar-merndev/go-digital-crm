import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const schema = z.object({
  session_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
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
      return failure('INVALID_PAYLOAD', 'The support termination is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data, error } = await client.rpc('end_support_session', {
      target_session_id: parsed.data.session_id,
      termination_reason: parsed.data.reason,
    });
    if (error)
      return failure(
        'SUPPORT_END_REJECTED',
        'The support session could not be ended.',
        requestId,
        error.code === '42501' ? 403 : 409,
      );
    return success({ support_session: data }, requestId);
  } catch {
    return failure('SUPPORT_END_FAILED', 'The support session could not be ended.', requestId, 500);
  }
});
