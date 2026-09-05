import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609040001_team_manager_activity_timeline.sql');
const fixMigration = source('supabase/migrations/202609040006_post_push_function_lint_fixes.sql');
const api = source('src/features/dashboards/team-manager-activity-api.ts');
const workspace = source('src/features/dashboards/team-manager-activity-timeline.tsx');

describe('team manager activity timeline contract', () => {
  it('limits both overview and member activity to teams managed by the actor', () => {
    expect(migration).toContain('team_row.manager_id = current_user_id');
    expect(migration).toContain('member_row.team_id = any(managed_team_ids)');
    expect(migration).toContain("access_context->>'role_key' <> 'team-manager'");
  });

  it('repairs the member summary with its own day-scoped relation', () => {
    expect(fixMigration).toContain('TEAM_ACTIVITY_FUNCTION_PATCH_MISMATCH');
    expect(fixMigration).toContain('join public.leads lead_row');
    expect(fixMigration).toContain('lead_row.assigned_user_id = target_member_id');
    expect(fixMigration).toContain('lead_row.team_id = any(managed_team_ids)');
    expect(fixMigration).toContain('activity_row.occurred_at >= range_start');
    expect(fixMigration).toContain('activity_row.occurred_at < range_end');
  });

  it('uses the shared RPC with server pagination and role-specific drill-downs', () => {
    expect(api).toContain("rpc('get_team_manager_activity_timeline'");
    expect(api).toContain('target_page_size: query.pageSize');
    expect(workspace).toContain('fetchTeamActivityOverview');
    expect(workspace).toContain('fetchTeamMemberActivity');
    expect(workspace).toContain('roleActivityKinds[role]');
  });
});
