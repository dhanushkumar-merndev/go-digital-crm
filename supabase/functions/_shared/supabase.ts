import { createClient } from 'npm:@supabase/supabase-js@2';

export function authenticatedClient(request: Request) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) throw new Error('SERVER_CONFIGURATION_ERROR');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
  });
}

export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('SERVER_CONFIGURATION_ERROR');
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The caller's user id from a JWT verified locally against the project JWKS,
 * so the request pays no Auth server round trip (auth.getUser costs one).
 * A revoked, disabled or deleted account is still refused by the RLS-bound
 * get_access_context call each caller makes before acting.
 */
export async function verifiedUserId(
  client: ReturnType<typeof authenticatedClient>,
  request: Request,
): Promise<string | null> {
  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const { data, error } = await client.auth.getClaims(token);
  const subject = data?.claims?.sub;
  return !error && typeof subject === 'string' && UUID_PATTERN.test(subject) ? subject : null;
}
