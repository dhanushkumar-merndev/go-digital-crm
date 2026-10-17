import { z } from 'npm:zod@4';
import { randomBase64Url } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { crmBaseUrl, publicEdgeBaseUrl } from '../_shared/website-lead.ts';
import {
  parseWebsiteWidgetConfig,
  WEBSITE_PROVIDER_KEY,
  WEBSITE_PUBLIC_KEY_PATTERN,
  websiteEmbedSnippet,
} from '../../../src/lib/providers/website-lead-adapter.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120).default('Website chat & Lead API'),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']).default('ALL_BRANCHES'),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    default_team_id: z.uuid().optional(),
    widget: z.unknown(),
  })
  .superRefine((input, context) => {
    if (new Set(input.branch_ids).size !== input.branch_ids.length)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Duplicate branch.' });
    if (input.scope_mode === 'ONE_BRANCH' && input.branch_ids.length !== 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select one branch.' });
    if (input.scope_mode === 'SELECTED_BRANCHES' && input.branch_ids.length < 1)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Select branches.' });
    if (input.scope_mode === 'ALL_BRANCHES' && input.branch_ids.length !== 0)
      context.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Clear branches.' });
  });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Website connection settings are invalid.', requestId, 422);
    const input = parsed.data;
    const widget = parseWebsiteWidgetConfig(input.widget);
    if (!widget.ok) return failure('INVALID_WIDGET_CONFIG', widget.error, requestId, 422);

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);

    const { data: scopePermitted } = await client.rpc('authorize_integration_scope', {
      target_organization_id: input.organization_id,
      target_permission: 'integration.manage',
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
    });
    if (!scopePermitted)
      return failure(
        'BRANCH_SCOPE_DENIED',
        'The connection scope exceeds your authority.',
        requestId,
        403,
      );
    if (input.connection_id) {
      const { data: connectionPermitted } = await client.rpc(
        'authorize_integration_connection_action',
        {
          target_organization_id: input.organization_id,
          target_connection_id: input.connection_id,
          target_permission: 'integration.manage',
        },
      );
      if (!connectionPermitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot change this connection.',
          requestId,
          403,
        );
    }

    const admin = serviceClient();
    if (input.default_team_id) {
      const { data: team, error: teamError } = await admin
        .from('teams')
        .select('id,branch_id')
        .eq('id', input.default_team_id)
        .eq('organization_id', input.organization_id)
        .eq('active', true)
        .maybeSingle();
      if (teamError) throw teamError;
      if (
        !team ||
        (input.scope_mode !== 'ALL_BRANCHES' && !input.branch_ids.includes(team.branch_id))
      )
        return failure(
          'TEAM_OUT_OF_SCOPE',
          'The default team must belong to a showroom in this connection.',
          requestId,
          422,
        );
    }

    let existingConfig: Record<string, unknown> = {};
    if (input.connection_id) {
      const { data: existing, error: existingError } = await admin
        .from('connected_accounts')
        .select('connection_config')
        .eq('id', input.connection_id)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', WEBSITE_PROVIDER_KEY)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing)
        return failure(
          'CONNECTION_NOT_FOUND',
          'The website connection was not found.',
          requestId,
          404,
        );
      existingConfig = (existing.connection_config ?? {}) as Record<string, unknown>;
    }
    // Reconnecting keeps the key, so the snippet already on the dealer's site keeps working.
    const storedKey = existingConfig.public_key;
    const publicKey =
      typeof storedKey === 'string' && WEBSITE_PUBLIC_KEY_PATTERN.test(storedKey)
        ? storedKey
        : `wpk_${randomBase64Url(24)}`;
    const connectionConfig = {
      public_key: publicKey,
      lead_source: 'Website',
      default_team_id: input.default_team_id ?? null,
      widget: widget.value,
    };

    let connectionId: string;
    if (input.connection_id) {
      const { error: updateError } = await admin
        .from('connected_accounts')
        .update({
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          connection_config: connectionConfig,
          default_team_id: input.default_team_id ?? null,
          last_tested_at: new Date().toISOString(),
          last_error_code: null,
          deleted_at: null,
        })
        .eq('id', input.connection_id);
      if (updateError) throw updateError;
      connectionId = input.connection_id;
    } else {
      const { data: inserted, error: insertError } = await admin
        .from('connected_accounts')
        .insert({
          organization_id: input.organization_id,
          provider_key: WEBSITE_PROVIDER_KEY,
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          external_account_id: publicKey,
          connection_config: connectionConfig,
          default_team_id: input.default_team_id ?? null,
          created_by: auth.user.id,
          last_tested_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (insertError) throw insertError;
      connectionId = inserted.id;
    }

    const { error: clearError } = await admin
      .from('integration_branch_mappings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('organization_id', input.organization_id)
      .eq('connected_account_id', connectionId)
      .eq('external_resource_type', 'CONNECTION_SCOPE')
      .is('deleted_at', null);
    if (clearError) throw clearError;
    if (input.scope_mode !== 'ALL_BRANCHES') {
      const { error: mappingError } = await admin.from('integration_branch_mappings').upsert(
        input.branch_ids.map((branchId) => ({
          organization_id: input.organization_id,
          connected_account_id: connectionId,
          branch_id: branchId,
          external_resource_type: 'CONNECTION_SCOPE',
          external_resource_id: branchId,
          deleted_at: null,
        })),
        {
          onConflict: 'connected_account_id,branch_id,external_resource_type,external_resource_id',
        },
      );
      if (mappingError) throw mappingError;
    }

    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: input.connection_id ? 'integration.reconnected' : 'integration.connected',
      resource_type: 'connected_account',
      resource_id: connectionId,
      request_id: requestId,
      metadata: {
        provider_key: WEBSITE_PROVIDER_KEY,
        scope_mode: input.scope_mode,
        widget_enabled: widget.value.widget_enabled,
        api_enabled: widget.value.api_enabled,
        question_count: widget.value.questions.length,
        allowed_origins: widget.value.allowed_origins,
      },
    });

    const crmBase = crmBaseUrl();
    return success(
      {
        connection_id: connectionId,
        status: 'CONNECTED',
        public_key: publicKey,
        embed_snippet: crmBase ? websiteEmbedSnippet(crmBase, publicKey) : null,
        lead_api_url: `${publicEdgeBaseUrl()}/lead-api`,
      },
      requestId,
    );
  } catch {
    return failure(
      'WEBSITE_CONNECT_FAILED',
      'Could not save the website connection.',
      requestId,
      500,
    );
  }
});
