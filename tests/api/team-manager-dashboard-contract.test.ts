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
  it('keeps Team Performance on the managed-team analytics boundary', () => {
    expect(migration).toContain("access_context->>'role_key' <> 'team-manager'");
    expect(migration).toContain('team_row.manager_id = current_user_id');
    expect(migration).toContain(
      'app_private.can_access_team(current_organization_id, team_row.id)',
    );
    // The title is the sidebar label, read from the page spec.
    expect(workspace).toContain('spec: PageSpec');
    expect(route).toContain('<TeamManagerPerformance spec={spec} showHandoffs />');
    expect(route).toContain("role === 'team-manager' && slug[0] === 'team-performance'");
  });

  it('gives the dashboard its own screen instead of repeating Team Performance', () => {
    const dashboardRoute = route.slice(
      route.indexOf("role === 'team-manager' && slug[0] === 'dashboard'"),
    );
    expect(dashboardRoute.slice(0, 260)).toContain('<TenantDashboard spec={spec} role={role}>');
    // PRD 54.3 §4: the dashboard ends with the managed team's overview table.
    expect(dashboardRoute.slice(0, 260)).toContain('<TeamOverviewCard />');
    expect(route).not.toContain('<TeamManagerPerformance heading="Team Manager Workspace" />');
  });
});
