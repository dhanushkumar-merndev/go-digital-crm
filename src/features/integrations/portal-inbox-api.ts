import type {
  PortalEmailRule,
  PortalInboxProviderKey,
  PortalPollInterval,
} from '@/lib/providers/portal-email-parser';
import { createClient } from '@/lib/supabase/client';
import { invokeIntegrationFunction, type IntegrationScopeMode } from './integration-workspace-api';

export type PortalInboxMailboxInput =
  | { mode: 'NEW'; imapHost: string; imapPort: 993 | 143; address: string; password?: string }
  | { mode: 'SHARED'; sourceConnectionId: string };

export function connectPortalInbox(input: {
  organizationId: string;
  connectionId?: string;
  providerKey: PortalInboxProviderKey;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  defaultTeamId?: string;
  mailbox: PortalInboxMailboxInput;
  senderDomains: string[];
  pollIntervalMinutes: PortalPollInterval;
  parseRules: PortalEmailRule[];
}) {
  return invokeIntegrationFunction<{
    connection_id: string;
    status: string;
    test_queued: boolean;
  }>('integration-connect-portal-inbox', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    provider_key: input.providerKey,
    display_name: input.displayName,
    scope_mode: input.scopeMode,
    branch_ids: input.branchIds,
    default_team_id: input.defaultTeamId,
    mailbox:
      input.mailbox.mode === 'SHARED'
        ? { mode: 'SHARED', source_connection_id: input.mailbox.sourceConnectionId }
        : {
            mode: 'NEW',
            imap_host: input.mailbox.imapHost,
            imap_port: input.mailbox.imapPort,
            address: input.mailbox.address,
            password: input.mailbox.password,
          },
    sender_domains: input.senderDomains,
    poll_interval_minutes: input.pollIntervalMinutes,
    parse_rules: input.parseRules,
  });
}

export type PortalInboxMailboxOption = {
  id: string;
  provider_key: PortalInboxProviderKey;
  display_name: string;
  address: string;
};

/** Mailboxes another portal connection may share: those holding their own credential. */
export async function fetchPortalInboxMailboxes(): Promise<PortalInboxMailboxOption[]> {
  const { data, error } = await createClient()
    .from('connected_accounts')
    .select('id,provider_key,display_name,external_account_id,connection_config')
    .in('provider_key', ['justdial', 'carwale', 'cardekho', 'indiamart'])
    .eq('connection_config->>ingest_mode', 'EMAIL_INBOX')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? [])
    .filter(
      (row) =>
        row.external_account_id &&
        !(row.connection_config as { mailbox_source_connection_id?: string | null })
          ?.mailbox_source_connection_id,
    )
    .map((row) => ({
      id: row.id as string,
      provider_key: row.provider_key as PortalInboxProviderKey,
      display_name: row.display_name as string,
      address: row.external_account_id as string,
    }));
}

export type PortalInboxState = {
  poll_interval_minutes: PortalPollInterval;
  next_poll_at: string;
  last_polled_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  consecutive_failures: number;
  messages_seen: number;
  leads_created: number;
};

export async function fetchPortalInboxState(connectionId: string) {
  const { data, error } = await createClient()
    .from('portal_inbox_sync_state')
    .select(
      'poll_interval_minutes,next_poll_at,last_polled_at,last_success_at,last_error_code,consecutive_failures,messages_seen,leads_created',
    )
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error) throw error;
  return data as PortalInboxState | null;
}

export type PortalInboxMessage = {
  id: string;
  received_at: string | null;
  from_address: string | null;
  subject: string | null;
  status: 'INGESTED' | 'DUPLICATE' | 'PARSE_FAILED' | 'FAILED';
  failure_code: string | null;
  lead_id: string | null;
  created_at: string;
};

export const PORTAL_INBOX_ACTIVITY_PAGE_SIZE = 25;

export async function fetchPortalInboxActivity(connectionId: string, page: number) {
  const from = (page - 1) * PORTAL_INBOX_ACTIVITY_PAGE_SIZE;
  const { data, error, count } = await createClient()
    .from('portal_inbox_messages')
    .select('id,received_at,from_address,subject,status,failure_code,lead_id,created_at', {
      count: 'exact',
    })
    .eq('connection_id', connectionId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + PORTAL_INBOX_ACTIVITY_PAGE_SIZE - 1);
  if (error) throw error;
  return { rows: (data ?? []) as PortalInboxMessage[], total: count ?? 0 };
}

export async function requestPortalInboxSync(organizationId: string, connectionId: string) {
  const { error } = await createClient().rpc('request_portal_inbox_sync', {
    target_organization_id: organizationId,
    target_connection_id: connectionId,
  });
  if (error)
    throw new Error(
      error.message === 'PORTAL_INBOX_SYNC_RATE_LIMITED'
        ? 'A sync was just requested. Try again in a few seconds.'
        : 'The mailbox sync could not be requested.',
    );
}
