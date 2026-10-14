import { z } from 'npm:zod@4';
import { decryptJson, encryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import {
  MissingProviderSecretError,
  resolveStoredProviderSecret,
} from '../_shared/stored-provider-secret.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { enqueueTriggerTask, TriggerQueueUnavailableError } from '../_shared/trigger-task.ts';
import {
  normalizeSenderDomain,
  PORTAL_MAX_KEYWORD_LENGTH,
  PORTAL_MAX_KEYWORDS_PER_RULE,
  PORTAL_MAX_SENDER_DOMAINS,
  portalCaptureModes,
  portalEmailFields,
  portalInboxProviderKeys,
} from '../../../src/lib/providers/portal-email-parser.ts';

// Justdial, CarWale, CarDekho and IndiaMART leads read from the dealership's
// own mailbox over IMAP (an app password, never the account password). This
// function only validates, encrypts and saves; the mailbox is opened by the
// Trigger.dev portal-inbox-sync task, which runs a first check right away.

type MailboxCredential = {
  imap_host: string;
  imap_port: number;
  imap_username: string;
  imap_password: string;
};

// Public mail hosts only: an admin-entered host must not be able to point the
// worker at a private network address.
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .refine((host) => !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host));

const keywordSchema = z.string().trim().min(1).max(PORTAL_MAX_KEYWORD_LENGTH);

const mailboxSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('NEW'),
    imap_host: hostSchema,
    imap_port: z.union([z.literal(993), z.literal(143)]).default(993),
    address: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    password: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(4).max(256).optional(),
    ),
  }),
  z.object({ mode: z.literal('SHARED'), source_connection_id: z.uuid() }),
]);

const schema = z
  .object({
    organization_id: z.uuid(),
    connection_id: z.uuid().optional(),
    provider_key: z.enum(portalInboxProviderKeys),
    display_name: z.string().trim().min(2).max(120),
    scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
    branch_ids: z.array(z.uuid()).max(100).default([]),
    default_team_id: z.uuid().optional(),
    mailbox: mailboxSchema,
    sender_domains: z
      .array(z.string().trim().min(3).max(254))
      .min(1)
      .max(PORTAL_MAX_SENDER_DOMAINS),
    poll_interval_minutes: z.union([z.literal(10), z.literal(20), z.literal(30)]),
    parse_rules: z
      .array(
        z.object({
          field: z.enum(portalEmailFields),
          keywords: z.array(keywordSchema).min(1).max(PORTAL_MAX_KEYWORDS_PER_RULE),
          capture: z.enum(portalCaptureModes),
        }),
      )
      .min(2)
      .max(portalEmailFields.length),
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
    if (input.sender_domains.some((value) => !normalizeSenderDomain(value)))
      context.addIssue({ code: 'custom', path: ['sender_domains'], message: 'Invalid sender.' });
    const fields = input.parse_rules.map((rule) => rule.field);
    if (new Set(fields).size !== fields.length)
      context.addIssue({ code: 'custom', path: ['parse_rules'], message: 'Duplicate field.' });
    if (!fields.includes('customer_name') || !fields.includes('phone'))
      context.addIssue({
        code: 'custom',
        path: ['parse_rules'],
        message: 'Name and mobile rules are required.',
      });
  });

