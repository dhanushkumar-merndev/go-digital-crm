import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610091421_journey_handoff_cancel_title.sql',
  'utf8',
);

describe('lead timeline names a cancelled Sales transfer', () => {
  it('titles the cancellation with the consultant it was taken back from', () => {
    expect(migration).toContain(
      "'Transfer to ' || coalesce(handoff_consultant.full_name, 'Sales') || ' cancelled'",
    );
    expect(migration).toContain(
      "handoff_consultant.id::text = activity_row.metadata->>'previous_sales_consultant_id'",
    );
    expect(migration).toContain('and handoff_consultant.organization_id = org');
  });

  it('shows the cancellation reason as the detail', () => {
    expect(migration).toContain("nullif(btrim(activity_row.metadata->>'reason'), '')");
  });

  it('keeps every owner change as an assignment event', () => {
    expect(migration).toContain("'Assigned to ' || coalesce(new_owner.full_name, 'a user')");
    expect(migration).toContain("'from ' || previous_owner.full_name");
  });

  it('names the takeover and call-link events', () => {
    for (const type of ['LEAD_TAKEN_OVER', 'CALL_LINKED', 'CALL_UNLINKED']) {
      expect(migration).toContain(`when '${type}' then`);
    }
  });
});
