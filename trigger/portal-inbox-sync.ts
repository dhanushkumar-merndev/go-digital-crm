import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { idempotencyKeys, task, tasks } from '@trigger.dev/sdk';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  parsePortalEmailLeads,
  portalEmailHtmlToText,
  portalInboxProviderKeys,
  portalLeadSource,
  senderDomainOf,
  senderMatches,
  type PortalEmailRule,
  type PortalInboxProviderKey,
} from '../src/lib/providers/portal-email-parser';

// Reads Justdial / CarWale / CarDekho / IndiaMART lead emails from the
// dealership's mailbox and creates leads through ingest_provider_lead, the same
// RPC the portal webhooks use. The mailbox is opened read-only (EXAMINE), so
// polling never marks an email as read or changes the inbox in any way.

type Payload = { connectionId: string; organizationId: string; mode: 'test' | 'poll' };

type MailboxCredential = {
  imap_host: string;
  imap_port: number;
  imap_username: string;
  imap_password: string;
};

type InboxConfig = {
  ingest_mode?: string;
  mailbox_source_connection_id?: string | null;
  sender_domains?: string[];
  parse_rules?: PortalEmailRule[];
};

type SyncState = {
  uid_validity: number | null;
  last_uid: number | null;
  last_success_at: string | null;
  consecutive_failures: number;
  messages_seen: number;
  leads_created: number;
};

/** One run handles at most this many emails; the next run continues after them. */
const MAX_MESSAGES_PER_RUN = 200;
/** Lead emails are small; anything larger is an attachment-heavy email, not a lead. */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

