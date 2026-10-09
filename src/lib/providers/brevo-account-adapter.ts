export class BrevoAccountError extends Error {
  constructor(
    readonly code:
      'BREVO_AUTH_FAILED' | 'BREVO_IP_NOT_ALLOWED' | 'BREVO_RATE_LIMITED' | 'BREVO_UNAVAILABLE',
  ) {
    super(code);
  }
}

/** Read-only account check. Never persist or return the full provider response,
 * which may include the marketing automation key and SMTP account details. */
export async function verifyBrevoAccount(apiKey: string, fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await fetcher('https://api.brevo.com/v3/account', {
      headers: { 'api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new BrevoAccountError('BREVO_UNAVAILABLE');
  }
  const payload = (await response.json().catch(() => null)) as {
    email?: unknown;
    message?: unknown;
  } | null;
  if (!response.ok) {
    if (
      typeof payload?.message === 'string' &&
      /(?:unrecognised|unauthorized|unauthorised|unknown|allowed).*ip|ip.*(?:allowed|authoris|recognis)/i.test(
        payload.message,
      )
    )
      throw new BrevoAccountError('BREVO_IP_NOT_ALLOWED');
    if (response.status === 401 || response.status === 403)
      throw new BrevoAccountError('BREVO_AUTH_FAILED');
    throw new BrevoAccountError(
      response.status === 429 ? 'BREVO_RATE_LIMITED' : 'BREVO_UNAVAILABLE',
    );
  }
  if (typeof payload?.email !== 'string') throw new BrevoAccountError('BREVO_UNAVAILABLE');
  return { email: payload.email };
}
