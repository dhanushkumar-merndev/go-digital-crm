import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseUserWorkspaceQuery,
  toUserWorkspaceQueryString,
} from '../../src/features/administration/users/user-workspace-query';

const migration = readFileSync(
  new URL('../../supabase/migrations/202608150020_user_administration.sql', import.meta.url),
  'utf8',
);
const inviteFunction = readFileSync(
  new URL('../../supabase/functions/tenant-user-invite/index.ts', import.meta.url),
  'utf8',
);
const updateFunction = readFileSync(
  new URL('../../supabase/functions/tenant-user-update/index.ts', import.meta.url),
  'utf8',
);
const functionConfig = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
const workspace = readFileSync(
  new URL('../../src/features/administration/users/user-workspace.tsx', import.meta.url),
  'utf8',
);
const route = readFileSync(
  new URL('../../src/app/[role]/[[...slug]]/page.tsx', import.meta.url),
  'utf8',
);

describe('tenant user administration backend contract', () => {
  it('keeps Business Owner bootstrap narrow and removes the broad user grant', () => {
    expect(migration).toContain("'business_owner.user_manage_removed'");
    expect(migration).toContain("role_row.role_key = 'business_owner'");
    expect(migration).toContain("permission_row.permission_key = 'user.manage'");
    expect(migration).toContain("target_mode = 'CLIENT_ADMIN_BOOTSTRAP'");
    expect(migration).toContain("target_role_key <> 'client_admin'");
    expect(migration).toContain("assignment_row.data_scope = 'ORGANIZATION'");
    expect(migration).toContain('BUSINESS_OWNER_USER_MANAGE_FORBIDDEN');
  });

  it('enforces authority, permission, data-scope and tenant ceilings in SQL', () => {
    expect(migration).toContain('app_private.can_administer_tenant_user');
    expect(migration).toContain('app_private.assert_tenant_user_assignment');
    expect(migration).toContain('target_authority >= actor_authority');
    expect(migration).toContain('PERMISSION_DELEGATION_CEILING_EXCEEDED');
    expect(migration).toContain('BRANCH_SCOPE_CEILING_EXCEEDED');
    expect(migration).toContain('INVALID_BRANCH_SCOPE_SHAPE');
    expect(migration).toContain('TEAM_MEMBERSHIP_REQUIRED_FOR_SCOPE');
    expect(migration).toContain('ROLE_NOT_IN_ORGANIZATION');
    expect(migration).toContain("target_data_scope = 'PLATFORM'");
  });

  it('uses service-only transactional mutations, optimistic concurrency and full audit', () => {
    expect(migration).toContain('create or replace function public.provision_tenant_user');
    expect(migration).toContain(
      'create or replace function public.update_tenant_user_administration',
    );
    expect(migration).toContain("if auth.role() <> 'service_role'");
    expect(migration).toContain('current_profile.version <> expected_version');
    expect(migration).toContain('STALE_USER_VERSION');
    expect(migration).toContain("'before', before_payload");
    expect(migration).toContain("'after', jsonb_build_object(");
    expect(migration).toContain("'tenant_user.invited'");
    expect(migration).toContain("'tenant_user.updated'");
    expect(migration).toContain('tenant_user_mutation_request_unique_idx');
    expect(migration).toMatch(
      /grant execute on function public\.provision_tenant_user\([\s\S]*?to service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.update_tenant_user_administration\([\s\S]*?to service_role;/,
    );
  });

  it('soft-revokes access and does not hard-delete user business records', () => {
    expect(migration).toContain('add column if not exists active boolean not null default true');
    expect(migration).toContain('revoked_at timestamptz');
    expect(migration).toContain('revoked_by uuid');
    expect(migration).toContain('set active = false');
    expect(migration).toContain('branch_access_row.active');
    expect(migration).not.toMatch(
      /delete\s+from\s+public\.(profiles|user_role_assignments|user_branch_access|team_members)/i,
    );
  });

  it('tightens direct directory reads to the same scoped authority helper', () => {
    expect(migration).toContain('drop policy if exists profiles_read');
    expect(migration).toContain(
      "app_private.can_administer_tenant_user(auth.uid(), id, 'USER_ADMIN')",
    );
    expect(migration).toContain('drop policy if exists role_assignments_insert');
    expect(migration).toContain(
      'revoke insert, update, delete on public.user_role_assignments from anon, authenticated',
    );
    expect(migration).not.toMatch(
      /profiles_read[\s\S]{0,1000}has_permission\(organization_id, 'user\.manage'\)/,
    );
  });

  it('returns scoped server pagination, filters, KPIs and private invalidation', () => {
    expect(migration).toContain('create or replace function public.get_tenant_user_workspace');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('limit target_page_size');
    expect(migration).toContain('offset (target_page - 1) * target_page_size');
    expect(migration).toContain("'kpis', jsonb_build_object(");
    expect(migration).toContain("broadcast_tenant_invalidation('administration')");
    expect(workspace).toContain("resource: 'administration'");
  });
});

describe('tenant user Edge boundaries', () => {
  it('invites through Supabase Auth admin and compensates an uncommitted identity', () => {
    expect(inviteFunction).toContain('auth.admin.inviteUserByEmail');
    expect(inviteFunction).toContain("'/auth/invite'");
    expect(inviteFunction).toContain("client.rpc('get_access_context')");
    expect(inviteFunction).toContain('context.mfa_satisfied !== true');
    expect(inviteFunction).toContain("admin.rpc('provision_tenant_user'");
    expect(inviteFunction).toContain(".eq('action', 'tenant_user.invited')");
    expect(inviteFunction).toContain('admin.auth.admin.deleteUser(invitedUserId, false)');
    expect(inviteFunction).toContain('record_tenant_user_invite_compensation_failure');
    expect(inviteFunction).toContain('AUTH_ORPHAN_REQUIRES_REMEDIATION');
  });

  it('routes edits through the service-only RPC with a version token', () => {
    expect(updateFunction).toContain("client.rpc('get_access_context')");
    expect(updateFunction).toContain("'update_tenant_user_administration'");
    expect(updateFunction).toContain('expected_version: parsed.data.expected_version');
    expect(updateFunction).toContain("recovered?.action === 'tenant_user.updated'");
    expect(updateFunction).toContain('STALE_USER_VERSION');
  });

  it('keeps both user functions behind gateway JWT verification', () => {
    expect(functionConfig).toMatch(/\[functions\.tenant-user-invite\]\s+verify_jwt\s*=\s*true/);
    expect(functionConfig).toMatch(/\[functions\.tenant-user-update\]\s+verify_jwt\s*=\s*true/);
  });
});

describe('tenant user workspace contract', () => {
  it('uses TanStack Table, shadcn primitives and the production role routes', () => {
    expect(workspace).toContain('useReactTable');
    expect(workspace).toContain('@/components/ui/table');
    expect(workspace).toContain('@tanstack/react-query');
    expect(workspace).not.toMatch(/recharts|chart\.js|@mui|antd/i);
    expect(route).toContain("slug[0] === 'users'");
    expect(route).toContain('mode="USER_ADMIN"');
    expect(route).toContain("slug[0] === 'client-admins'");
    expect(route).toContain('mode="CLIENT_ADMIN_BOOTSTRAP"');
  });

  it('normalizes page-local URL state and rejects invalid ids', () => {
    const parsed = parseUserWorkspaceQuery(
      new URLSearchParams({
        page: '-3',
        pageSize: '100',
        q: '  Dhanush\u0000  ',
        status: 'inactive',
        role: 'not-a-uuid',
        branch: '123e4567-e89b-42d3-a456-426614174000',
        sort: 'name-asc',
      }),
    );
    expect(parsed).toEqual({
      page: 1,
      pageSize: 100,
      search: 'Dhanush',
      status: 'inactive',
      roleId: '',
      branchId: '123e4567-e89b-42d3-a456-426614174000',
      sort: 'name-asc',
    });
    expect(toUserWorkspaceQueryString(parsed)).toContain('pageSize=100');
    expect(toUserWorkspaceQueryString(parsed)).not.toContain('role=');
  });
});
