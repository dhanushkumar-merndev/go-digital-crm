import { createClient } from '@/lib/supabase/client';
import type { WebsiteWidgetConfig } from '@/lib/providers/website-lead-adapter';
import { invokeIntegrationFunction, type IntegrationScopeMode } from '../integration-workspace-api';

export function connectWebsite(input: {
  organizationId: string;
  connectionId?: string;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  defaultTeamId?: string;
  widget: WebsiteWidgetConfig;
}) {
  return invokeIntegrationFunction<{
    connection_id: string;
    status: string;
    public_key: string;
    lead_api_url: string;
  }>('integration-connect-website', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    display_name: input.displayName,
    scope_mode: input.scopeMode,
    branch_ids: input.branchIds,
    default_team_id: input.defaultTeamId,
    widget: input.widget,
  });
}

export type LeadApiKeyRecord = {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

// key_hash is never granted to the browser; list the display columns only.
export async function fetchLeadApiKeys(connectionId: string) {
  const { data, error } = await createClient()
    .from('lead_api_keys')
    .select('id,name,key_prefix,created_at,last_used_at,revoked_at')
    .eq('connected_account_id', connectionId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as LeadApiKeyRecord[];
}

/** The returned api_key is shown once; the server keeps only its hash. */
export function createLeadApiKey(input: {
  organizationId: string;
  connectionId: string;
  name: string;
}) {
  return invokeIntegrationFunction<{
    id: string;
    name: string;
    key_prefix: string;
    created_at: string;
    api_key: string;
    endpoint: string;
  }>('integration-website-api-key', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    name: input.name,
  });
}

export async function revokeLeadApiKey(keyId: string) {
  const { error } = await createClient().rpc('revoke_lead_api_key', {
    target_key_id: keyId,
    target_request_id: crypto.randomUUID(),
  });
  if (error) throw error;
}

export function leadApiEndpoint() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '') ?? '';
  return `${base}/functions/v1/lead-api`;
}
