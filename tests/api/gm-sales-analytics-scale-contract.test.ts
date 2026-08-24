import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202608240011_optimize_gm_sales_analytics.sql'),
  'utf8',
);

describe('GM sales analytics 100k-scale contract', () => {
  it('keeps the public signature, CRM/MFA bootstrap gate, and JSON keys stable', () => {
    expect(migration).toContain(
      'create or replace function public.get_gm_sales_analytics_workspace(',
    );
    expect(migration).toContain("access_context->>'destination' <> 'CRM'");
    expect(migration).toContain("access_context->>'role_key' <> 'gm-sales'");
    expect(migration).toContain('target_days not in (7, 14, 30)');
    for (const key of ["'kpis'", "'branches'", "'consultants'", "'models'", "'daily'"])
      expect(migration).toContain(key);
  });

  it('binds each permission and branch scope to the same active assignment', () => {
    expect(migration).toContain(
      'create or replace function app_private.permission_bound_active_branch_ids(',
    );
    expect(migration).toContain('assignment_row.active');
    expect(migration).toContain('role_permission_row.role_id = assignment_row.role_id');
    expect(migration).toContain('permission_row.permission_key = any(');
    expect(migration).toContain("assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')");
    expect(migration).toContain("assignment_row.data_scope = 'ONE_BRANCH'");
    expect(migration).toContain("assignment_row.data_scope = 'SELECTED_BRANCHES'");
    expect(migration).toContain("message = 'GM_SALES_BRANCH_SCOPE_REQUIRED'");
  });

  it('uses set-based rollups instead of per-row access checks or correlated rescans', () => {
    expect(migration).toContain('lead_rollups as materialized');
    expect(migration).toContain('booking_rollups as materialized');
    expect(migration).toContain('group by grouping sets');
    expect(migration).toContain('lead_assignment_stats as materialized');
    expect(migration).toContain('consultant_stats_unbounded as (');
    expect(migration).not.toMatch(/app_private\.can_access_(?:record|branch|team)\s*\(/);
    expect(migration).not.toMatch(
      /select\s+count\(\*\)\s+from\s+scoped_(?:leads|calls|drives|quotations|bookings)\s+row\s+where/i,
    );
  });

  it('bounds response-heavy dimensions with deterministic ordering', () => {
    expect(migration.match(/limit 100/g)).toHaveLength(2);
    expect(migration).toContain(
      'bookings desc,\n      quotations desc,\n      calls desc,\n      full_name,\n      user_id,\n      branch_id',
    );
    expect(migration).toContain('order by metric_count desc, model_name\n    limit 100');
    expect(migration).toContain('start_day := local_today - (target_days - 1)');
  });

  it('does not introduce duplicate indexes or transaction-unsafe concurrent DDL', () => {
    expect(migration).not.toMatch(/create\s+index/i);
    expect(migration).not.toMatch(/concurrently/i);
  });
});
