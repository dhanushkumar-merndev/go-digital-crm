import { z } from 'npm:zod@4';
import { failure, success } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

const schema = z.object({ challenge_id: z.uuid(), nonce: z.string().min(32).max(100) });
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
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return failure('INVALID_PAYLOAD', 'Mobile link challenge is invalid.', requestId, 422);
  try {
    const admin = serviceClient();
    const now = new Date().toISOString();
    const { data: challenge, error } = await admin
      .from('mobile_link_challenges')
      .update({ used_at: now })
      .eq('id', parsed.data.challenge_id)
      .eq('nonce_hash', await sha256(parsed.data.nonce))
      .is('used_at', null)
      .gt('expires_at', now)
      .select('user_id,organization_id')
      .maybeSingle();
    if (error || !challenge)
      return failure(
        'CHALLENGE_EXPIRED_OR_USED',
        'This mobile link has expired or was already used.',
        requestId,
        409,
      );
    const { data: profile } = await admin
      .from('profiles')
      .select('email,active')
      .eq('id', challenge.user_id)
      .eq('organization_id', challenge.organization_id)
      .single();
    if (!profile?.active)
      return failure('ACCOUNT_INACTIVE', 'This account is not active.', requestId, 403);
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: profile.email,
    });
    if (linkError || !link.properties.hashed_token)
      throw linkError ?? new Error('TOKEN_HASH_MISSING');
    return success(
      {
        token_hash: link.properties.hashed_token,
        verification_type: 'email',
        requires_mfa_check: true,
      },
      requestId,
    );
  } catch {
    return failure(
      'MOBILE_LINK_EXCHANGE_FAILED',
      'The mobile app could not be linked.',
      requestId,
      500,
    );
  }
});
