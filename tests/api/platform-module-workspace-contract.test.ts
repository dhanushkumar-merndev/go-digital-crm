import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220015_platform_module_workspace.sql');
const api = source('src/features/platform/module-workspace-api.ts');
const workspace = source('src/features/platform/module-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('platform module workspace backend contract', () => {
  it('allows only MFA-assured Super Admin access and bounded server pages', () => {
    expect(migration).toContain('create or replace function public.get_platform_module_workspace(');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain("message = 'PLATFORM_MODULE_ACCESS_REQUIRED'");
  });

  it('returns the platform catalog with bounded plan, entitlement and usage aggregates', () => {
    expect(migration).toContain('paged_modules as materialized');
    expect(migration).toContain(
      'limit target_page_size offset ((target_page - 1) * target_page_size)',
    );
    expect(migration).toContain("'plan_count'");
    expect(migration).toContain("'tenant_count'");
    expect(migration).toContain("'enabled_tenant_count'");
    expect(migration).toContain("'usage_last_30_days'");
    expect(migration).toContain('module_usage_module_usage_date_idx');
  });

  it('audits the enable/disable mutation and grants neither function to anonymous callers', () => {
    expect(migration).toContain('create or replace function public.set_platform_module_active(');
    expect(migration).toContain("'platform_module.active_changed'");
    expect(migration).toContain('platform_module_active_change_request_unique_idx');
    expect(migration).toContain("'safe_message'");
    expect(migration).toContain(
      'revoke all on function public.set_platform_module_active(uuid, boolean, uuid) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_platform_module_workspace(integer, integer, text, text) to authenticated',
    );
  });
});

describe('platform module workspace web contract', () => {
  it('validates the RPC response, debounces search and uses a page-specific query key', () => {
    expect(api).toContain('const resultSchema = z.object({');
    expect(api).toContain("rpc('get_platform_module_workspace'");
    expect(api).toContain("rpc('set_platform_module_active'");
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain("['platform-module-workspace', page, search, status]");
  });

  it('uses shadcn table controls and the global compact toast for audited state changes', () => {
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain("from '@/components/ui/toast'");
    expect(workspace).toContain("title: result.active ? 'Module enabled' : 'Module disabled'");
    expect(workspace).toContain("{module.active ? 'Disable' : 'Enable'}");
  });

  it('routes the real Super Admin module workspace before the unavailable fallback', () => {
    expect(route).toContain("role === 'super-admin' && slug[0] === 'modules-entitlements'");
    expect(route.indexOf('<ModuleWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
