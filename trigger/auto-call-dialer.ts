// The PIOPIY adapter, its credentials and prompt recordings live in Supabase
// Edge Functions (AGENTS.md 12.4); this step only asks the dispatcher to dial.
function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

/**
 * One step of the per-minute pass: dial the next lead for every idle
 * telecaller with Auto call on. A finished call also dials straight from the
 * PIOPIY webhook, so this is the fallback that keeps the queue moving.
 */
export async function runAutoCallDialer() {
  const serviceKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(
    `${requiredEnvironment('SUPABASE_URL').replace(/\/$/, '')}/functions/v1/auto-call-dispatch`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(50_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error?.code ?? 'AUTO_CALL_DISPATCH_FAILED');
  return body.data;
}
