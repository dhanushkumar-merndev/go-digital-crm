import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220027_automation_rule_detail_workspace.sql');
const api = source('src/features/administration/automation-workspace-api.ts');
const detail = source('src/features/administration/automation-rule-detail-workspace.tsx');
const list = source('src/features/administration/automation-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('automation rule detail contract', () => {
  it('reads a tenant-authorized rule with bounded real execution history', () => {
    expect(migration).toContain('get_automation_rule_detail');
    expect(migration).toContain("'integration.manage'");
    expect(migration).toContain(
      'where id = target_rule_id and organization_id = current_organization_id',
    );
    expect(migration).toContain('limit 25');
    expect(migration).toContain('automation_runs');
  });

  it('uses the existing server-side state transition rather than an optimistic local toggle', () => {
    expect(api).toContain("rpc('get_automation_rule_detail'");
    expect(detail).toContain('setAutomationRuleEnabled');
    expect(detail).toContain('The server-side dispatcher will use the updated state');
    expect(detail).toContain('State changes and executions remain auditable');
  });

  it('links rule records to a UUID-validated administrator detail route', () => {
    expect(list).toContain('automation-rules/${rule.id}');
    expect(route).toContain("slug[0] === 'automation-rules'");
    expect(route).toContain('AutomationRuleDetailWorkspace');
  });
});
