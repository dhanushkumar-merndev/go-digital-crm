export async function demoJson(response) {
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`Demo API returned non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const code = payload?.code ?? payload?.error_code;
    const safeCode =
      typeof code === 'string' && /^[A-Z0-9_]+$/i.test(code) ? code : 'REQUEST_FAILED';
    throw new Error(`Demo API HTTP ${response.status}: ${safeCode}`);
  }
  return payload;
}

// Per-run, per-identity test credentials. Browser contexts remain isolated;
// every RLS request still uses the recipient's actual authenticated JWT.
export function createDemoSessionProvider({
  projectUrl,
  anonKey,
  password,
  fetcher = fetch,
  now = Date.now,
}) {
  const sessions = new Map();
  const pending = new Map();
  return async function sessionFor(roleKey) {
    if (!projectUrl || !anonKey || !password) {
      throw new Error(
        'SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and DEMO_TEST_PASSWORD are required.',
      );
    }
    const cached = sessions.get(roleKey);
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    if (pending.has(roleKey)) return pending.get(roleKey);
    const request = (async () => {
      const session = await demoJson(
        await fetcher(`${projectUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { apikey: anonKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: `${roleKey.replaceAll('_', '-')}@demo.go-digital.invalid`,
            password,
          }),
        }),
      );
      if (typeof session?.access_token !== 'string' || !session.access_token) {
        throw new Error('Demo authentication did not return an access token');
      }
      const expiresAt =
        typeof session.expires_at === 'number'
          ? session.expires_at * 1000
          : typeof session.expires_in === 'number'
            ? now() + session.expires_in * 1000
            : 0;
      sessions.set(roleKey, { token: session.access_token, expiresAt });
      return session.access_token;
    })();
    pending.set(roleKey, request);
    try {
      return await request;
    } finally {
      pending.delete(roleKey);
    }
  };
}
