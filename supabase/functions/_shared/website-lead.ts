import type { serviceClient } from './supabase.ts';
import {
  parseWebsiteWidgetConfig,
  WEBSITE_PROVIDER_KEY,
  type WebsiteWidgetConfig,
} from '../../../src/lib/providers/website-lead-adapter.ts';

type AdminClient = ReturnType<typeof serviceClient>;

export type WebsiteConnection = {
  id: string;
  organization_id: string;
  scope_mode: 'ONE_BRANCH' | 'SELECTED_BRANCHES' | 'ALL_BRANCHES';
  display_name: string;
  config: WebsiteWidgetConfig;
};

type ConnectionRow = {
  id: string;
  organization_id: string;
  scope_mode: WebsiteConnection['scope_mode'];
  display_name: string;
  connection_config: Record<string, unknown> | null;
};

function toConnection(row: ConnectionRow | null): WebsiteConnection | null {
  if (!row) return null;
  const parsed = parseWebsiteWidgetConfig(row.connection_config?.widget);
  if (!parsed.ok) return null;
  return {
    id: row.id,
    organization_id: row.organization_id,
    scope_mode: row.scope_mode,
    display_name: row.display_name,
    config: parsed.value,
  };
}

const connectionColumns = 'id,organization_id,scope_mode,display_name,connection_config';

// The public key is not a secret: it only names which connection a chat belongs to.
export async function loadWebsiteConnectionByPublicKey(admin: AdminClient, publicKey: string) {
  const { data, error } = await admin
    .from('connected_accounts')
    .select(connectionColumns)
    .eq('provider_key', WEBSITE_PROVIDER_KEY)
    .eq('status', 'CONNECTED')
    .is('deleted_at', null)
    .eq('connection_config->>public_key', publicKey)
    .maybeSingle();
  if (error) throw error;
  return toConnection(data as ConnectionRow | null);
}

export async function loadWebsiteConnectionById(
  admin: AdminClient,
  organizationId: string,
  connectionId: string,
) {
  const { data, error } = await admin
    .from('connected_accounts')
    .select(connectionColumns)
    .eq('id', connectionId)
    .eq('organization_id', organizationId)
    .eq('provider_key', WEBSITE_PROVIDER_KEY)
    .eq('status', 'CONNECTED')
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return toConnection(data as ConnectionRow | null);
}

export type ScopedBranch = { id: string; name: string; code: string };

// Branches a lead from this connection may land in; ingest_provider_lead re-checks it.
export async function websiteConnectionBranches(
  admin: AdminClient,
  connection: Pick<WebsiteConnection, 'id' | 'organization_id' | 'scope_mode'>,
): Promise<ScopedBranch[]> {
  let branchIds: string[] | null = null;
  if (connection.scope_mode !== 'ALL_BRANCHES') {
    const { data, error } = await admin
      .from('integration_branch_mappings')
      .select('branch_id')
      .eq('organization_id', connection.organization_id)
      .eq('connected_account_id', connection.id)
      .eq('external_resource_type', 'CONNECTION_SCOPE')
      .is('deleted_at', null);
    if (error) throw error;
    branchIds = (data ?? []).map((row) => row.branch_id as string);
    if (branchIds.length === 0) return [];
  }
  let query = admin
    .from('branches')
    .select('id,name,code')
    .eq('organization_id', connection.organization_id)
    .eq('active', true)
    .is('deleted_at', null)
    .order('name')
    .limit(100);
  if (branchIds) query = query.in('id', branchIds);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ScopedBranch[];
}

export async function websiteModelNames(admin: AdminClient, organizationId: string) {
  const { data, error } = await admin
    .from('vehicle_models')
    .select('name')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .order('name')
    .limit(100);
  if (error) throw error;
  return [...new Set((data ?? []).map((row) => row.name as string))];
}

export function publicEdgeBaseUrl() {
  const base =
    Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL') ??
    `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1`;
  return base.replace(/\/+$/, '');
}

export function crmBaseUrl() {
  return (Deno.env.get('PUBLIC_CRM_BASE_URL') ?? Deno.env.get('APP_BASE_URL') ?? '').replace(
    /\/+$/,
    '',
  );
}

// The chat iframe is served by the CRM, so browser submits carry the CRM's
// origin. Local development serves it from localhost. Non-browser callers can
// send any Origin, so this is a cheap first filter, not the security boundary.
export function isCrmOrigin(origin: string | null) {
  if (!origin) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const base = crmBaseUrl();
  if (!base) return true;
  try {
    return new URL(base).origin === origin;
  } catch {
    return true;
  }
}

// Maps ingest errors onto stable public codes; never echoes database text.
export function websiteIngestFailure(message: string | undefined) {
  if (!message) return null;
  if (message.includes('INVALID_PROVIDER_LEAD_IDENTITY'))
    return { code: 'INVALID_LEAD', message: 'Name or phone number is invalid.', status: 422 };
  if (
    message.includes('CONNECTION_BRANCH_NOT_MAPPED') ||
    message.includes('ACTIVE_BRANCH_NOT_FOUND')
  )
    return { code: 'BRANCH_NOT_ALLOWED', message: 'That showroom is not available.', status: 422 };
  if (message.includes('ACTIVE_CONNECTION_NOT_FOUND'))
    return {
      code: 'CONNECTION_NOT_FOUND',
      message: 'This lead source is not active.',
      status: 404,
    };
  return null;
}
