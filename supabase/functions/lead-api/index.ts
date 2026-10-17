import { constantTimeEqual, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { consumeRateLimit } from '../_shared/rate-limit.ts';
import { serviceClient } from '../_shared/supabase.ts';
import {
  loadWebsiteConnectionById,
  websiteConnectionBranches,
  websiteIngestFailure,
} from '../_shared/website-lead.ts';
import {
  LEAD_API_KEY_PATTERN,
  parseLeadApiPayload,
} from '../../../src/lib/providers/website-lead-adapter.ts';

const MAX_BODY_BYTES = 16_000;

// Server-to-server lead intake: `Authorization: Bearer gdm_live_<prefix>_<secret>`.
// The key is looked up by its public prefix and the secret compared as a SHA-256
// digest, so the database never holds a usable key.
Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const keyMatch = LEAD_API_KEY_PATTERN.exec(bearer);
  if (!keyMatch)
    return failure(
      'INVALID_API_KEY',
      'Send a valid API key as "Authorization: Bearer <key>".',
      requestId,
      401,
    );
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
    return failure('PAYLOAD_TOO_LARGE', 'The request body is too large.', requestId, 413);

  try {
    const admin = serviceClient();
    const { data: keyRow, error: keyError } = await admin
      .from('lead_api_keys')
      .select('id,organization_id,connected_account_id,name,key_hash,revoked_at')
      .eq('key_prefix', keyMatch[1])
      .maybeSingle();
    if (keyError) throw keyError;
    const suppliedHash = await sha256Base64Url(bearer);
    if (!keyRow || keyRow.revoked_at || !constantTimeEqual(suppliedHash, keyRow.key_hash))
      return failure('INVALID_API_KEY', 'The API key is invalid or revoked.', requestId, 403);

    const limited = await consumeRateLimit(admin, {
      bucket: `lead-api:${keyRow.id}`,
      limit: 120,
      windowSeconds: 60,
    });
    if (!limited.allowed)
      return failure('RATE_LIMITED', 'Too many requests for this API key.', requestId, 429, {
        retry_after_ms: limited.retry_after_ms,
      });

    const connection = await loadWebsiteConnectionById(
      admin,
      keyRow.organization_id,
      keyRow.connected_account_id,
    );
    if (!connection || !connection.config.api_enabled)
      return failure('API_DISABLED', 'The Lead API is disabled for this key.', requestId, 403);

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES)
      return failure('PAYLOAD_TOO_LARGE', 'The request body is too large.', requestId, 413);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return failure('INVALID_JSON', 'Malformed JSON payload.', requestId, 400);
    }
    const parsed = parseLeadApiPayload(json);
    if (!parsed.ok) return failure('INVALID_PAYLOAD', parsed.error, requestId, 422);
    const lead = parsed.value;

    const branches = await websiteConnectionBranches(admin, connection);
    const branch = lead.branch_code
      ? branches.find(
          (candidate) => candidate.code.toLowerCase() === lead.branch_code!.toLowerCase(),
        )
      : branches[0];
    if (!branch)
      return failure(
        lead.branch_code ? 'BRANCH_NOT_ALLOWED' : 'NO_BRANCH_AVAILABLE',
        lead.branch_code
          ? 'branch_code is not a showroom this key can send leads to.'
          : 'This lead source has no active showroom.',
        requestId,
        lead.branch_code ? 422 : 409,
      );

    const idempotencyKey = request.headers.get('idempotency-key')?.trim().slice(0, 200);
    const externalId = lead.external_lead_id ?? idempotencyKey ?? crypto.randomUUID();

    const { data, error } = await admin.rpc('ingest_website_lead', {
      target_organization_id: connection.organization_id,
      target_connection_id: connection.id,
      target_branch_id: branch.id,
      target_external_lead_id: `api:${externalId}`,
      target_source_detail: (lead.source_detail ?? `Lead API: ${keyRow.name}`).slice(0, 255),
      target_campaign: lead.campaign ?? null,
      target_customer_name: lead.customer_name,
      target_phone: lead.phone,
      target_normalized_phone: lead.phone,
      target_email: lead.email ?? null,
      target_interested_model: lead.interested_model ?? null,
      target_requirements: lead.requirements,
      target_raw_payload: {
        channel: 'API',
        api_key_id: keyRow.id,
        answers: [
          ...(lead.city ? [{ id: 'city', question: 'City', answer: lead.city }] : []),
          ...(lead.message ? [{ id: 'message', question: 'Message', answer: lead.message }] : []),
        ],
      },
      target_request_id: requestId,
    });
    if (error) {
      const known = websiteIngestFailure(error.message);
      if (known) return failure(known.code, known.message, requestId, known.status);
      throw error;
    }
    await admin
      .from('lead_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', keyRow.id);
    const result = data as { lead_id?: string; duplicate?: boolean } | null;
    return success(
      { lead_id: result?.lead_id ?? null, duplicate: result?.duplicate === true },
      requestId,
      result?.duplicate ? 200 : 201,
    );
  } catch {
    return failure(
      'LEAD_API_FAILED',
      'The lead could not be accepted. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
