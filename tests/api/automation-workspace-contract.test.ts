import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220024_automation_rules_workspace.sql');
const api = source('src/features/administration/automation-workspace-api.ts');
const workspace = source('src/features/administration/automation-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('automation rules workspace contract', () => {
  it('uses a scoped, bounded server workspace query and indexed execution paths', () => {
    expect(migration).toContain('create index if not exists automation_rules_workspace_idx');
    expect(migration).toContain('create index if not exists automation_runs_workspace_idx');
    expect(migration).toContain(
      'create or replace function public.get_automation_rules_workspace(',
    );
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'integration.manage')",
    );
    expect(migration).toContain(
      'limit target_page_size offset ((target_page - 1) * target_page_size)',
    );
  });

  it('creates idempotent auditable rules with an explicit status transition', () => {
    expect(migration).toContain('create or replace function public.create_automation_rule(');
    expect(migration).toContain('REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT');
    expect(migration).toContain("'automation_rule.created'");
    expect(migration).toContain('create or replace function public.set_automation_rule_enabled(');
    expect(migration).toContain("'automation_rule.enabled_changed'");
    expect(migration).toContain('grant execute on function public.create_automation_rule');
  });

  it('uses server-side reads and targeted Query invalidation from the routed system-admin screen', () => {
    expect(api).toContain("rpc('get_automation_rules_workspace'");
    expect(api).toContain("rpc('create_automation_rule'");
    expect(api).toContain("rpc('set_automation_rule_enabled'");
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain("['automation-workspace', page, search, status]");
    expect(workspace).toContain("invalidateQueries({ queryKey: ['automation-workspace'] })");
    expect(workspace).toContain('kind="donut"');
    expect(route).toContain("role === 'system-administrator' && slug[0] === 'automation-rules'");
  });
});
