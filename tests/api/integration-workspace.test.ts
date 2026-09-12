import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isTrustedProviderAuthorizationUrl,
  parseIntegrationQuery,
  toIntegrationQueryString,
  toIntegrationSearchTerm,
} from '../../src/features/integrations/integration-workspace-query';

const api = readFileSync('src/features/integrations/integration-workspace-api.ts', 'utf8');
const workspace = readFileSync('src/features/integrations/integration-workspace.tsx', 'utf8');
const integrationTest = readFileSync('supabase/functions/integration-test/index.ts', 'utf8');
const telecmiConnect = readFileSync(
  'supabase/functions/integration-connect-telecmi/index.ts',
  'utf8',
);
const telecmiMigration = readFileSync(
  'supabase/migrations/202609030001_telecmi_ai_voice_automation.sql',
  'utf8',
);
const telecmiSaveMigration = readFileSync(
  'supabase/migrations/202609040003_telecmi_connection_atomic_save.sql',
  'utf8',
);
const telecmiShared = readFileSync('supabase/functions/_shared/telecmi.ts', 'utf8');
const telecmiProvision = readFileSync(
  'supabase/functions/integration-telecmi-provision-agent/index.ts',
  'utf8',
);
const telecmiAgentEditor = readFileSync(
  'src/features/integrations/telecmi-agent-editor.tsx',
  'utf8',
);
const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202608150014_integration_workspace.sql',
  'utf8',
);
const rolePage = readFileSync('src/app/[role]/[[...slug]]/page.tsx', 'utf8');

