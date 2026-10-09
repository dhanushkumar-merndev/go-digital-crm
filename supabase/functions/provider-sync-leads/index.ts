import { z } from 'npm:zod@4';
import { decryptJson, sha256Base64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

// Pulls Meta Lead Ads leads that the webhook did not deliver -- an unpublished
// app receives no leadgen webhooks, and a missed delivery is never resent.
// Each lead is queued as the same META_LEADGEN receipt the webhook writes, so
// provider-event-dispatch fetches, normalizes and assigns it unchanged, and the
// (connection, leadgen:<id>) key makes webhook and sync deliveries idempotent.

const schema = z.object({
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  since_hours: z.number().int().min(1).max(720).default(168),
});

type MetaCredential = {
  graph_api_version?: string;
  asset_access_tokens?: Record<string, string>;
};

type GraphPage<T> = { data?: T[]; paging?: { next?: string } };

const MAX_FORMS_PER_PAGE = 50;
const MAX_LEAD_PAGES_PER_FORM = 5;
const MAX_LEADS_PER_SYNC = 500;

class GraphFailure extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

async function graphGet<T>(url: URL | string, token: string): Promise<GraphPage<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GraphFailure('META_GRAPH_UNREACHABLE');
  }
  const body = (await response.json().catch(() => null)) as
    (GraphPage<T> & { error?: { code?: number } }) | null;
  if (response.ok && body) return body;
  const code = body?.error?.code;
  if (code === 190) throw new GraphFailure('META_PAGE_RECONNECT_REQUIRED');
  if (code === 10 || (typeof code === 'number' && code >= 200 && code < 300))
    throw new GraphFailure('META_LEADS_PERMISSION_MISSING');
  if (code === 4 || code === 17 || code === 32 || code === 613)
    throw new GraphFailure('META_RATE_LIMITED');
  throw new GraphFailure('META_GRAPH_REQUEST_FAILED');
}

