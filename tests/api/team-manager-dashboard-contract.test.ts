import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220010_team_manager_performance.sql');
const workspace = source('src/features/dashboards/team-manager-performance.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('team manager dashboard contract', () => {
  it('uses the managed-team analytics boundary for the dashboard route', () => {
    expect(migration).toContain("access_context->>'role_key' <> 'team-manager'");
    expect(migration).toContain('team_row.manager_id = current_user_id');
    expect(migration).toContain(
      'app_private.can_access_team(current_organization_id, team_row.id)',
    );
    expect(workspace).toContain("heading = 'Team Performance'");
    expect(route).toContain("role === 'team-manager' && slug[0] === 'dashboard'");
    expect(route).toContain('<TeamManagerPerformance heading="Team Manager Workspace" />');
    expect(
      route.indexOf('<TeamManagerPerformance heading="Team Manager Workspace" />'),
    ).toBeLessThan(route.indexOf("if (slug[0] === 'dashboard'"));
  });
});
