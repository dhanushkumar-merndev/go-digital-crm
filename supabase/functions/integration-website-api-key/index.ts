import { z } from 'npm:zod@4';
import { randomBase64Url, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { publicEdgeBaseUrl } from '../_shared/website-lead.ts';
import { WEBSITE_PROVIDER_KEY } from '../../../src/lib/providers/website-lead-adapter.ts';

const schema = z.object({
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  name: z.string().trim().min(2).max(80),
});

const MAX_ACTIVE_KEYS = 10;
const PREFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function randomPrefix(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length]).join('');
}

// Issues a Lead API key. The plaintext is returned exactly once; only its
// SHA-256 digest is stored, so a lost key is revoked and replaced, never shown.
Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_PAYLOAD',
        'Give the key a name (2 to 80 characters).',
        requestId,
        422,
      );
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
      target_organization_id: input.organization_id,
      target_connection_id: input.connection_id,
      target_permission: 'integration.manage',
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot manage keys for this connection.',
        requestId,
        403,
      );

    const admin = serviceClient();
    const { data: connection, error: connectionError } = await admin
      .from('connected_accounts')
      .select('id')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
      .eq('provider_key', WEBSITE_PROVIDER_KEY)
      .is('deleted_at', null)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection)
      return failure(
        'CONNECTION_NOT_FOUND',
        'The website connection was not found.',
        requestId,
        404,
      );

    const { count, error: countError } = await admin
      .from('lead_api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('connected_account_id', input.connection_id)
      .is('revoked_at', null);
    if (countError) throw countError;
    if ((count ?? 0) >= MAX_ACTIVE_KEYS)
      return failure(
        'TOO_MANY_KEYS',
        `Revoke an unused key first (limit ${MAX_ACTIVE_KEYS} active keys).`,
        requestId,
        409,
      );

    const prefix = randomPrefix();
    const apiKey = `gdm_live_${prefix}_${randomBase64Url(32)}`;
    const { data: inserted, error: insertError } = await admin
      .from('lead_api_keys')
      .insert({
        organization_id: input.organization_id,
        connected_account_id: input.connection_id,
        name: input.name,
        key_prefix: prefix,
        key_hash: await sha256Base64Url(apiKey),
        created_by: auth.user.id,
      })
      .select('id,created_at')
      .single();
    if (insertError) throw insertError;

    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'integration.lead_api_key_created',
      resource_type: 'lead_api_key',
      resource_id: inserted.id,
      request_id: requestId,
      metadata: { connection_id: input.connection_id, key_prefix: prefix, name: input.name },
    });

    return success(
      {
        id: inserted.id,
        name: input.name,
        key_prefix: prefix,
        created_at: inserted.created_at,
        api_key: apiKey,
        endpoint: `${publicEdgeBaseUrl()}/lead-api`,
      },
      requestId,
      201,
    );
  } catch {
    return failure('API_KEY_CREATE_FAILED', 'Could not create the API key.', requestId, 500);
  }
});