// Meta's next-page URLs embed the access token; only follow graph.facebook.com.
function nextPage(paging: GraphPage<unknown>['paging']) {
  if (!paging?.next) return null;
  const url = new URL(paging.next);
  return url.hostname === 'graph.facebook.com' ? url : null;
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  const admin = serviceClient();
  let connectionId: string | undefined;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Lead sync request is invalid.', requestId, 422);
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
      return failure('PERMISSION_DENIED', 'You cannot sync this connection.', requestId, 403);

    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key,status')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection)
      return failure('CONNECTION_NOT_FOUND', 'The connection was not found.', requestId, 404);
    if (connection.provider_key !== 'meta')
      return failure(
        'UNSUPPORTED_PROVIDER',
        'Lead sync is available for Meta only.',
        requestId,
        422,
      );
    if (connection.status !== 'CONNECTED')
      return failure('CONNECTION_NOT_ACTIVE', 'Reconnect Meta before syncing.', requestId, 409);
    connectionId = connection.id;

    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('connected_account_id', connection.id)
      .eq('organization_id', input.organization_id)
      .maybeSingle();
    if (!secret)
      return failure(
        'CREDENTIAL_NOT_CONFIGURED',
        'This provider credential has not been configured.',
        requestId,
        409,
      );
    const credential = await decryptJson<MetaCredential>(secret.encrypted_payload);
    const graphVersion = credential.graph_api_version?.trim() ?? '';
    if (!/^v\d+\.\d+$/.test(graphVersion))
      return failure(
        'META_GRAPH_API_VERSION_INVALID',
        'Replace the Meta credential.',
        requestId,
        409,
      );

    const { data: mappings, error: mappingError } = await admin
      .from('integration_branch_mappings')
      .select('external_resource_id')
      .eq('organization_id', input.organization_id)
      .eq('connected_account_id', connection.id)
      .eq('external_resource_type', 'META_PAGE')
      .is('deleted_at', null);
    if (mappingError) throw mappingError;
    const pageIds = Array.from(
      new Set((mappings ?? []).map((row) => String(row.external_resource_id))),
    );
    if (pageIds.length === 0)
      return failure(
        'META_PAGE_NOT_MAPPED',
        'Map a Facebook Page to a branch first.',
        requestId,
        409,
      );

    const sinceMs = Date.now() - input.since_hours * 3_600_000;
    const receipts: Array<Record<string, unknown>> = [];
    let formCount = 0;
    pages: for (const pageId of pageIds) {
      const token = credential.asset_access_tokens?.[pageId];
      if (!token) throw new GraphFailure('META_PAGE_RECONNECT_REQUIRED');
      const formsUrl = new URL(
        `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/leadgen_forms`,
      );
      formsUrl.search = new URLSearchParams({
        fields: 'id',
        limit: String(MAX_FORMS_PER_PAGE),
      }).toString();
      const forms = await graphGet<{ id?: string }>(formsUrl, token);
      for (const form of forms.data ?? []) {
        if (!form.id) continue;
        formCount += 1;
        let url: URL | null = new URL(
          `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(form.id)}/leads`,
        );
        url.search = new URLSearchParams({ fields: 'id,created_time', limit: '100' }).toString();
        for (let page = 0; url && page < MAX_LEAD_PAGES_PER_FORM; page += 1) {
          const leads: GraphPage<{ id?: string; created_time?: string }> = await graphGet(
            url,
            token,
          );
          let reachedWindowStart = false;
          for (const lead of leads.data ?? []) {
            const createdMs = lead.created_time ? Date.parse(lead.created_time) : NaN;
            if (!lead.id || !Number.isFinite(createdMs)) continue;
            if (createdMs < sinceMs) {
              reachedWindowStart = true;
              continue;
            }
            const event = {
              eventId: `leadgen:${lead.id}`,
              leadId: lead.id,
              pageId,
              formId: form.id,
              occurredAt: new Date(createdMs).toISOString(),
            };
            receipts.push({
              organization_id: input.organization_id,
              connected_account_id: connection.id,
              provider_event_id: event.eventId,
              event_type: 'META_LEADGEN',
              payload_hash: await sha256Base64Url(JSON.stringify(event)),
              payload: { event, origin: 'SYNC' },
              status: 'RECEIVED',
            });
            if (receipts.length >= MAX_LEADS_PER_SYNC) break pages;
          }
          url = reachedWindowStart ? null : nextPage(leads.paging);
        }
      }
    }

    let queued = 0;
    if (receipts.length > 0) {
      const { data: inserted, error } = await admin
        .from('provider_events')
        .upsert(receipts, {
          onConflict: 'organization_id,connected_account_id,provider_event_id',
          ignoreDuplicates: true,
        })
        .select('id');
      if (error) throw error;
      queued = inserted?.length ?? 0;
    }
    const now = new Date().toISOString();
    await admin
      .from('connected_accounts')
      .update({ last_sync_at: now, last_error_code: null })
      .eq('id', connection.id);
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'integration.leads_synced',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: {
        provider_key: 'meta',
        since_hours: input.since_hours,
        pages: pageIds.length,
        forms: formCount,
        found: receipts.length,
        queued,
      },
    });
    return success(
      {
        connection_id: connection.id,
        pages: pageIds.length,
        forms: formCount,
        found: receipts.length,
        queued,
        already_received: receipts.length - queued,
        truncated: receipts.length >= MAX_LEADS_PER_SYNC,
        synced_at: now,
      },
      requestId,
    );
  } catch (error) {
    const safeCode = error instanceof GraphFailure ? error.safeCode : 'META_LEAD_SYNC_FAILED';
    if (connectionId)
      await admin
        .from('connected_accounts')
        .update({ last_error_code: safeCode })
        .eq('id', connectionId);
    const messages: Record<string, string> = {
      META_PAGE_RECONNECT_REQUIRED: 'The Page access token expired. Replace the Meta credential.',
      META_LEADS_PERMISSION_MISSING:
        'The Page token lacks leads_retrieval or Page admin access. Reconnect with lead permissions.',
      META_RATE_LIMITED: 'Meta is rate limiting this Page. Try again in a few minutes.',
    };
    return failure(
      safeCode,
      messages[safeCode] ?? 'Leads could not be synced from Meta.',
      requestId,
      502,
    );
  }
});
