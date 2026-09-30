import { z } from 'npm:zod@4';
import { encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120).default('Justdial Seller Leads'),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']).default('ALL_BRANCHES'),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    default_team_id: z.uuid().optional(),
    vendor_mobile: z.string().trim().min(10).max(20),
    api_key: z.string().trim().min(6).max(256),
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

  if (request.method !== 'POST') {
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  }

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return failure(
        'INVALID_PAYLOAD',
        'Justdial connection settings are invalid.',
        requestId,
        422,
      );
    }
    const input = parsed.data;

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user) {
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    }

    const { data: scopePermitted } = await client.rpc('authorize_integration_scope', {
      target_organization_id: input.organization_id,
      target_permission: 'integration.manage',
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
    });
    if (!scopePermitted) {
      return failure(
        'BRANCH_SCOPE_DENIED',
        'The connection scope exceeds your authority.',
        requestId,
        403,
      );
    }

    if (input.connection_id) {
      const { data: connectionPermitted } = await client.rpc(
        'authorize_integration_connection_action',
        {
          target_organization_id: input.organization_id,
          target_connection_id: input.connection_id,
          target_permission: 'integration.manage',
        },
      );
      if (!connectionPermitted) {
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
      }
    }

    const normalizedMobile = input.vendor_mobile.replace(/[^\d]/g, '').slice(-10);
    const providerAccountLabel = `Justdial (+91 ${normalizedMobile})`;

    const admin = serviceClient();
    let connectionId = input.connection_id;

    if (!connectionId) {
      const { data: existingSameAccount } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'justdial')
        .eq('external_account_id', normalizedMobile)
        .is('deleted_at', null)
        .maybeSingle();

      if (existingSameAccount) {
        connectionId = existingSameAccount.id;
      }
    }

    const connectionConfig = {
      vendor_mobile: normalizedMobile,
      lead_source: 'Justdial',
      auto_round_robin: true,
      default_team_id: input.default_team_id ?? null,
      account_label: providerAccountLabel,
    };

    let connection: { id: string };
    if (connectionId) {
      const { data: updated, error: updateError } = await admin
        .from('connected_accounts')
        .update({
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          external_account_id: normalizedMobile,
          connection_config: connectionConfig,
          last_tested_at: new Date().toISOString(),
          last_error_code: null,
          deleted_at: null,
        })
        .eq('id', connectionId)
        .select('id')
        .single();

      if (updateError) throw updateError;
      connection = updated;
    } else {
      const { data: inserted, error: insertError } = await admin
        .from('connected_accounts')
        .insert({
          organization_id: input.organization_id,
          provider_key: 'justdial',
          display_name: input.display_name,
          scope_mode: input.scope_mode,
          status: 'CONNECTED',
          external_account_id: normalizedMobile,
          connection_config: connectionConfig,
          created_by: auth.user.id,
          last_tested_at: new Date().toISOString(),
          last_error_code: null,
        })
        .select('id')
        .single();

      if (insertError) throw insertError;
      connection = inserted;
    }

    const encryptedPayload = await encryptJson({
      vendor_mobile: normalizedMobile,
      api_key: input.api_key.trim(),
    });

    const { error: credentialError } = await admin.from('integration_credentials').upsert(
      {
        organization_id: input.organization_id,
        connected_account_id: connection.id,
        encrypted_payload: encryptedPayload,
        key_version: 1,
        cipher_version: 'AES-256-GCM-v1',
        replaced_by: auth.user.id,
      },
      { onConflict: 'connected_account_id' },
    );
    if (credentialError) throw credentialError;

    await admin
      .from('integration_branch_mappings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('connected_account_id', connection.id)
      .is('deleted_at', null);

    if (input.scope_mode !== 'ALL_BRANCHES' && input.branch_ids.length > 0) {
      const mappings = input.branch_ids.map((branchId) => ({
        organization_id: input.organization_id,
        connected_account_id: connection.id,
        branch_id: branchId,
        external_resource_type: 'JUSTDIAL_VENDOR',
        external_resource_id: normalizedMobile,
      }));
      const { error: mappingError } = await admin
        .from('integration_branch_mappings')
        .insert(mappings);
      if (mappingError) throw mappingError;
    }

    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: input.connection_id ? 'integration.reconnected' : 'integration.connected',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: {
        provider_key: 'justdial',
        scope_mode: input.scope_mode,
        vendor_mobile: normalizedMobile,
        team_id: input.default_team_id ?? null,
      },
    });

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? 'https://yzplfphnpoksvcetwhad.supabase.co';
    const webhookUrl = `${supabaseUrl}/functions/v1/provider-webhook-justdial?connection_id=${connection.id}`;

    return success(
      {
        connection_id: connection.id,
        account_label: providerAccountLabel,
        status: 'CONNECTED',
        webhook_url: webhookUrl,
      },
      requestId,
      200,
    );
  } catch (error) {
    return failure(
      'JUSTDIAL_CONNECT_FAILED',
      'Could not establish Justdial connection.',
      requestId,
      500,
      { error: (error as Error)?.message },
    );
  }
});