const rpcErrorMessages: Record<string, [string, number]> = {
  PORTAL_INBOX_PASSWORD_REQUIRED: ['Enter the mailbox app password.', 422],
  PORTAL_INBOX_SOURCE_INVALID: ['The shared mailbox connection is not available.', 422],
  PORTAL_INBOX_SOURCE_IN_USE: [
    'Other portals share this mailbox. Keep its own mailbox, or move them first.',
    409,
  ],
  PORTAL_INBOX_CONNECTION_NOT_FOUND: ['The connection was not found.', 404],
  INVALID_PORTAL_INBOX_CONNECTION: ['The connection settings are invalid.', 422],
};

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Mailbox connection settings are invalid.', requestId, 422);
    const input = parsed.data;

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
    for (const connectionId of [
      input.connection_id,
      input.mailbox.mode === 'SHARED' ? input.mailbox.source_connection_id : undefined,
    ]) {
      if (!connectionId) continue;
      const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
        target_organization_id: input.organization_id,
        target_connection_id: connectionId,
        target_permission: 'integration.manage',
      });
      if (!permitted)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'You cannot manage this mailbox connection.',
          requestId,
          403,
        );
    }

    const admin = serviceClient();
    let mailboxAddress: string;
    let imapHost: string;
    let imapPort: number;
    let encryptedPayload: string | null = null;

    if (input.mailbox.mode === 'SHARED') {
      const { data: source, error } = await admin
        .from('connected_accounts')
        .select('external_account_id,connection_config')
        .eq('id', input.mailbox.source_connection_id)
        .eq('organization_id', input.organization_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      const sourceConfig = (source?.connection_config ?? {}) as Record<string, unknown>;
      if (!source?.external_account_id || sourceConfig.ingest_mode !== 'EMAIL_INBOX')
        return failure(
          'PORTAL_INBOX_SOURCE_INVALID',
          'The shared mailbox connection is not available.',
          requestId,
          422,
        );
      mailboxAddress = source.external_account_id;
      imapHost = String(sourceConfig.imap_host ?? '');
      imapPort = Number(sourceConfig.imap_port ?? 993);
    } else {
      mailboxAddress = input.mailbox.address;
      imapHost = input.mailbox.imap_host;
      imapPort = input.mailbox.imap_port;
      // A blank password keeps the stored one, but only for the same mailbox:
      // a different address never inherits another mailbox's password.
      let storedPassword: string | undefined;
      if (input.connection_id && !input.mailbox.password) {
        const { data: stored, error } = await admin
          .from('integration_credentials')
          .select('encrypted_payload')
          .eq('organization_id', input.organization_id)
          .eq('connected_account_id', input.connection_id)
          .maybeSingle();
        if (error) throw error;
        if (stored?.encrypted_payload) {
          const credential = await decryptJson<Partial<MailboxCredential>>(
            stored.encrypted_payload,
          );
          if (credential.imap_username === mailboxAddress)
            storedPassword = credential.imap_password;
        }
      }
      const credential: MailboxCredential = {
        imap_host: imapHost,
        imap_port: imapPort,
        imap_username: mailboxAddress,
        imap_password: resolveStoredProviderSecret(
          input.mailbox.password,
          storedPassword,
          'Mailbox app password',
        ),
      };
      encryptedPayload = await encryptJson(credential);
    }

    const senderDomains = [
      ...new Set(input.sender_domains.map((value) => normalizeSenderDomain(value) as string)),
    ];
    const { data: saved, error: saveError } = await admin.rpc('save_portal_inbox_connection', {
      target_organization_id: input.organization_id,
      target_actor_id: auth.user.id,
      target_connection_id: input.connection_id ?? null,
      target_provider_key: input.provider_key,
      target_display_name: input.display_name,
      target_scope_mode: input.scope_mode,
      target_branch_ids: input.branch_ids,
      target_default_team_id: input.default_team_id ?? null,
      target_mailbox_address: mailboxAddress,
      target_encrypted_payload: encryptedPayload,
      target_mailbox_source_connection_id:
        input.mailbox.mode === 'SHARED' ? input.mailbox.source_connection_id : null,
      target_poll_interval_minutes: input.poll_interval_minutes,
      target_connection_config: {
        connection_type: 'PORTAL_EMAIL_INBOX',
        imap_host: imapHost,
        imap_port: imapPort,
        sender_domains: senderDomains,
        parse_rules: input.parse_rules.map((rule) => ({
          field: rule.field,
          keywords: [...new Set(rule.keywords)],
          capture: rule.capture,
        })),
      },
      target_request_id: requestId,
    });
    if (saveError) {
      const known = rpcErrorMessages[saveError.message];
      if (known) return failure(saveError.message, known[0], requestId, known[1]);
      if (saveError.code === '23505')
        return failure(
          'PORTAL_INBOX_ALREADY_CONNECTED',
          'This portal is already connected to this mailbox.',
          requestId,
          409,
        );
      throw saveError;
    }
    const connectionId = (saved as { connection_id: string }).connection_id;

    // First check runs now rather than on the next schedule tick, so the admin
    // sees Connected (or the IMAP error) within a minute of saving.
    let testQueued = true;
    try {
      await enqueueTriggerTask(
        'portal-inbox-sync',
        { connectionId, organizationId: input.organization_id, mode: 'test' },
        `portal-inbox-test:${connectionId}:${requestId}`,
      );
    } catch (error) {
      if (!(error instanceof TriggerQueueUnavailableError)) throw error;
      testQueued = false;
      await admin
        .from('connected_accounts')
        .update({ last_error_code: 'PORTAL_INBOX_TEST_NOT_QUEUED' })
        .eq('id', connectionId)
        .eq('organization_id', input.organization_id);
    }

    return success(
      { connection_id: connectionId, status: 'AUTHORIZING', test_queued: testQueued },
      requestId,
      input.connection_id ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof MissingProviderSecretError)
      return failure(
        'PORTAL_INBOX_PASSWORD_REQUIRED',
        'Enter the mailbox app password.',
        requestId,
        422,
      );
    return failure(
      'PORTAL_INBOX_CONNECT_FAILED',
      'The mailbox connection could not be saved.',
      requestId,
      500,
    );
  }
});
