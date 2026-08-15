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
      'integration-test',
      'integration-assets-list',
      'integration-assets-map',
    ])
      expect(api).toContain(`'${functionName}'`);
    expect(workspace).toContain('type="password"');
    expect(workspace).toContain('autoComplete="new-password"');
    expect(workspace).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(api).not.toContain(".from('integration_credentials')");
  });

  it('wires only completed tenant admin integration routes', () => {
    expect(rolePage).toContain("role === 'client-admin' || role === 'system-administrator'");
    expect(rolePage).toContain("slug[0] === 'integrations'");
    expect(rolePage).toContain('<IntegrationWorkspace spec={spec} role={role} />');
  });
});
