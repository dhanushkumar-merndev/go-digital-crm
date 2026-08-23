import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source(
  'supabase/migrations/202608220038_tenant_module_entitlements_workspace.sql',
);
const api = source('src/features/administration/tenant-module-entitlements-api.ts');
const workspace = source('src/features/administration/tenant-module-entitlements-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('tenant module entitlements workspace contract', () => {
  it('is a tenant-only, organization-wide read boundary with no entitlement mutation', () => {
    expect(migration).toContain('get_tenant_module_entitlements_workspace()');
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'user.manage')",
    );
    expect(migration).toContain('app_private.has_organization_wide_scope(current_organization_id)');
    expect(migration).toContain('MODULE_ENTITLEMENT_VIEW_PERMISSION_REQUIRED');
    expect(migration).not.toMatch(
      /\b(?:insert|update|delete)\s+public\.organization_module_entitlements/i,
    );
    expect(migration).toContain(
      'grant execute on function public.get_tenant_module_entitlements_workspace() to authenticated',
    );
  });

  it('returns bounded aggregate status data and validates it before rendering', () => {
    expect(migration).toContain('usage_date >= current_date - 29');
    expect(migration).toContain("when entitlement_row.id is null then 'NOT_CONFIGURED'");
    expect(api).toContain("rpc('get_tenant_module_entitlements_workspace')");
    expect(api).toContain("z.enum(['ENABLED', 'DISABLED', 'EXPIRED', 'NOT_CONFIGURED'])");
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain('Platform module changes remain');
  });

  it('routes Client Admin module access before the production fallback', () => {
    expect(route).toContain("role === 'client-admin' && slug[0] === 'modules-access'");
    expect(route.indexOf('<TenantModuleEntitlementsWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
