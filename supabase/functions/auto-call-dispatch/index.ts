import { dialNextAutoCalls } from '../_shared/auto-call.ts';
import { constantTimeEqual } from '../_shared/crypto.ts';
import { failure, requestId as getRequestId, success } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

// Service-only: the per-minute Trigger.dev pass calls this to dial the next
// lead for every idle telecaller with Auto call on. PIOPIY credentials and
// prompt recordings stay inside Edge Functions.
/**
 * The caller must hold the service role. verify_jwt is on for this function,
 * so the gateway has already checked the token's signature before this runs;
 * the role claim of a verified JWT can be read directly. A non-JWT service
 * key is matched exactly.
 */
function isServiceRole(token: string) {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (serviceKey && constantTimeEqual(token, serviceKey)) return true;
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(
      atob(
        payload
          .replaceAll('-', '+')
          .replaceAll('_', '/')
          .padEnd(Math.ceil(payload.length / 4) * 4, '='),
      ),
    ) as { role?: unknown };
    return claims.role === 'service_role';
  } catch {
    return false;
  }
}

Deno.serve(async (request) => {
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
  if (!isServiceRole(token))
    return failure('SERVICE_ROLE_REQUIRED', 'Only the dispatcher may call this.', requestId, 403);
  try {
    return success(await dialNextAutoCalls(serviceClient(), `edge:${requestId}`), requestId);
  } catch {
    return failure(
      'AUTO_CALL_DISPATCH_FAILED',
      'Auto calls could not be dispatched.',
      requestId,
      500,
    );
  }
});
