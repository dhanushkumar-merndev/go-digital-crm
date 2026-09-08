import { authenticatedClient } from './supabase.ts';

export async function personalWhatsAppActor(request: Request) {
  const client = authenticatedClient(request);
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) throw new Error('UNAUTHENTICATED');
  const { data: context, error } = await client.rpc('get_access_context');
  if (
    error ||
    context?.destination !== 'CRM' ||
    !['telecaller', 'sales-consultant'].includes(context.role_key)
  ) {
    throw new Error('PERSONAL_WHATSAPP_ROLE_REQUIRED');
  }
  return { client, userId: auth.user.id, organizationId: context.organization_id as string };
}

export async function personalGateway(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  data: unknown = {},
  timeoutMs = 25_000,
) {
  const base = Deno.env.get('PERSONAL_WHATSAPP_GATEWAY_URL');
  const secret = Deno.env.get('PERSONAL_WHATSAPP_SIGNING_SECRET');
  if (!base || !secret || secret.length < 32) throw new Error('PERSONAL_WHATSAPP_NOT_CONFIGURED');
  const url = new URL(base);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('PERSONAL_WHATSAPP_NOT_CONFIGURED');
  }
  url.pathname = path;
  const body = JSON.stringify(data);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode([method, path, timestamp, nonce, body].join('\n')),
  );
  const response = await fetch(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'content-type': 'application/json',
      'x-gateway-timestamp': timestamp,
      'x-gateway-nonce': nonce,
      'x-gateway-signature': Array.from(new Uint8Array(signature), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join(''),
    },
    body: method === 'GET' ? undefined : body,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result?.error === 'string' && /^PERSONAL_WHATSAPP_[A-Z_]+$/.test(result.error)
        ? result.error
        : 'PERSONAL_WHATSAPP_GATEWAY_UNAVAILABLE',
    );
  return result;
}

export async function checkPersonalGateway() {
  try {
    const result = await personalGateway('GET', '/health', {}, 4000);
    if (result?.ok !== true) throw new Error('UNHEALTHY');
  } catch {
    throw new Error('PERSONAL_WHATSAPP_GATEWAY_UNAVAILABLE');
  }
}

export function personalError(error: unknown) {
  const message = error instanceof Error ? error.message : (error as { message?: string })?.message;
  return message &&
    /^(PERSONAL_WHATSAPP_[A-Z_]+|UNAUTHENTICATED|IDEMPOTENCY_PAYLOAD_MISMATCH|LEAD_CONTEXT_CHANGED)$/.test(
      message,
    )
    ? message
    : 'PERSONAL_WHATSAPP_REQUEST_FAILED';
}