describe('tenant integration workspace contract', () => {
  it('normalizes server-side list state and strips PostgREST grammar', () => {
    const parsed = parseIntegrationQuery(
      new URLSearchParams(
        'page=3&pageSize=50&status=attention&sort=provider%3Aasc&q=Meta%20Dealer',
      ),
    );
    expect(parsed).toEqual({
      page: 3,
      pageSize: 50,
      status: 'attention',
      sort: 'provider:asc',
      search: 'Meta Dealer',
    });
    expect(parseIntegrationQuery(new URLSearchParams('page=-2&pageSize=500'))).toMatchObject({
      page: 1,
      pageSize: 25,
      status: 'all',
    });
    expect(toIntegrationSearchTerm('Meta),status.eq.ERROR')).toBe('Metastatus.eq.ERROR');
    expect(parseIntegrationQuery(new URLSearchParams(toIntegrationQueryString(parsed)))).toEqual(
      parsed,
    );
  });

  it('accepts only the provider OAuth origins returned by the Edge adapter', () => {
    expect(isTrustedProviderAuthorizationUrl('https://www.facebook.com/v99/dialog/oauth')).toBe(
      true,
    );
    expect(isTrustedProviderAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(
      true,
    );
    expect(
      isTrustedProviderAuthorizationUrl('https://accounts.google.com.attacker.test/auth'),
    ).toBe(false);
    expect(isTrustedProviderAuthorizationUrl('javascript:alert(1)')).toBe(false);
  });

  it('keeps tenant lists RLS-scoped, column-selective and server paginated', () => {
    expect(api).toContain(".from('connected_accounts')");
    expect(api).toContain(".from('integration_branch_mappings')");
    expect(api).toContain('.range((query.page - 1) * query.pageSize');
    expect(api).not.toContain(".select('*'");
    expect(api).toContain("['integration.view', 'integration.manage']");
    expect(api).toContain("supabase.rpc('authorize_action'");
    expect(workspace).toContain('useTenantRealtimeInvalidation');
  });

  it('aggregates indexed workspace KPIs through the authenticated RLS invoker', () => {
    expect(migration).toContain('connected_accounts_workspace_idx');
    expect(migration).toContain('provider_events_workspace_today_idx');
    expect(migration).toContain('get_integration_workspace_kpis');
    expect(migration).toContain('security invoker');
    expect(migration).toContain(
      'grant execute on function public.get_integration_workspace_kpis() to authenticated',
    );
  });

  it('uses authenticated Edge boundaries for secrets and provider asset mapping', () => {
    for (const functionName of [
      'integration-oauth-start',
      'integration-connect-whatsapp',
      'integration-connect-telecmi',
      'integration-test',
      'integration-assets-list',
      'integration-assets-map',
    ])
      expect(api).toContain(`'${functionName}'`);
    expect(workspace).toContain('type="password"');
    expect(workspace).toContain('autoComplete="new-password"');
    expect(workspace).toContain('TeleCMI IVR calling & recordings');
    expect(workspace).toContain('Ring agents in parallel');
    expect(workspace).toContain('TeleCMI CDR webhook URL');
    expect(workspace).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(api).not.toContain(".from('integration_credentials')");
    expect(integrationTest).toContain("connection.provider_key === 'telecmi'");
    expect(integrationTest).toContain('testTelecmiCredential(credential)');
  });

  it('keeps connection detail contextual, actionable and secret-free', () => {
    expect(workspace).toContain('function ConnectionDetailSheet');
    expect(workspace).toContain('Last successful sync');
    expect(workspace).toContain('Last connection test');
    expect(workspace).toContain('Map assets');
    expect(workspace).toContain('Replace credential');
    expect(workspace).toContain('onView={setDetailConnection}');
    expect(workspace).not.toContain('accessToken: connection');
    expect(workspace).not.toContain('authToken: connection');
    expect(workspace).not.toContain('appSecret: connection');
  });

  it('reserves TeleCMI and AI fallback management for Client Admins', () => {
    expect(workspace).toContain(
      '<AiVoiceAgentSettingsCard organizationId={permissions.data.organizationId} />',
    );
    expect(workspace).toContain("permissions.data.canManage && role === 'client-admin'");
    expect(workspace).toContain("provider.value !== 'telecmi' || role === 'client-admin'");
    expect(workspace).toContain(
      "canManageTelecmi={permissions.data.canManage && role === 'client-admin'}",
    );
    expect(telecmiConnect).toContain("rpc('authorize_telecmi_management_scope'");
    expect(telecmiMigration).toContain('app_private.is_client_admin(target_organization_id)');
    expect(
      telecmiMigration.match(/not app_private\.is_client_admin/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(telecmiSaveMigration).toContain("actor_role.role_key = 'client_admin'");
    expect(telecmiSaveMigration).toContain("message = 'CLIENT_ADMIN_REQUIRED'");
  });

  it('offers all-branch scope only to organization-wide admins and keeps ALL_BRANCHES unmapped', () => {
    expect(api).toContain('canUseAllBranches: boolean');
    expect(api).toContain("['ORGANIZATION', 'ALL_BRANCHES'].includes(context.data_scope ?? '')");
    expect(workspace).toContain("value !== 'ALL_BRANCHES' || canUseAllBranches");
    expect(telecmiConnect).toContain("input.scope_mode === 'ONE_BRANCH'");
    expect(telecmiConnect).toContain("input.scope_mode === 'SELECTED_BRANCHES'");
    expect(telecmiConnect).toContain("input.scope_mode === 'ALL_BRANCHES'");
    expect(telecmiConnect).toContain('input.branch_ids.length !== 0');
    expect(telecmiConnect).toContain("rpc('save_telecmi_connection'");
    expect(telecmiSaveMigration).toContain(
      "target_scope_mode = 'ALL_BRANCHES' and cardinality(normalized_branch_ids) <> 0",
    );
    expect(telecmiSaveMigration).toContain("target_scope_mode <> 'ALL_BRANCHES'");
    expect(telecmiSaveMigration).toContain("'CONNECTION_SCOPE'");
  });

  it('provisions TeleCMI agents behind the same client-admin branch scope as the connection', () => {
    expect(telecmiProvision).toContain("rpc('authorize_telecmi_management_scope'");
    expect(telecmiProvision).toContain("input.scope_mode === 'ONE_BRANCH'");
    expect(telecmiProvision).toContain("input.scope_mode === 'ALL_BRANCHES'");
    expect(telecmiProvision).toContain('BRANCH_SCOPE_DENIED');
    expect(supabaseConfig).toContain('[functions.integration-telecmi-provision-agent]');
    // The app secret and the agent's softphone password must never travel back
    // to the browser in the provisioning response.
    expect(telecmiProvision).toContain(
      '{ user_id: created.userId, extension: created.extension, phone: created.phone }',
    );
    expect(telecmiProvision).not.toContain('password: input.password,\n      requestId');
    expect(telecmiShared).toContain(
      "telecmiJson<{ agent_id?: string; msg?: string }>('/v2/user/add'",
    );
    expect(telecmiShared).toContain('`${extension}_${input.credential.app_id}`');
    expect(telecmiShared).toContain(
      "if (!/^\\d{3}$/.test(digits)) throw new Error('TELECMI_EXTENSION_INVALID')",
    );
  });

  it('reports a TeleCMI rejection reason instead of one blanket failure', () => {
    expect(telecmiShared).toContain('class TelecmiError extends Error');
    expect(telecmiShared).toContain("return 'TELECMI_IP_NOT_ALLOWED'");
    expect(telecmiShared).toContain("throw new TelecmiError('TELECMI_UNREACHABLE')");
    expect(telecmiShared).toContain("case 'TELECMI_AUTH_REJECTED'");
    expect(telecmiConnect).toContain('describeTelecmiFailure(error)');
    // The Edge envelope carries the reason, so the client must read the body of
    // a non-2xx rather than surfacing supabase-js's opaque FunctionsHttpError.
    expect(api).toContain('class IntegrationRequestError extends Error');
    expect(api).toContain('readEdgeErrorBody');
    expect(workspace).toContain('mutation.error instanceof IntegrationRequestError');
  });

  it('keeps TeleCMI agent mappings and stereo streaming editable by the client admin', () => {
    expect(workspace).toContain('<TelecmiAgentEditor');
    expect(workspace).not.toContain('name="parallelAgents"');
    expect(workspace).toContain('aiStreamEnabled: request.aiStreamEnabled');
    expect(workspace).toContain(
      'aiStreamWsUrl: aiStreamEnabled ? aiStreamWsUrl.trim() : undefined',
    );
    expect(telecmiAgentEditor).toContain('provisionTelecmiAgent');
    expect(telecmiAgentEditor).toContain('pattern="\\d{1,12}_\\d{1,12}"');
  });

  it('wires only completed tenant admin integration routes', () => {
    expect(rolePage).toContain("role === 'client-admin' || role === 'system-administrator'");
    expect(rolePage).toContain("slug[0] === 'integrations'");
    expect(rolePage).toContain('<IntegrationWorkspace spec={spec} role={role} />');
  });
});
