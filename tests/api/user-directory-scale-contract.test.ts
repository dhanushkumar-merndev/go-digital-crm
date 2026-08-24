import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608240010_optimize_user_directories.sql',
  'utf8',
);
const tenantApi = readFileSync('src/features/administration/users/user-workspace-api.ts', 'utf8');
const platformApi = readFileSync('src/features/platform/platform-user-access-api.ts', 'utf8');

function bodyBetween(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

const tenantDirectory = bodyBetween(
  'create or replace function public.get_tenant_user_workspace(',
  'revoke all on function public.get_tenant_user_workspace(',
);
const platformDirectory = bodyBetween(
  'create or replace function public.get_platform_user_access_workspace(',
  'revoke all on function public.get_platform_user_access_workspace(',
);

describe('100k-scale user directory contract', () => {
  it('keeps both public RPC signatures, response keys and bounded page sizes', () => {
    expect(tenantDirectory).toContain('target_page_size integer default 25');
    expect(tenantDirectory).toContain('target_role_id uuid default null');
    expect(tenantDirectory).toContain("target_mode text default 'USER_ADMIN'");
    expect(platformDirectory).toContain("target_search text default ''");
    expect(platformDirectory).toContain('target_page_size integer default 25');
    expect(tenantDirectory).toContain("'organization_id', actor_organization_id");
    expect(tenantDirectory).toContain("'records', coalesce((");
    expect(tenantDirectory).toContain("'total', filtered_summary.total");
    expect(platformDirectory).toContain("'roles', coalesce(role_data.roles");
    expect(platformDirectory).toContain("'branch_count', coalesce(branch_data.branch_count");
    expect(tenantDirectory).toContain('USER_DIRECTORY_PAGE_WINDOW_EXCEEDED');
    expect(platformDirectory).toContain('PLATFORM_USER_DIRECTORY_PAGE_WINDOW_EXCEEDED');
  });

  it('resolves primary assignments and actor delegation ceilings once', () => {
    expect(tenantDirectory).toContain('with primary_assignments as materialized (');
    expect(tenantDirectory).toContain('select distinct on (assignment_row.user_id)');
    expect(tenantDirectory).toContain('delegable_roles as materialized (');
    expect(tenantDirectory).toContain('role_row.authority_level < actor_authority');
    expect(tenantDirectory).toContain("role_row.role_key = 'client_admin'");
    expect(tenantDirectory).toContain(
      "role_row.role_key not in (\n            'business_owner', 'client_admin', 'super_admin'",
    );
    expect(tenantDirectory).toContain(
      'target_permission_row.permission_id = any(actor_permission_ids)',
    );
    expect(tenantDirectory).toContain(
      'app_private.scope_rank(assignment_row.data_scope)\n        <= app_private.scope_rank(actor_scope)',
    );
    expect(tenantDirectory).toContain('outside_actor_scope_users as materialized (');
    expect(tenantDirectory).not.toContain('app_private.can_administer_tenant_user(');
  });

  it('treats wildcard search literally and gates digit-only phone matching', () => {
    for (const body of [tenantDirectory, platformDirectory]) {
      expect(body).toContain(
        'pg_catalog.replace(\n        normalized_search,\n        pg_catalog.chr(92)',
      );
      expect(body).toContain("escape E'\\\\'");
    }
    expect(tenantDirectory).toContain('char_length(search_phone_digits) >= 3');
    expect(tenantDirectory).toContain("like search_phone_digits || '%'");
  });

  it('selects lean page IDs before hydrating bounded tenant branches and teams', () => {
    const pageIdsAt = tenantDirectory.indexOf('page_ids as materialized (');
    const pageRowsAt = tenantDirectory.indexOf('page_rows as materialized (');
    const pageBranchesAt = tenantDirectory.indexOf('page_branches as materialized (');
    const pageTeamsAt = tenantDirectory.indexOf('page_teams as materialized (');
    expect(pageIdsAt).toBeGreaterThanOrEqual(0);
    expect(pageRowsAt).toBeGreaterThan(pageIdsAt);
    expect(pageBranchesAt).toBeGreaterThan(pageRowsAt);
    expect(pageTeamsAt).toBeGreaterThan(pageBranchesAt);
    expect(tenantDirectory).toContain('select filtered_row.id, filtered_row.assignment_id');
    expect(tenantDirectory).toContain('from page_ids page_row');
    expect(tenantDirectory).not.toContain('join lateral');
    expect(tenantDirectory).not.toContain('jsonb_array_elements');
  });

  it('hydrates platform roles and branch counts only after choosing page IDs', () => {
    const pageIdsAt = platformDirectory.indexOf('page_ids as materialized (');
    const pageRolesAt = platformDirectory.indexOf('page_roles as materialized (');
    const pageBranchesAt = platformDirectory.indexOf('page_branch_counts as materialized (');
    expect(pageIdsAt).toBeGreaterThanOrEqual(0);
    expect(pageRolesAt).toBeGreaterThan(pageIdsAt);
    expect(pageBranchesAt).toBeGreaterThan(pageRolesAt);
    expect(platformDirectory).toContain('join public.user_role_assignments assignment_row');
    expect(platformDirectory).toContain('join public.user_branch_access access_row');
    expect(platformDirectory).toContain('and access_row.active');
    expect(platformDirectory).toContain('and branch_row.deleted_at is null');
    expect(platformDirectory).not.toContain('join lateral');
    expect(platformDirectory).not.toContain('select *');
  });

  it('uses single-pass summaries instead of independently rescanning each KPI', () => {
    expect(tenantDirectory).toContain('eligible_summary as (');
    expect(tenantDirectory).toContain('filtered_summary as (');
    expect(tenantDirectory).toContain(
      'count(*) filter (where eligible_row.active) as active_users',
    );
    expect(platformDirectory).toContain('filtered_summary as (');
    expect(platformDirectory).toContain(
      'count(*) filter (where filtered_row.mfa_required) as mfa_required',
    );
  });

  it('adds only targeted concurrent indexes outside an explicit transaction', () => {
    expect(migration.trimStart()).not.toMatch(/^begin;/i);
    expect(migration.match(/create index concurrently if not exists/g)).toHaveLength(4);
    expect(migration).toContain('profiles_tenant_user_updated_page_idx');
    expect(migration).toContain('profiles_platform_user_page_idx');
    expect(migration).toContain('profiles_user_directory_search_trgm_idx');
    expect(migration).toContain('profiles_tenant_phone_digits_prefix_idx');
  });

  it('preserves the typed client API boundaries', () => {
    expect(tenantApi).toContain("rpc('get_tenant_user_workspace'");
    expect(tenantApi).toContain('workspaceSchema.parse(data)');
    expect(platformApi).toContain("rpc('get_platform_user_access_workspace'");
    expect(platformApi).toContain('resultSchema.parse(data)');
  });
});
