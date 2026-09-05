import { createClient } from '@/lib/supabase/client';
import {
  integrationSortOptions,
  toIntegrationSearchTerm,
  type IntegrationQuery,
} from './integration-workspace-query';

export type IntegrationProviderKey =
  | 'meta'
  | 'google_ads'
  | 'google_business_profile'
  | 'whatsapp_cloud'
  | 'openai'
  | 'gemini'
  | 'groq'
  | 'telecmi';
export type IntegrationScopeMode = 'ONE_BRANCH' | 'SELECTED_BRANCHES' | 'ALL_BRANCHES';

export type IntegrationRecord = {
  id: string;
  organization_id: string;
  provider_key: IntegrationProviderKey | string;
  display_name: string;
  scope_mode: IntegrationScopeMode;
  status: string;
  external_account_id: string | null;
  last_tested_at: string | null;
  last_sync_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  mapped_branch_ids: string[];
  default_inbound_branch_id: string | null;
  default_team_id: string | null;
  connection_config: {
    connection_type?: string;
    capabilities?: string[];
    default_user_id?: string;
    caller_id_label?: string | null;
    inbound_route?: 'PARALLEL_USERS' | 'IVR' | 'TEAM';
    parallel_agents?: Array<{ user_id: string; phone: string }>;
    ivr_name?: string | null;
    team_name?: string | null;
    models?: {
      text_model?: string;
      image_model?: string;
      transcription_model?: string;
      analysis_model?: string;
    };
  };
};

export type IntegrationKpis = {
  connected: number;
  healthy: number;
  attention: number;
  events_today: number;
};

export type IntegrationWorkspacePermissions = {
  organizationId: string;
  canManage: boolean;
  canUseAllBranches: boolean;
};

export type IntegrationOptions = {
  branches: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; branch_id: string; name: string }>;
};

type IntegrationMapping = {
  connected_account_id: string;
  branch_id: string;
  team_id: string | null;
  external_resource_type: string | null;
};

export async function fetchIntegrationWorkspacePermissions(): Promise<IntegrationWorkspacePermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    organization_id?: string;
    data_scope?: string;
  } | null;
  if (context?.destination !== 'CRM' || !context.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const organizationId = context.organization_id;
  const [view, manage] = await Promise.all(
    ['integration.view', 'integration.manage'].map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: organizationId,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  if (view.error) throw view.error;
  if (manage.error) throw manage.error;
  if (!view.data && !manage.data) throw new Error('INTEGRATION_VIEW_DENIED');
  return {
    organizationId,
    canManage: Boolean(manage.data),
    canUseAllBranches: ['ORGANIZATION', 'ALL_BRANCHES'].includes(context.data_scope ?? ''),
  };
}

export async function fetchIntegrationWorkspace(query: IntegrationQuery) {
  const supabase = createClient();
  const sort = integrationSortOptions[query.sort];
  let listQuery = supabase
    .from('connected_accounts')
    .select(
      'id,organization_id,provider_key,display_name,scope_mode,status,external_account_id,last_tested_at,last_sync_at,last_error_code,created_at,updated_at,default_team_id,connection_config',
      { count: 'exact' },
    )
    .is('deleted_at', null)
    .order(sort.column, { ascending: sort.ascending })
    .order('id', { ascending: sort.ascending })
    .range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1);
  if (query.status === 'connected') listQuery = listQuery.eq('status', 'CONNECTED');
  if (query.status === 'authorizing')
    listQuery = listQuery.in('status', ['PENDING', 'AUTHORIZING']);
  if (query.status === 'attention')
    listQuery = listQuery.or('status.eq.ERROR,status.eq.DISCONNECTED,last_error_code.not.is.null');
  if (query.search) {
    const term = toIntegrationSearchTerm(query.search);
    if (term)
      listQuery = listQuery.or(
        `display_name.ilike.%${term}%,provider_key.ilike.%${term}%,external_account_id.ilike.%${term}%`,
      );
  }
  const [listResponse, kpiResponse] = await Promise.all([
    listQuery,
    supabase.rpc('get_integration_workspace_kpis'),
  ]);
  if (listResponse.error) throw listResponse.error;
  if (kpiResponse.error) throw kpiResponse.error;
  const rawRecords = (listResponse.data ?? []) as Array<
    Omit<IntegrationRecord, 'mapped_branch_ids' | 'default_inbound_branch_id'>
  >;
  const ids = rawRecords.map((record) => record.id);
  let mappings: IntegrationMapping[] = [];
  if (ids.length) {
    const mappingResponse = await supabase
      .from('integration_branch_mappings')
      .select('connected_account_id,branch_id,team_id,external_resource_type')
      .in('connected_account_id', ids)
      .is('deleted_at', null);
    if (mappingResponse.error) throw mappingResponse.error;
    mappings = mappingResponse.data as IntegrationMapping[];
  }
  const rawKpis = (kpiResponse.data?.[0] ?? {}) as Partial<
    Record<keyof IntegrationKpis, string | number | null>
  >;
  return {
    records: rawRecords.map((record) => {
      const connectionMappings = mappings.filter(
        (mapping) => mapping.connected_account_id === record.id,
      );
      const inbound = connectionMappings.find(
        (mapping) => mapping.external_resource_type === 'WHATSAPP_PHONE_NUMBER',
      );
      return {
        ...record,
        mapped_branch_ids: [...new Set(connectionMappings.map((mapping) => mapping.branch_id))],
        default_inbound_branch_id: inbound?.branch_id ?? null,
        default_team_id: record.default_team_id ?? inbound?.team_id ?? null,
      };
    }),
    total: listResponse.count ?? 0,
    kpis: {
      connected: Number(rawKpis.connected ?? 0),
      healthy: Number(rawKpis.healthy ?? 0),
      attention: Number(rawKpis.attention ?? 0),
      events_today: Number(rawKpis.events_today ?? 0),
    } satisfies IntegrationKpis,
  };
}

