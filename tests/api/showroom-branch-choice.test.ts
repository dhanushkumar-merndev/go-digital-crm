import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202610240191_showroom_branch_choice.sql');
const teamApi = source('src/features/dashboards/showroom-sales-team-api.ts');
const targetApi = source('src/features/dashboards/showroom-target-api.ts');
const teamPage = source('src/features/dashboards/showroom-sales-team-workspace.tsx');
const targetPage = source('src/features/dashboards/showroom-target-workspace.tsx');
const picker = source('src/components/shared/branch-picker.tsx');

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

const pages = [
  ['public.get_showroom_sales_team_workspace', 'SHOWROOM_TEAM'],
  ['public.get_showroom_target_workspace', 'SHOWROOM_TARGET'],
] as const;

describe('showroom pages over several branches', () => {
  it('runs as one transaction', () => {
    expect(migration).toContain('\nbegin;\n');
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
  });

  it.each(pages)('%s keeps the Sales Manager gate', (name, code) => {
    const body = functionBody(name);
    expect(body).toContain("access_context->>'role_key' <> 'showroom-manager'");
    expect(body).toContain(
      "app_private.has_permission((access_context->>'organization_id')::uuid, 'lead.view')",
    );
    expect(body).toContain(`message = '${code}_ACCESS_REQUIRED'`);
  });

  it.each(pages)('%s checks a chosen branch and opens on the first one', (name, code) => {
    const body = functionBody(name);
    expect(body).toContain('target_branch_id uuid DEFAULT NULL::uuid');
    expect(body).toContain(
      'app_private.can_access_branch(current_organization_id, target_branch_id)',
    );
    expect(body).toContain(`message = '${code}_BRANCH_DENIED'`);
    // Several branches no longer refuse the page; only having none does.
    expect(body).not.toContain('branch_count <> 1');
    expect(body).toContain(`message = '${code}_BRANCH_REQUIRED'`);
    expect(body).toContain("'branches'");
  });

  it('replaces the four-argument team signature and grants only signed-in callers', () => {
    expect(migration).toContain(
      'drop function public.get_showroom_sales_team_workspace(integer, integer, integer, text);',
    );
    expect(migration).toContain(
      'revoke all on function public.get_showroom_sales_team_workspace(integer, integer, integer, text, uuid)\n  from public, anon;',
    );
    expect(migration).toContain(
      'grant execute on function public.get_showroom_sales_team_workspace(integer, integer, integer, text, uuid)\n  to authenticated, service_role;',
    );
  });

  it('sends the chosen branch and keys the cache on it', () => {
    expect(teamApi).toContain('target_branch_id');
    expect(targetApi).toContain('target_branch_id: branchId');
    for (const page of [teamPage, targetPage]) {
      expect(page).toContain('<BranchPicker');
      expect(page).toContain('branchId');
      expect(page).toContain('keepPreviousData');
    }
    // One branch: nothing to pick.
    expect(picker).toContain('if (branches.length < 2) return null;');
  });
});
