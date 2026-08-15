import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeRoleSearch,
  parseRoleWorkspaceQuery,
  toCustomRoleKey,
  toRoleWorkspaceQueryString,
} from '../../src/features/administration/role-workspace-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150022_role_administration.sql');
const api = source('src/features/administration/role-workspace-api.ts');
const workspace = source('src/features/administration/role-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('delegated role backend contract', () => {
  it('requires tenant MFA and role.manage for every read and mutation boundary', () => {
    expect(migration).toContain('app_private.mfa_policy_satisfied(actor_organization_id)');
    expect(migration).toContain("app_private.has_permission(actor_organization_id, 'role.manage')");
    expect(migration).toContain("message = 'ROLE_ADMINISTRATION_ACCESS_REQUIRED'");
    expect(migration).toContain('security definer');
  });

  it('bounds server paging, filters, sorts, and page-local search', () => {
    expect(migration).toContain('page_size not in (25, 50, 100)');
    expect(migration).toContain("role_filter not in ('all', 'system', 'custom', 'mfa')");
    expect(migration).toContain("sort_key not in ('authority_desc', 'name_asc', 'created_desc')");
    expect(migration).toContain('limit page_size');
    expect(migration).toContain('offset page_offset');
    expect(api).toContain(".rpc('get_role_administration_page'");
  });

  it('keeps immutable presets and every custom role below the actor ceiling', () => {
    expect(migration).toContain('not role_row.system_role');
    expect(migration).toContain('role_row.authority_level < actor_authority');
    expect(migration).toContain('if role_row.system_role');
    expect(migration).toContain('target_authority_level not between 1 and actor_authority - 1');
    expect(migration).toContain("normalized_key !~ '^custom_");
    expect(migration).toContain("normalized_name ilike '%team leader%'");
  });

  it('allows only permissions already inside the actor delegation ceiling', () => {
    expect(migration).toContain("message = 'PERMISSION_DELEGATION_CEILING_EXCEEDED'");
    expect(migration).toContain(
      'actor_permission.permission_key = requested_permission.permission_key',
    );
    expect(migration).toContain('list_delegable_role_permissions');
    expect(migration).toContain(
      'coalesce(cardinality(normalized_permissions), 0) not between 1 and 50',
    );
  });

  it('uses one transactional RPC, optimistic concurrency, and explicit audit events', () => {
    expect(api).toContain(".rpc('save_delegated_role'");
    expect(migration).toContain('role_row.updated_at <> expected_updated_at');
    expect(migration).toContain("message = 'ROLE_VERSION_CONFLICT'");
    expect(migration).toContain("'role.permission.revoked'");
    expect(migration).toContain("'role.permission_set.saved'");
    expect(migration).toContain('drop policy if exists roles_insert');
    expect(migration).toContain('drop policy if exists roles_update');
    expect(migration).toContain('drop policy if exists role_permissions_insert');
  });
});

describe('role workspace query and UI contract', () => {
  it('normalizes stable custom keys without ever generating Team Leader', () => {
    expect(toCustomRoleKey('Regional Lead Reviewer')).toBe('custom_regional_lead_reviewer');
    expect(toCustomRoleKey('Rôle – Finance')).toBe('custom_role_finance');
    expect(toCustomRoleKey('')).toBe('custom_role');
    expect(workspace).toContain("!name.toLowerCase().includes('team leader')");
  });

  it('sanitizes search and parses only approved query state', () => {
    expect(normalizeRoleSearch('  custom_admin% <x>  ')).toBe('custom_admin x');
    expect(
      parseRoleWorkspaceQuery(
        new URLSearchParams('page=2&pageSize=50&filter=custom&sort=name_asc&q=Reviewer'),
      ),
    ).toEqual({
      page: 2,
      pageSize: 50,
      filter: 'custom',
      sort: 'name_asc',
      search: 'Reviewer',
    });
    expect(
      parseRoleWorkspaceQuery(new URLSearchParams('page=0&pageSize=500&filter=raw&sort=sql')),
    ).toEqual({
      page: 1,
      pageSize: 25,
      filter: 'all',
      sort: 'authority_desc',
      search: '',
    });
  });

  it('serializes only meaningful page-local URL state', () => {
    expect(
      toRoleWorkspaceQueryString({
        page: 3,
        pageSize: 25,
        filter: 'mfa',
        sort: 'authority_desc',
        search: 'Admin',
      }),
    ).toBe('page=3&q=Admin&filter=mfa');
  });

  it('uses only the production role routes and approved UI/data stack', () => {
    expect(route).toContain("slug[0] === 'roles-permissions'");
    expect(route).toContain('<RoleWorkspace spec={spec} />');
    expect(workspace).toContain('useReactTable');
    expect(workspace).toContain('@/components/ui/dialog');
    expect(workspace).toContain('@/components/ui/table');
    expect(workspace).toContain('useTenantRealtimeInvalidation');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
    expect(workspace).not.toContain('demo-page-repository');
  });
});