export async function fetchIntegrationOptions(): Promise<IntegrationOptions> {
  const supabase = createClient();
  const [branches, teams] = await Promise.all([
    supabase.from('branches').select('id,name').eq('active', true).order('name'),
    supabase.from('teams').select('id,branch_id,name').eq('active', true).order('name'),
  ]);
  if (branches.error) throw branches.error;
  if (teams.error) throw teams.error;
  return {
    branches: branches.data as IntegrationOptions['branches'],
    teams: teams.data as IntegrationOptions['teams'],
  };
}

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

async function invokeIntegrationFunction<T>(name: string, body: Record<string, unknown>) {
  const { data, error } = await createClient().functions.invoke<EdgeEnvelope<T>>(name, { body });
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'INTEGRATION_REQUEST_FAILED');
  return data.data;
}

export function startOAuthConnection(input: {
  organizationId: string;
  providerKey: Exclude<IntegrationProviderKey, 'whatsapp_cloud' | 'telecmi'>;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  redirectPath: string;
}) {
  return invokeIntegrationFunction<{ authorization_url: string; connection_id: string }>(
    'integration-oauth-start',
    {
      organization_id: input.organizationId,
      provider_key: input.providerKey,
      display_name: input.displayName,
      scope_mode: input.scopeMode,
      branch_ids: input.branchIds,
      redirect_path: input.redirectPath,
    },
  );
}

export function connectWhatsApp(input: {
  organizationId: string;
  connectionId?: string;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  defaultInboundBranchId: string;
  defaultTeamId?: string;
  phoneNumberId: string;
  whatsappBusinessAccountId: string;
  accessToken: string;
}) {
  return invokeIntegrationFunction<{ connection_id: string; webhook_url: string }>(
    'integration-connect-whatsapp',
    {
      organization_id: input.organizationId,
      connection_id: input.connectionId,
      display_name: input.displayName,
      scope_mode: input.scopeMode,
      branch_ids: input.branchIds,
      default_inbound_branch_id: input.defaultInboundBranchId,
      default_team_id: input.defaultTeamId,
      phone_number_id: input.phoneNumberId,
      whatsapp_business_account_id: input.whatsappBusinessAccountId,
      access_token: input.accessToken,
    },
  );
}

