import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/202608150021_branch_team_administration.sql', import.meta.url),
  'utf8',
);
const route = readFileSync(
  new URL('../../src/app/[role]/[[...slug]]/page.tsx', import.meta.url),
  'utf8',
);
const workspace = readFileSync(
  new URL('../../src/features/administration/branch-team-workspace.tsx', import.meta.url),
  'utf8',
);

describe('branch and team administration backend contract', () => {
  it('installs dedicated permissions and only frozen administration role defaults', () => {
    expect(migration).toContain("('branch.manage', 'administration'");
    expect(migration).toContain("('team.manage', 'administration'");
    expect(migration).toContain("role_row.role_key in ('client_admin', 'system_administrator')");
    expect(migration).toContain('role_row.system_role');
  });

  it('keeps operational records behind an active branch while retaining a management scope helper', () => {
    expect(migration).toContain('app_private.actor_scope_includes_branch');
    expect(migration).toMatch(
      /create or replace function app_private\.can_access_record[\s\S]*branch_row\.active[\s\S]*actor_scope_includes_branch/,
    );
    expect(migration).toMatch(
      /create or replace function app_private\.can_access_branch[\s\S]*branch\.manage/,
    );
    expect(migration).toContain('and branch_access_row.active');
  });

  it('uses indexed, scoped, server-side pagination and bounded search', () => {
    expect(migration).toContain('create index if not exists branches_admin_page_idx');
    expect(migration).toContain('create index if not exists teams_admin_page_idx');
    expect(migration).toContain('branches_admin_name_trgm_idx');
    expect(migration).toContain('teams_admin_name_trgm_idx');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('char_length(normalized_search) > 160');
    expect(migration).toContain('limit target_page_size');
    expect(migration).toContain('offset (target_page - 1) * target_page_size');
    expect(migration).not.toMatch(/select\s+\*\s+from\s+filtered/i);
  });

  it('exposes focused RPC-only mutations with audit, idempotency, and optimistic concurrency', () => {
    for (const operation of [
      'create_branch',
      'update_branch',
      'create_team',
      'update_team',
      'set_team_member',
      'set_user_branch_access',
    ]) {
      expect(migration).toContain(`create or replace function public.${operation}`);
    }
    expect(migration).toContain('app_private.replay_administration_request');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("message = 'BRANCH_VERSION_CONFLICT'");
    expect(migration).toContain("message = 'TEAM_VERSION_CONFLICT'");
    expect(migration).toContain("message = 'BRANCH_ACCESS_VERSION_CONFLICT'");
    expect(migration).toContain('insert into public.audit_logs');
    expect(migration).toContain('revoke insert, update, delete on public.branches');
    expect(migration).toContain('revoke insert, update, delete on public.teams');
    expect(migration).toContain('revoke insert, update, delete on public.team_members');
  });

  it('blocks unsafe deactivation and enforces tenant, branch, role, and authority integrity', () => {
    expect(migration).toContain('app_private.branch_has_active_dependencies');
    expect(migration).toContain('app_private.team_has_active_dependencies');
    expect(migration).toContain("message = 'BRANCH_HAS_ACTIVE_DEPENDENCIES'");
    expect(migration).toContain("message = 'TEAM_HAS_ACTIVE_DEPENDENCIES'");
    expect(migration).toContain('app_private.actor_can_administer_user');
    expect(migration).toContain('app_private.user_has_team_member_role');
    expect(migration).toContain("'TEAM_MANAGER', 'SALES_CONSULTANT', 'TELECALLER_BDC'");
    expect(migration).not.toMatch(/team[_ ]leader/i);
  });

  it('publishes private administration invalidations with the bootstrap exception', () => {
    expect(migration).toContain('|administration)');
    expect(migration).toContain("when 'administration' then");
    expect(migration).toContain(
      "app_private.tenant_user_mode_allowed(auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP')",
    );
    for (const table of [
      'branches',
      'teams',
      'team_members',
      'user_branch_access',
      'profiles',
      'user_role_assignments',
    ]) {
      expect(migration).toContain(`on public.${table}`);
    }
    expect(migration).toContain("app_private.broadcast_tenant_invalidation('administration')");
  });

  it('wires only the finished role routes and uses the approved web data stack', () => {
    expect(route).toContain('BranchTeamWorkspace');
    expect(route).toContain("slug[0] === 'branches'");
    expect(route).toContain("slug[0] === 'teams'");
    expect(route).toContain("slug[0] === 'branches-access'");
    expect(route).toContain('preset="ACCESS"');
    expect(workspace).toContain('@tanstack/react-query');
    expect(workspace).toContain('@tanstack/react-table');
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain("resource: 'administration'");
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });
});
