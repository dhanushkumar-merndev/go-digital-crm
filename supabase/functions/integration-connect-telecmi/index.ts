import { z } from 'npm:zod@4';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import {
  configureTelecmiStereoStream,
  describeTelecmiFailure,
  normalizeTelecmiPhone,
  normalizeTelecmiUserId,
  testTelecmiCredential,
  type TelecmiCredential,
} from '../_shared/telecmi.ts';

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    app_id: z.coerce.number().int().positive().safe(),
    app_secret: z.string().trim().min(8).max(512),
    default_user_id: z.string().trim().min(3).max(40),
    caller_id: z.string().trim().max(20).optional(),
    inbound_route: z.enum(['PARALLEL_USERS', 'IVR', 'TEAM']).default('PARALLEL_USERS'),
    parallel_agents: z
      .array(
        z.object({
          user_id: z.string().trim().min(3).max(40),
          phone: z.string().trim().min(8).max(20),
        }),
      )
      .min(1)
      .max(50),
    ivr_name: z.string().trim().max(120).optional(),
    team_name: z.string().trim().max(120).optional(),
    ai_stream_enabled: z.boolean().default(false),
    ai_stream_ws_url: z.url().max(2048).optional(),
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
    try {
      normalizeTelecmiUserId(input.default_user_id);
      const userIds = new Set<string>();
      const phones = new Set<string>();
      input.parallel_agents.forEach((agent) => {
        const userId = normalizeTelecmiUserId(agent.user_id);
        const phone = normalizeTelecmiPhone(agent.phone);
        if (userIds.has(userId) || phones.has(phone)) throw new Error('DUPLICATE_CALLER_MAPPING');
        userIds.add(userId);
        phones.add(phone);
      });
      if (input.caller_id) normalizeTelecmiPhone(input.caller_id);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['default_user_id'],
        message: 'Invalid TeleCMI ID.',
      });
    }
    if (input.inbound_route === 'IVR' && !input.ivr_name)
      context.addIssue({ code: 'custom', path: ['ivr_name'], message: 'IVR name is required.' });
    if (input.inbound_route === 'TEAM' && !input.team_name)
      context.addIssue({ code: 'custom', path: ['team_name'], message: 'Team name is required.' });
    if (
      input.ai_stream_enabled &&
      (!input.ai_stream_ws_url || !input.ai_stream_ws_url.startsWith('wss://'))
    )
      context.addIssue({
        code: 'custom',
        path: ['ai_stream_ws_url'],
        message: 'A secure wss:// stream URL is required.',
      });
  });

function newWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

