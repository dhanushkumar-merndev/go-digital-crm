import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610091423_cancel_handoff_any_sales_stage.sql',
  'utf8',
);
const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');

function functionBody(signature: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${signature}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('$function$;', start));
}

describe('a telecaller can cancel a Sales transfer at any Sales stage', () => {
  const cancel = functionBody('public.cancel_sales_handoff');

  it('accepts a booked, quoted or visit-scheduled lead and still refuses Lost', () => {
    expect(cancel).toContain(
      "target_lead.lifecycle_status not in ('Transferred to Sales', 'Appointment Scheduled')",
    );
    expect(cancel).not.toContain('HANDOFF_SALES_WORK_STARTED');
    expect(cancel).not.toContain('lead_sales_facts');
  });

  it('records the stage the lead actually left', () => {
    expect(cancel).toContain(
      "current_organization_id, target_lead.id, target_lead.lifecycle_status, 'Contacted', auth.uid(),",
    );
    expect(cancel).toContain("'previous_lifecycle_status', target_lead.lifecycle_status,");
  });

  it('brings the consultant’s open follow-ups back with the lead', () => {
    expect(cancel).toContain('update public.followups followup_row');
    expect(cancel).toContain("followup_row.status in ('OPEN', 'OVERDUE')");
    expect(cancel).toContain("'moved_followup_ids', to_jsonb(moved_followup_ids),");
  });

  it('never deletes the lead’s sales history', () => {
    for (const table of ['bookings', 'quotations', 'test_drives', 'appointments']) {
      expect(cancel).not.toMatch(new RegExp(`(delete from|update) public\\.${table}`));
    }
  });

  it('lets the telecaller who transferred the lead read its timeline', () => {
    const journey = functionBody('public.get_lead_journey');
    expect(journey).toContain(
      'or app_private.is_telecaller_handoff_viewer(org, lead_row.id, auth.uid())',
    );
  });

  it('shows Cancel transfer for visit-scheduled and booked leads in the list', () => {
    expect(workspace).toContain("row.original.lifecycle_status === 'Transferred to Sales' ||");
    expect(workspace).toContain("row.original.lifecycle_status === 'Appointment Scheduled'");
    expect(workspace).not.toContain("row.original.lead_stage === 'Transferred to Sales'");
  });
});
