import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { parseIndiaMartQuery } from '../../../src/lib/providers/indiamart-adapter.ts';

const connectionIdSchema = z.uuid();

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);

  if (request.method !== 'POST') {
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  }

  const url = new URL(request.url);
  const connectionIdResult = connectionIdSchema.safeParse(url.searchParams.get('connection_id'));
  if (!connectionIdResult.success) {
    return failure(
      'INVALID_CONNECTION',
      'A valid provider connection is required.',
      requestId,
      400,
    );
  }
  const connectionId = connectionIdResult.data;

  try {
    const rawBody = await request.text();
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(rawBody);
    } catch {
      return failure('INVALID_JSON', 'Malformed JSON payload.', requestId, 400);
    }

    // Support both single query object and array of queries
    const queries = Array.isArray(bodyJson) ? bodyJson : [bodyJson];
    const admin = serviceClient();

    // Verify active connection
    const { data: connection, error: connError } = await admin
      .from('connected_accounts')
      .select('id, organization_id, provider_key, status, default_team_id')
      .eq('id', connectionId)
      .eq('provider_key', 'indiamart')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();

    if (connError) throw connError;
    if (!connection) {
      return failure(
        'CONNECTION_NOT_FOUND',
        'Active IndiaMART connection not found.',
        requestId,
        404,
      );
    }

    // Resolve branch
    const { data: branchMapping } = await admin
      .from('integration_branch_mappings')
      .select('branch_id')
      .eq('connected_account_id', connection.id)
      .limit(1)
      .maybeSingle();

    let branchId = branchMapping?.branch_id;
    if (!branchId) {
      const { data: defaultBranch } = await admin
        .from('branches')
        .select('id')
        .eq('organization_id', connection.organization_id)
        .eq('active', true)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      branchId = defaultBranch?.id;
    }

    if (!branchId) {
      return failure(
        'NO_BRANCH_AVAILABLE',
        'No active branch available for lead routing.',
        requestId,
        409,
      );
    }

    let ingestedCount = 0;
    for (const query of queries) {
      let parsed;
      try {
        parsed = parseIndiaMartQuery(query);
      } catch {
        continue;
      }

      const { error: ingestError } = await admin.rpc('ingest_provider_lead', {
        target_organization_id: connection.organization_id,
        target_connection_id: connection.id,
        target_branch_id: branchId,
        target_team_id: connection.default_team_id ?? null,
        target_external_lead_id: parsed.leadId,
        target_source: 'IndiaMART',
        target_source_detail: parsed.message
          ? `IndiaMART: ${parsed.message}`
          : 'IndiaMART Direct Query',
        target_campaign: 'IndiaMART Marketplace',
        target_customer_name: parsed.customerName,
        target_phone: parsed.phone,
        target_normalized_phone: parsed.phone,
        target_email: parsed.email ?? null,
        target_interested_model: parsed.interestedModel ?? null,
        target_raw_payload: parsed.raw,
        target_request_id: crypto.randomUUID(),
      });

      if (!ingestError) {
        ingestedCount++;
      }
    }

    return success({ accepted: true, ingested: ingestedCount }, requestId, 201);
  } catch (error) {
    return failure(
      'INDIAMART_WEBHOOK_FAILED',
      'Could not process IndiaMART webhook.',
      requestId,
      500,
    );
  }
});
