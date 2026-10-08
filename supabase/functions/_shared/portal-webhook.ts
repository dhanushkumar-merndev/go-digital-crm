import { constantTimeEqual, decryptJson, randomBase64Url } from './crypto.ts';
import { failure } from './http.ts';
import type { serviceClient } from './supabase.ts';

type AdminClient = ReturnType<typeof serviceClient>;

type PortalCredential = { webhook_key?: string };

export function newPortalWebhookKey() {
  return randomBase64Url(24);
}

export function withPortalWebhookKey(webhookUrl: string, webhookKey: string) {
  const url = new URL(webhookUrl);
  url.searchParams.set('key', webhookKey);
  return url.toString();
}

// Reconnecting must not rotate the key, or the URL already pasted into the provider portal dies.
export async function loadPortalWebhookKey(
  admin: AdminClient,
  organizationId: string,
  connectionId: string,
) {
  const { data, error } = await admin
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', organizationId)
    .eq('connected_account_id', connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.encrypted_payload) return undefined;
  return (await decryptJson<PortalCredential>(data.encrypted_payload)).webhook_key;
}

// Portals cannot sign requests, so the shared secret rides in the URL they are given
// (`?key=`) and `x-webhook-key` is accepted for callers that can set headers.
export async function rejectUnverifiedPortalWebhook(
  admin: AdminClient,
  request: Request,
  connection: { id: string; organization_id: string },
  requestId: string,
): Promise<Response | null> {
  const storedKey = await loadPortalWebhookKey(admin, connection.organization_id, connection.id);
  if (!storedKey)
    return failure(
      'WEBHOOK_KEY_NOT_CONFIGURED',
      'Reconnect this integration to generate its webhook URL.',
      requestId,
      409,
    );
  const suppliedKey =
    new URL(request.url).searchParams.get('key') ?? request.headers.get('x-webhook-key') ?? '';
  if (!suppliedKey || !constantTimeEqual(suppliedKey, storedKey))
    return failure('INVALID_WEBHOOK_KEY', 'The webhook key is invalid.', requestId, 403);
  return null;
}
