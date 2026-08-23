import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const migration = source('supabase/migrations/202608220046_platform_user_access_workspace.sql');
const api = source('src/features/platform/platform-user-access-api.ts');
const workspace = source('src/features/platform/platform-user-access-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');
describe('platform user access workspace contract', () => {
  it('requires MFA-assured Super Admin access and bounded server pagination', () => {
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain("message = 'PLATFORM_USER_ACCESS_REQUIRED'");
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('char_length(normalized_search) > 160');
  });
  it('returns only safe profile, tenant, role and branch access fields', () => {
    expect(migration).toContain("'organization_name', organization_name");
    expect(migration).toContain("'roles', roles");
    expect(migration).toContain("'branch_count', branch_count");
    expect(migration).not.toMatch(/encrypted_payload|totp|secret|refresh_token/i);
  });
  it('uses typed RPC data, debounced TanStack Query, and the Super Admin route', () => {
    expect(api).toContain("rpc('get_platform_user_access_workspace'");
    expect(api).toContain('resultSchema.parse(data)');
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain('useDebouncedValue(search, 300)');
    expect(route).toContain("role === 'super-admin' && slug[0] === 'users-access'");
  });
});