const savedConnectionSchema = z.object({
  connection_id: z.uuid(),
  credential_version: z.number().int().positive(),
  replayed: z.boolean(),
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
      return failure('INVALID_PAYLOAD', 'TeleCMI IVR settings are invalid.', requestId, 422);
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: scopePermitted } = await client.rpc('authorize_telecmi_management_scope', {
      target_organization_id: input.organization_id,
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
      const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id,
        target_permission: 'integration.manage',
      });
      if (!permitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot replace this connection.',
          requestId,
          403,
        );
    }

    const admin = serviceClient();
    let previousCredential: TelecmiCredential | null = null;
    let previousStreamEnabled = false;
    let previousStreamUrl: string | undefined;
    if (input.connection_id) {
      const { data: existingConnection, error: connectionError } = await admin
        .from('connected_accounts')
        .select('id, connection_config')
        .eq('id', input.connection_id)
        .eq('organization_id', input.organization_id)
        .eq('provider_key', 'telecmi')
        .is('deleted_at', null)
        .maybeSingle();
      if (connectionError || !existingConnection)
        return failure(
          'TELECMI_CONNECTION_NOT_FOUND',
          'The selected TeleCMI connection no longer exists.',
          requestId,
          404,
        );
      const { data: existingSecret, error: secretError } = await admin
        .from('integration_credentials')
        .select('encrypted_payload')
        .eq('organization_id', input.organization_id)
        .eq('connected_account_id', input.connection_id)
        .maybeSingle();
      if (secretError || !existingSecret)
        throw secretError ?? new Error('TELECMI_CREDENTIAL_NOT_FOUND');
      previousCredential = await decryptJson<TelecmiCredential>(existingSecret.encrypted_payload);
      if (!previousCredential.webhook_secret?.trim())
        throw new Error('TELECMI_WEBHOOK_SECRET_MISSING');
      const previousConfig =
        existingConnection.connection_config &&
        typeof existingConnection.connection_config === 'object' &&
        !Array.isArray(existingConnection.connection_config)
          ? (existingConnection.connection_config as Record<string, unknown>)
          : {};
      previousStreamEnabled = previousConfig.ai_stream_enabled === true;
      previousStreamUrl =
        typeof previousConfig.ai_stream_ws_url === 'string'
          ? previousConfig.ai_stream_ws_url
          : undefined;
    }

    const credential: TelecmiCredential = {
      app_id: input.app_id,
      app_secret: input.app_secret,
      default_user_id: normalizeTelecmiUserId(input.default_user_id),
      caller_id: input.caller_id ? normalizeTelecmiPhone(input.caller_id) : null,
      // Replacing API credentials must not silently break the callback URLs
      // already configured in TeleCMI.
      webhook_secret: previousCredential?.webhook_secret ?? newWebhookSecret(),
    };
    await testTelecmiCredential(credential);
    const config = {
      connection_type: 'IVR_PROVIDER',
      capabilities: [
        'IVR_CALLING',
        'CALL_RECORDING',
        'INBOUND_CALL_FLOW',
        ...(input.ai_stream_enabled ? ['STEREO_AUDIO_STREAMING'] : []),
      ],
      caller_id_label: credential.caller_id,
      default_user_id: credential.default_user_id,
      inbound_route: input.inbound_route,
      parallel_agents: input.parallel_agents.map((agent) => ({
        user_id: normalizeTelecmiUserId(agent.user_id),
        phone: normalizeTelecmiPhone(agent.phone),
      })),
      ivr_name: input.ivr_name || null,
      team_name: input.team_name || null,
      ai_stream_enabled: input.ai_stream_enabled,
      ai_stream_ws_url: input.ai_stream_ws_url || null,
    };

    let providerStreamChanged = false;
    try {
      if (
        previousCredential &&
        previousStreamEnabled &&
        previousCredential.app_id !== credential.app_id
      ) {
        await configureTelecmiStereoStream({
          credential: previousCredential,
          enabled: false,
        });
        providerStreamChanged = true;
      }
      if (input.ai_stream_enabled) {
        await configureTelecmiStereoStream({
          credential,
          enabled: true,
          websocketUrl: input.ai_stream_ws_url,
        });
        providerStreamChanged = true;
      } else if (
        previousCredential &&
        previousStreamEnabled &&
        previousCredential.app_id === credential.app_id
      ) {
        await configureTelecmiStereoStream({ credential, enabled: false });
        providerStreamChanged = true;
      }

      const encryptedPayload = await encryptJson(credential);
      const { data: rawSaved, error: saveError } = await admin.rpc('save_telecmi_connection', {
        target_organization_id: input.organization_id,
        target_connection_id: input.connection_id ?? null,
        target_display_name: input.display_name,
        target_scope_mode: input.scope_mode,
        target_branch_ids: input.branch_ids,
        target_external_account_id: String(input.app_id),
        target_connection_config: config,
        target_encrypted_payload: encryptedPayload,
        target_cipher_version: 'AES-256-GCM-v1',
        target_actor_id: auth.user.id,
        target_request_id: requestId,
      });
      if (saveError) throw saveError;
      const saved = savedConnectionSchema.parse(rawSaved);
      const connectionId = saved.connection_id;

      const edgeBase = Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL')?.replace(/\/$/, '');
      if (!edgeBase) throw new Error('PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING');
      const webhookQuery = `connection_id=${connectionId}&token=${encodeURIComponent(credential.webhook_secret)}`;
      return success(
        {
          connection_id: connectionId,
          provider_key: 'telecmi',
          tested_at: new Date().toISOString(),
          webhook_url: `${edgeBase}/provider-webhook-telecmi?${webhookQuery}`,
          call_flow_url: `${edgeBase}/provider-call-flow-telecmi?${webhookQuery}`,
        },
        requestId,
        input.connection_id ? 200 : 201,
      );
    } catch (error) {
      if (providerStreamChanged) {
        try {
          if (input.ai_stream_enabled)
            await configureTelecmiStereoStream({ credential, enabled: false });
          if (previousCredential && previousStreamEnabled)
            await configureTelecmiStereoStream({
              credential: previousCredential,
              enabled: true,
              websocketUrl: previousStreamUrl,
            });
        } catch {
          // The original error is safer to return; the next connection test can
          // reconcile a provider-side streaming setting without exposing secrets.
        }
      }
      throw error;
    }
  } catch (error) {
    // A provider rejection and a storage failure are not the same problem for a
    // Client Admin, so the TeleCMI reason is reported when there is one.
    const described = describeTelecmiFailure(error);
    return failure(
      described.code,
      described.code === 'TELECMI_CONNECTION_FAILED'
        ? 'The TeleCMI IVR connection could not be tested or saved.'
        : described.message,
      requestId,
      described.status,
    );
  }
});
