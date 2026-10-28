import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202610270211_dashboard_own_followups_count.sql'),
  'utf8',
);
const followupStart = migration.indexOf('if can_view_followups then');
const followupBlock = migration.slice(followupStart, migration.indexOf('end if;', followupStart));

describe('dashboard follow-up counts match the follow-up list', () => {
  it('counts a follow-up assigned to the caller past the lead and customer checks', () => {
    expect(followupBlock).toContain(
      'followup_row.assigned_user_id = auth.uid()\n        or followup_row.lead_id is null',
    );
    expect(followupBlock).toContain(
      'followup_row.assigned_user_id = auth.uid()\n        or followup_row.customer_id is null',
    );
  });

  it('keeps the scope checks for everyone else', () => {
    expect(followupBlock).toContain('lead_scope.granted');
    expect(followupBlock).toContain('customer_scope.granted');
    expect(followupBlock).toContain("followup_row.status in ('OPEN', 'OVERDUE')");
  });

  it('replaces the private dashboard function in place', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app_private.tenant_performance_dashboard(target_days integer, target_timezone text, include_live_items boolean)',
    );
    expect(migration).toContain('SECURITY DEFINER');
  });
});