class InboxSyncError extends Error {
  constructor(
    readonly code: string,
    readonly stopPolling = false,
  ) {
    super(code);
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function fromBase64Url(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

function parseBytea(value: string) {
  if (value.startsWith('\\x')) return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
  return fromBase64Url(value);
}

async function decryptCredential<T>(value: string): Promise<T> {
  const envelope = JSON.parse(new TextDecoder().decode(parseBytea(value))) as {
    version: string;
    iv: string;
    ciphertext: string;
  };
  if (envelope.version !== 'AES-256-GCM-v1') throw new Error('UNSUPPORTED_CIPHER_VERSION');
  const rawKey = fromBase64Url(requiredEnvironment('INTEGRATION_ENCRYPTION_KEY'));
  if (rawKey.byteLength !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function serviceClient() {
  return createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Safe, stable codes only: provider messages can echo the mailbox address. */
function classifyImapError(error: unknown): InboxSyncError {
  if (error instanceof InboxSyncError) return error;
  const candidate = error as { authenticationFailed?: boolean; code?: string } | null;
  if (candidate?.authenticationFailed) return new InboxSyncError('IMAP_AUTH_FAILED', true);
  if (
    ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'].includes(
      candidate?.code ?? '',
    )
  )
    return new InboxSyncError('IMAP_UNREACHABLE');
  return new InboxSyncError('PORTAL_INBOX_SYNC_FAILED');
}

function safeIngestCode(error: { message?: string } | null) {
  const message = error?.message ?? '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : 'INGEST_FAILED';
}

async function loadConnection(supabase: SupabaseClient, payload: Payload) {
  const { data: connection, error } = await supabase
    .from('connected_accounts')
    .select('id,organization_id,provider_key,status,connection_config,default_team_id,scope_mode')
    .eq('id', payload.connectionId)
    .eq('organization_id', payload.organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  const config = (connection?.connection_config ?? {}) as InboxConfig;
  if (
    !connection ||
    config.ingest_mode !== 'EMAIL_INBOX' ||
    !portalInboxProviderKeys.includes(connection.provider_key as PortalInboxProviderKey)
  )
    return null;
  return {
    ...(connection as {
      id: string;
      organization_id: string;
      provider_key: PortalInboxProviderKey;
      status: string;
      default_team_id: string | null;
      scope_mode: string;
    }),
    config,
  };
}

async function loadCredential(
  supabase: SupabaseClient,
  organizationId: string,
  connectionId: string,
  sourceConnectionId: string | null | undefined,
) {
  // A shared inbox reads its source connection's credential, so rotating the
  // app password once fixes every portal that reads the same mailbox.
  const credentialConnectionId = sourceConnectionId ?? connectionId;
  if (sourceConnectionId) {
    const { data: source } = await supabase
      .from('connected_accounts')
      .select('id,connection_config')
      .eq('id', sourceConnectionId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle();
    if ((source?.connection_config as InboxConfig | undefined)?.ingest_mode !== 'EMAIL_INBOX')
      throw new InboxSyncError('MAILBOX_SOURCE_DISCONNECTED', true);
  }
  const { data: secret, error } = await supabase
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', organizationId)
    .eq('connected_account_id', credentialConnectionId)
    .maybeSingle();
  if (error) throw error;
  if (!secret?.encrypted_payload) throw new InboxSyncError('MAILBOX_CREDENTIAL_MISSING', true);
  const credential = await decryptCredential<Partial<MailboxCredential>>(secret.encrypted_payload);
  if (!credential.imap_host || !credential.imap_username || !credential.imap_password)
    throw new InboxSyncError('MAILBOX_CREDENTIAL_MISSING', true);
  return credential as MailboxCredential;
}

/**
 * The chosen Telecaller team decides the branch. Without one, the webhook
 * routing applies: first mapped branch, else the organization's first active
 * branch. ingest_provider_lead still rejects a branch outside the scope.
 */
async function resolveBranch(
  supabase: SupabaseClient,
  organizationId: string,
  connectionId: string,
  teamId: string | null,
) {
  if (teamId) {
    const { data: team } = await supabase
      .from('teams')
      .select('branch_id')
      .eq('id', teamId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (team?.branch_id) return team.branch_id as string;
  }
  const { data: mapping } = await supabase
    .from('integration_branch_mappings')
    .select('branch_id')
    .eq('organization_id', organizationId)
    .eq('connected_account_id', connectionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('branch_id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (mapping?.branch_id) return mapping.branch_id as string;
  const { data: branch } = await supabase
    .from('branches')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!branch?.id) throw new InboxSyncError('NO_BRANCH_AVAILABLE', true);
  return branch.id as string;
}

type InboxCandidate = {
  uid: number;
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string | null;
  size: number;
};

async function runInboxSync(supabase: SupabaseClient, payload: Payload) {
  const connection = await loadConnection(supabase, payload);
  if (!connection) return { skipped: 'NOT_AN_EMAIL_INBOX_CONNECTION' };
  const domains = connection.config.sender_domains ?? [];
  const rules = connection.config.parse_rules ?? [];
  if (!domains.length || !rules.length)
    throw new InboxSyncError('PORTAL_INBOX_RULES_MISSING', true);

  const credential = await loadCredential(
    supabase,
    connection.organization_id,
    connection.id,
    connection.config.mailbox_source_connection_id,
  );
  const branchId = await resolveBranch(
    supabase,
    connection.organization_id,
    connection.id,
    connection.default_team_id,
  );
  const { data: stateRow, error: stateError } = await supabase
    .from('portal_inbox_sync_state')
    .select(
      'uid_validity,last_uid,last_success_at,consecutive_failures,messages_seen,leads_created',
    )
    .eq('connection_id', connection.id)
    .maybeSingle();
  if (stateError) throw stateError;
  if (!stateRow) throw new InboxSyncError('PORTAL_INBOX_NOT_CONFIGURED', true);
  const state = stateRow as SyncState;

  const client = new ImapFlow({
    host: credential.imap_host,
    port: credential.imap_port,
    secure: credential.imap_port === 993,
    auth: { user: credential.imap_username, pass: credential.imap_password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  const source = portalLeadSource[connection.provider_key];
  let leadsCreated = 0;
  let processed = 0;
  let truncated = false;
  let uidValidity: number | null = null;
  let lastUid = state.last_uid;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new InboxSyncError('PORTAL_INBOX_SYNC_FAILED');
      // The test run reads the mailbox like a poll, and ingest_provider_lead
      // accepts only a CONNECTED connection. Marking it connected once the
      // mailbox opens, not after the run, keeps the first emails from failing.
      if (payload.mode === 'test') {
        const { error: connectedError } = await supabase
          .from('connected_accounts')
          .update({ status: 'CONNECTED' })
          .eq('id', connection.id)
          .eq('organization_id', connection.organization_id);
        if (connectedError) throw connectedError;
      }
      uidValidity = Number(mailbox.uidValidity);
      const cursorValid = state.uid_validity === uidValidity && state.last_uid !== null;
      if (!cursorValid) lastUid = null;
      // IMAP SINCE has day granularity, so the window starts a day early and
      // the UID cursor / message-id log drop what was already handled.
      const sinceBase = state.last_success_at
        ? new Date(state.last_success_at).getTime()
        : Date.now() - FIRST_RUN_LOOKBACK_MS;
      const since = new Date(sinceBase - 24 * 60 * 60 * 1000);
      const fromQuery =
        domains.length === 1 ? { from: domains[0] } : { or: domains.map((from) => ({ from })) };
      const found = await client.search(
        {
          since,
          ...fromQuery,
          ...(cursorValid && lastUid !== null ? { uid: `${lastUid + 1}:*` } : {}),
        },
        { uid: true },
      );
      const uids = (Array.isArray(found) ? found : [])
        .filter((uid) => lastUid === null || uid > lastUid)
        .sort((left, right) => left - right);
      truncated = uids.length > MAX_MESSAGES_PER_RUN;
      const batch = uids.slice(0, MAX_MESSAGES_PER_RUN);

      const candidates: InboxCandidate[] = [];
      if (batch.length) {
        const headers = await client.fetchAll(
          batch.join(','),
          { uid: true, envelope: true, internalDate: true, size: true },
          { uid: true },
        );
        for (const message of headers) {
          candidates.push({
            uid: message.uid,
            messageId: (message.envelope?.messageId ?? `uid:${uidValidity}:${message.uid}`).slice(
              0,
              500,
            ),
            from: message.envelope?.from?.[0]?.address ?? '',
            subject: (message.envelope?.subject ?? '').slice(0, 300),
            receivedAt: message.internalDate ? new Date(message.internalDate).toISOString() : null,
            size: message.size ?? 0,
          });
        }
        candidates.sort((left, right) => left.uid - right.uid);
      }

      const { data: seenRows, error: seenError } = candidates.length
        ? await supabase
            .from('portal_inbox_messages')
            .select('message_id')
            .eq('connection_id', connection.id)
            .in(
              'message_id',
              candidates.map((candidate) => candidate.messageId),
            )
        : { data: [], error: null };
      if (seenError) throw seenError;
      const seen = new Set((seenRows ?? []).map((row) => row.message_id as string));

      for (const candidate of candidates) {
        lastUid = Math.max(lastUid ?? 0, candidate.uid);
        // IMAP FROM is a substring match; only the exact domain (or a
        // subdomain) is a portal email.
        if (seen.has(candidate.messageId) || !senderMatches(candidate.from, domains)) continue;
        processed += 1;
        const logRow = {
          organization_id: connection.organization_id,
          connection_id: connection.id,
          message_id: candidate.messageId,
          received_at: candidate.receivedAt,
          from_address: candidate.from.toLowerCase(),
          subject: candidate.subject || null,
        };
        if (candidate.size > MAX_MESSAGE_BYTES) {
          await logMessage(supabase, {
            ...logRow,
            status: 'FAILED',
            failure_code: 'MESSAGE_TOO_LARGE',
          });
          continue;
        }
        const fetched = await client.fetchOne(
          String(candidate.uid),
          { source: true },
          { uid: true },
        );
        if (!fetched || !fetched.source) {
          await logMessage(supabase, {
            ...logRow,
            status: 'FAILED',
            failure_code: 'MESSAGE_UNAVAILABLE',
          });
          continue;
        }
        const mail = await simpleParser(fetched.source, {
          skipImageLinks: true,
          skipTextToHtml: true,
          skipTextLinks: true,
        });
        const body = mail.html ? portalEmailHtmlToText(mail.html) : (mail.text ?? '');
        // The subject is offered as its own line so a "Subject" keyword works.
        // A digest yields one record per customer, and each becomes its own lead.
        const records = parsePortalEmailLeads(`Subject: ${candidate.subject}\n${body}`, rules);
        const usable = records.flatMap((record, position) =>
          record.ok ? [{ record, position }] : [],
        );
        if (!usable.length) {
          await logMessage(supabase, {
            ...logRow,
            status: 'PARSE_FAILED',
            failure_code: `MISSING_${records[0].missing.join('_AND_').toUpperCase()}`,
            extracted: records[0].fields,
          });
          continue;
        }
        const results: Array<{ lead_id?: string; duplicate?: boolean } | null> = [];
        let failureCode: string | null = null;
        for (const { record, position } of usable) {
          const fields = record.fields;
          const detail = [
            `${source} email`,
            candidate.subject ? candidate.subject.slice(0, 150) : null,
            fields.location ? `Location: ${fields.location}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          // The first record keeps the plain message key, so emails ingested
          // before digests were split still deduplicate against it.
          const externalId = `email:${candidate.messageId}${position ? `#${position + 1}` : ''}`;
          const { data: ingested, error: ingestError } = await supabase.rpc(
            'ingest_provider_lead',
            {
              target_organization_id: connection.organization_id,
              target_connection_id: connection.id,
              target_branch_id: branchId,
              target_team_id: connection.default_team_id,
              target_external_lead_id: externalId.slice(0, 255),
              target_source: source,
              target_source_detail: detail.slice(0, 500),
              target_campaign: fields.campaign ?? `${source} email`,
              target_customer_name: fields.customer_name,
              target_phone: fields.phone,
              target_normalized_phone: fields.phone,
              target_email: fields.email ?? null,
              target_interested_model: fields.interested_model ?? null,
              target_raw_payload: {
                channel: 'EMAIL_INBOX',
                message_id: candidate.messageId,
                record: position + 1,
                received_at: candidate.receivedAt,
                from_domain: senderDomainOf(candidate.from),
                extracted: fields,
              },
              target_request_id: crypto.randomUUID(),
            },
          );
          if (ingestError) {
            failureCode ??= safeIngestCode(ingestError);
            continue;
          }
          const result = ingested as { lead_id?: string; duplicate?: boolean } | null;
          if (!result?.duplicate) leadsCreated += 1;
          results.push(result);
        }
        await logMessage(supabase, {
          ...logRow,
          status: !results.length
            ? 'FAILED'
            : results.every((result) => result?.duplicate)
              ? 'DUPLICATE'
              : 'INGESTED',
          lead_id: results[0]?.lead_id ?? null,
          failure_code: failureCode,
          extracted:
            usable.length === 1
              ? usable[0].record.fields
              : { leads: usable.map(({ record }) => record.fields) },
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  const now = new Date().toISOString();
  const { error: updateStateError } = await supabase
    .from('portal_inbox_sync_state')
    .update({
      uid_validity: uidValidity,
      last_uid: lastUid,
      last_polled_at: now,
      last_success_at: now,
      last_error_code: null,
      consecutive_failures: 0,
      messages_seen: state.messages_seen + processed,
      leads_created: state.leads_created + leadsCreated,
      // A backlog beyond one run's cap is picked up on the next minute pass.
      ...(truncated ? { next_poll_at: now } : {}),
      updated_at: now,
    })
    .eq('connection_id', connection.id);
  if (updateStateError) throw updateStateError;
  await supabase
    .from('connected_accounts')
    .update({
      last_sync_at: now,
      last_error_code: null,
      ...(payload.mode === 'test' ? { status: 'CONNECTED', last_tested_at: now } : {}),
    })
    .eq('id', connection.id)
    .eq('organization_id', connection.organization_id);
  return { processed, leadsCreated, truncated };
}

async function logMessage(supabase: SupabaseClient, row: Record<string, unknown>) {
  const { error } = await supabase
    .from('portal_inbox_messages')
    .upsert(row, { onConflict: 'connection_id,message_id', ignoreDuplicates: true });
  if (error) throw error;
}

async function recordFailure(supabase: SupabaseClient, payload: Payload, failure: InboxSyncError) {
  const now = new Date().toISOString();
  const { data: state } = await supabase
    .from('portal_inbox_sync_state')
    .select('consecutive_failures')
    .eq('connection_id', payload.connectionId)
    .maybeSingle();
  await supabase
    .from('portal_inbox_sync_state')
    .update({
      last_polled_at: now,
      last_error_code: failure.code,
      consecutive_failures: ((state?.consecutive_failures as number | undefined) ?? 0) + 1,
      updated_at: now,
    })
    .eq('connection_id', payload.connectionId);
  // A wrong password or a removed shared mailbox will not fix itself: stop
  // polling (claims need CONNECTED) until the admin replaces the credential.
  await supabase
    .from('connected_accounts')
    .update({
      last_error_code: failure.code,
      ...(failure.stopPolling || payload.mode === 'test' ? { status: 'ERROR' } : {}),
      ...(payload.mode === 'test' ? { last_tested_at: now } : {}),
    })
    .eq('id', payload.connectionId)
    .eq('organization_id', payload.organizationId);
}

export const portalInboxSync = task({
  id: 'portal-inbox-sync',
  queue: { concurrencyLimit: 5 },
  maxDuration: 600,
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000 },
  run: async (payload: Payload) => {
    const supabase = serviceClient();
    try {
      return await runInboxSync(supabase, payload);
    } catch (error) {
      const failure = classifyImapError(error);
      await recordFailure(supabase, payload, failure);
      // Recorded on the connection; retrying an IMAP login with a known-bad
      // password only risks the provider locking the mailbox.
      if (failure.stopPolling) return { failed: failure.code };
      throw failure;
    }
  },
});

/** One step of the per-minute pass: start a run for every inbox whose interval is due. */
export async function runPortalInboxDue(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('claim_due_portal_inboxes', { target_limit: 20 });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    connection_id: string;
    organization_id: string;
    claimed_at: string;
  }>;
  for (const row of rows) {
    const idempotencyKey = await idempotencyKeys.create(
      `portal-inbox:${row.connection_id}:${row.claimed_at}`,
      { scope: 'global' },
    );
    await tasks.trigger<typeof portalInboxSync>(
      'portal-inbox-sync',
      { connectionId: row.connection_id, organizationId: row.organization_id, mode: 'poll' },
      { idempotencyKey },
    );
  }
  return { claimed: rows.length };
}
