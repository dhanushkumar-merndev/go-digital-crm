import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../supabase/migrations/202608290002_sales_consultant_single_team_membership.sql',
    import.meta.url,
  ),
  'utf8',
);
const workspace = readFileSync(
  new URL('../../src/features/administration/users/user-workspace.tsx', import.meta.url),
  'utf8',
);

describe('Sales Consultant single-team membership', () => {
  it('enforces at most one active team in the user-administration workflow and database', () => {
    expect(migration).toContain("target_role_key = ''sales_consultant''");
    expect(migration).toContain("message = ''SALES_CONSULTANT_SINGLE_TEAM_REQUIRED''");
    expect(migration).toContain('team_members_one_active_sales_consultant_idx');
    expect(migration).toContain("where active and member_type = 'SALES_CONSULTANT'");
  });

  it('makes the Sales Consultant team control single-select', () => {
    expect(workspace).toContain(
      "const requiresSingleTeam = selectedRole?.role_key === 'sales_consultant';",
    );
    expect(workspace).toContain("'Team membership (choose one)'");
    expect(workspace).toContain('? [team.id]');
  });
});
