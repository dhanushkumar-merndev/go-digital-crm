import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providers = readFileSync('src/components/providers/app-providers.tsx', 'utf8');
const sessionProvider = readFileSync(
  'src/components/providers/workspace-session-provider.tsx',
  'utf8',
);
const roleLayout = readFileSync('src/app/[role]/layout.tsx', 'utf8');
const header = readFileSync('src/components/shared/app-header.tsx', 'utf8');
const proxy = readFileSync('proxy.ts', 'utf8');
const login = readFileSync('src/app/login/page.tsx', 'utf8');
const mfa = readFileSync('src/features/auth/mfa-gate.tsx', 'utf8');
const loading = readFileSync('src/app/[role]/[[...slug]]/loading.tsx', 'utf8');
const roleLoading = readFileSync('src/app/[role]/loading.tsx', 'utf8');

describe('workspace bootstrap and cache-isolation performance contract', () => {
  it('uses one verified bootstrap across Proxy and the role layout', () => {
    expect(proxy).toContain('supabase.auth.getClaims()');
    expect(proxy).toContain("supabase.rpc('get_workspace_bootstrap')");
    expect(proxy).toContain('upstreamHeaders.delete(WORKSPACE_BOOTSTRAP_HEADER)');
    expect(proxy).toContain('upstreamHeaders.set(WORKSPACE_BOOTSTRAP_HEADER, encodedBootstrap)');
    expect(proxy).not.toContain('supabase.auth.getUser()');
    expect(proxy).not.toContain("supabase.rpc('get_access_context')");
    expect(roleLayout).toContain('decodeWorkspaceBootstrapHeader');
    expect(roleLayout).toContain("supabase.rpc('get_workspace_bootstrap')");
  });

  it('hydrates shell identity/capabilities without client auth and permission waterfalls', () => {
    expect(sessionProvider).toContain('organizationId');
    expect(sessionProvider).toContain('userId');
    expect(sessionProvider).toContain('scopeKey');
    expect(sessionProvider).toContain('permissions');
    expect(header).toContain('useWorkspaceSession()');
    expect(header).not.toContain('auth.getUser()');
    expect(header).not.toContain('fetchAssignedDealershipName');
  });

  it('clears in-memory CRM data whenever the authenticated subject changes', () => {
    expect(providers).toContain('onAuthStateChange');
    expect(providers).toContain('userChanged');
    expect(providers).toContain('queryClient.clear()');
    expect(login).toContain('queryClient.clear()');
  });

  it('does not warm the wrong role dashboard after login or MFA', () => {
    expect(login).not.toContain('fetchTenantDashboard');
    expect(login).not.toContain('tenantDashboardKey');
    expect(mfa).not.toContain('fetchTenantDashboard');
    expect(mfa).not.toContain('tenantDashboardKey');
  });

  it('streams a route-level fallback while dynamic Sales pages load', () => {
    expect(loading).toContain('PageSkeleton');
    expect(roleLoading).toContain('PageSkeleton');
  });
});
