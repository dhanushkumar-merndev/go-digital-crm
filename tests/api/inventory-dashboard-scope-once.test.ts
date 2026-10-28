import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202610280101_inventory_dashboard_scope_once.sql'),
  'utf8',
);
const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));

describe('inventory dashboard resolves branch scope once', () => {
  it('replaces the dashboard function in place', () => {
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.get_inventory_dashboard()');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("app_private.has_permission(current_organization_id, 'inventory.view')");
  });

  it('calls can_access_branch per branch, never per stock or allocation row', () => {
    expect(body.match(/app_private\.can_access_branch\(/g)).toHaveLength(1);
    expect(body).toContain('app_private.can_access_branch(current_organization_id, branch_row.id)');
    expect(body).toContain(
      'stock_row.branch_id in (select accessible_row.id from accessible_branches accessible_row)',
    );
    expect(body).toContain('allocation_row.branch_id in (');
  });
});