export function connectTelecmi(input: {
  organizationId: string;
  connectionId?: string;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  appId: number;
  appSecret: string;
  defaultUserId: string;
  callerId?: string;
  inboundRoute: 'PARALLEL_USERS' | 'IVR' | 'TEAM';
  parallelAgents: Array<{ user_id: string; phone: string }>;
  ivrName?: string;
  teamName?: string;
  aiStreamEnabled: boolean;
  aiStreamWsUrl?: string;
}) {
  return invokeIntegrationFunction<{
    connection_id: string;
    tested_at: string;
    webhook_url: string;
    call_flow_url: string;
  }>('integration-connect-telecmi', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    display_name: input.displayName,
    scope_mode: input.scopeMode,
    branch_ids: input.branchIds,
    app_id: input.appId,
    app_secret: input.appSecret,
    default_user_id: input.defaultUserId,
    caller_id: input.callerId,
    inbound_route: input.inboundRoute,
    parallel_agents: input.parallelAgents,
    ivr_name: input.ivrName,
    team_name: input.teamName,
    ai_stream_enabled: input.aiStreamEnabled,
    ai_stream_ws_url: input.aiStreamWsUrl,
  });
}

export function connectAiProvider(input: {
  organizationId: string;
  connectionId?: string;
  providerKey: Extract<IntegrationProviderKey, 'openai' | 'gemini' | 'groq'>;
  displayName: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  textModel?: string;
  imageModel?: string;
  transcriptionModel?: string;
  analysisModel?: string;
  apiKey: string;
}) {
  return invokeIntegrationFunction<{
    connection_id: string;
    provider_key: string;
    models: { text_model?: string; image_model?: string };
    tested_at: string;
  }>('ai-provider-connect', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    provider_key: input.providerKey,
    display_name: input.displayName,
    scope_mode: input.scopeMode,
    branch_ids: input.branchIds,
    text_model: input.textModel,
    image_model: input.imageModel,
    transcription_model: input.transcriptionModel,
    analysis_model: input.analysisModel,
    api_key: input.apiKey,
  });
}

export function testIntegrationConnection(organizationId: string, connectionId: string) {
  return invokeIntegrationFunction<{ tested_at: string }>('integration-test', {
    organization_id: organizationId,
    connection_id: connectionId,
  });
}

export function testAiProviderConnection(organizationId: string, connectionId: string) {
  return invokeIntegrationFunction<{ tested_at: string }>('ai-provider-test', {
    organization_id: organizationId,
    connection_id: connectionId,
  });
}

export type ProviderAsset = {
  id: string;
  type:
    | 'META_PAGE'
    | 'INSTAGRAM_ACCOUNT'
    | 'GOOGLE_ADS_CUSTOMER'
    | 'GOOGLE_ADS_CAMPAIGN'
    | 'GOOGLE_ADS_LEAD_FORM'
    | 'GBP_LOCATION';
  label: string;
  parent_id?: string;
};

export type ProviderAssetMapping = {
  branch_id: string;
  team_id: string | null;
  external_resource_type: ProviderAsset['type'];
  external_resource_id: string;
};

export function fetchProviderAssets(
  organizationId: string,
  connectionId: string,
  parentAssetId?: string,
) {
  return invokeIntegrationFunction<{
    assets: ProviderAsset[];
    selected_mappings: ProviderAssetMapping[];
  }>('integration-assets-list', {
    organization_id: organizationId,
    connection_id: connectionId,
    parent_asset_id: parentAssetId,
  });
}

export function saveProviderAssetMappings(input: {
  organizationId: string;
  connectionId: string;
  parentAssetId?: string;
  mappings: Array<{
    asset_type: ProviderAsset['type'];
    asset_id: string;
    branch_id: string;
    team_id: string | null;
  }>;
}) {
  return invokeIntegrationFunction<{ mapped_assets: number }>('integration-assets-map', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    parent_asset_id: input.parentAssetId,
    mappings: input.mappings,
  });
}
