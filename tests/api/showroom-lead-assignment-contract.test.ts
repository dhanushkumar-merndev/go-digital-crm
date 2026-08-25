import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220040_showroom_lead_assignment_workspace.sql');
const api = source('src/features/leads/lead-assignment-workspace-api.ts');
const workspace = source('src/features/leads/lead-assignment-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('showroom lead assignment contract', () => {
  it('limits showroom assignment queues to authorized branches, teams, and lead.assign permission', () => {
    expect(migration).toContain("access_context->>'role_key' <> 'showroom-manager'");
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'lead.assign')",
    );
    expect(migration).toContain(
      'app_private.can_access_branch(current_organization_id, branch_row.id)',
    );
    expect(migration).toContain('lead_row.branch_id = any(allowed_branch_ids)');
    expect(migration).toContain('lead_row.team_id = any(scoped_team_ids)');
    expect(migration).toContain('target_page not between 1 and 100000');
    expect(migration).toContain('limit 25');
  });

  it('uses the existing audited assignment mutation and selects the role-specific bounded queue', () => {
    expect(api).toContain("'get_showroom_lead_assignment_workspace'");
    expect(workspace).toContain("audience = 'TEAM_MANAGER'");
    expect(workspace).toContain("queryKey: ['lead-assignment', ...queryScope, audience");
    expect(route).toContain("role === 'showroom-manager' && slug[0] === 'lead-assignment'");
    expect(route.indexOf('<LeadAssignmentWorkspace audience="SHOWROOM_MANAGER" />')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
