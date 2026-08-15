import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const schema = z.object({
  request_id: z.uuid(),
  decision: z.enum(['APPROVE', 'REJECT']),
  decision_note: z.string().trim().max(500).optional(),
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
      return failure('INVALID_PAYLOAD', 'The support decision is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data, error } = await client.rpc('decide_support_session_request', {
      target_request_id: parsed.data.request_id,
      decision: parsed.data.decision,
      decision_note: parsed.data.decision_note ?? null,
    });
    if (error)
      return failure(
        'SUPPORT_DECISION_REJECTED',
        'The support decision could not be saved.',
        requestId,
        error.code === '42501' ? 403 : 409,
      );
    return success({ decision: data }, requestId);
  } catch {
    return failure(
      'SUPPORT_DECISION_FAILED',
      'The support decision could not be saved.',
      requestId,
      500,
    );
  }
});
