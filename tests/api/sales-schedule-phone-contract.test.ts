import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/202610210101_sales_schedule_phone.sql', 'utf8');

describe('Sales dashboard schedule phone', () => {
  it('patches the live function instead of re-emitting its body', () => {
    expect(migration).not.toMatch(/create\s+or\s+replace\s+function\s+public\./i);
    expect(
      migration.match(
        /pg_temp\.patch_function\(\s*'public\.get_sales_consultant_dashboard_live\(text\)'/g,
      ),
    ).toHaveLength(5);
  });

  it('adds the phone as the last column of every union branch and the outer select', () => {
    // Outer select, then follow-ups, visits, test drives and deliveries.
    expect(migration).toContain('source_row.status,\n        source_row.phone\n      from (');
    expect(migration).toContain(
      'coalesce(lead_row.phone, customer_row.primary_phone) as phone\n        from public.followups',
    );
    expect(migration).toContain(
      'coalesce(lead_row.phone, customer_row.primary_phone)\n        from public.appointments',
    );
    expect(migration).toContain(
      'coalesce(lead_row.phone, customer_row.primary_phone)\n        from public.test_drive_appointments',
    );
    expect(migration).toContain('customer_row.primary_phone\n        from public.delivery_cases');
  });

  it('does not touch the scope predicates', () => {
    expect(migration).not.toMatch(/assigned_user_id|allowed_branch_ids|current_organization_id/);
  });
});
