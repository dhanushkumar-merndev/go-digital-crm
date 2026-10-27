import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202610270179_operations_lists_scope_once.sql');
const deskDashboard = source('src/features/operations/operational-desk-dashboard.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

const branchLists = [
  ['public.get_stock_movement_page', "message = 'INVENTORY_VIEW_REQUIRED'", 2],
  ['public.get_stock_allocation_page', "message = 'INVENTORY_VIEW_REQUIRED'", 1],
  ['public.get_review_approval_queue', "message = 'REVIEW_QUEUE_ACCESS_REQUIRED'", 3],
] as const;

describe('operations lists resolve scope once', () => {
  it('runs as one transaction', () => {
    expect(migration).toContain('\nbegin;\n');
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
  });

  it.each(branchLists)('%s checks rows against branches resolved once', (name, gate, uses) => {
    const body = functionBody(name);
    expect(body).toContain(gate);
    expect(body).toContain(
      'and app_private.can_access_branch(current_organization_id, branch_row.id);',
    );
    expect(body.match(/= any\(accessible_branch_ids\)/g)).toHaveLength(uses);
    // The only can_access_branch left is the one-off branch resolution (and,
    // for the stock pages, the chosen-branch guard).
    expect(body).not.toMatch(/can_access_branch\(\s*(movement_row|allocation_row|source_row)/);
  });

  it('keeps the per-record fallback and reads customer access once in delivery feedback', () => {
    const body = functionBody('public.get_delivery_feedback_workspace_page');
    expect(body).toContain("message = 'DELIVERY_FEEDBACK_VIEW_PERMISSION_REQUIRED'");
    expect(body).toContain(
      'app_private.can_access_record(current_organization_id, branch_row.id, null, null)',
    );
    expect(body).toContain('case when delivery_row.branch_id = any(branch_wide_ids) then true');
    expect(body).toContain('app_private.resolve_customer_access_scope(current_organization_id)');
    expect(body).not.toContain('app_private.can_access_customer(');
  });
});

describe('desk dashboards', () => {
  it('summarise the case queue from one call', () => {
    expect(route).toContain('<OperationalDeskDashboard spec={spec} role={role} />');
    expect(deskDashboard).toContain('fetchOperationalCaseWorkspace(');
    expect(deskDashboard).toContain("sort: 'due:asc'");
    expect(deskDashboard).toContain('status_counts');
  });
});
