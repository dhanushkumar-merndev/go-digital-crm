import { failure, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
async function sha256(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return base64Url(bytes);
}

Deno.serve(async (request) => {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: context } = await client.rpc('get_access_context');
    if (
      !context ||
      context.destination !== 'CRM' ||
      !['telecaller', 'sales-consultant'].includes(context.role_key)
    )
      return failure(
        'MOBILE_ROLE_NOT_ELIGIBLE',
        'Mobile linking is available only for Telecaller and Sales Consultant accounts.',
        requestId,
        403,
      );
    const random = crypto.getRandomValues(new Uint8Array(32));
    const nonce = base64Url(random);
    const expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    const admin = serviceClient();
    const { data: challenge, error } = await admin
      .from('mobile_link_challenges')
      .insert({
        organization_id: context.organization_id,
        user_id: auth.user.id,
        nonce_hash: await sha256(nonce),
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (error) throw error;
    const qr_payload = `godigitalcrm://link?challenge=${encodeURIComponent(challenge.id)}&nonce=${encodeURIComponent(nonce)}`;
    return success(
      { challenge_id: challenge.id, qr_payload, expires_at: expiresAt },
      requestId,
      201,
    );
  } catch {
    return failure(
      'MOBILE_LINK_CREATE_FAILED',
      'A mobile link challenge could not be created.',
      requestId,
      500,
    );
  }
});
