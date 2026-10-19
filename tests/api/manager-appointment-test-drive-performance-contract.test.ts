import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610182100_scoped_appointment_test_drive_pages.sql',
  'utf8',
);

function body(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = migration.indexOf('$function$;', start);
  return migration.slice(start, end);
}

// Per-row SECURITY DEFINER helpers made these manager pages O(rows in the
// organization): 8-17 s on ~1,600 rows and a 57014 timeout at 8 s.
const perRowHelpers = [
  'app_private.can_access_record(',
  'app_private.can_access_customer(',
  'app_private.can_access_lead(',
];

describe('manager Appointments and Test Drives performance', () => {
  it.each(['get_appointment_workspace_page_legacy', 'get_test_drive_workspace_page_legacy'])(
    '%s resolves scope once and filters rows on arrays',
    (name) => {
      const definition = body(name);
      for (const helper of perRowHelpers) expect(definition).not.toContain(helper);
      expect(definition).toContain('app_private.resolve_permission_record_scope(');
      expect(definition).toContain("array['lead.view']");
      expect(definition).toContain('app_private.resolve_customer_access_scope(');
      expect(definition).toContain('app_private.actor_owned_lead_ids(');
      // can_access_record hid records in inactive or deleted branches.
      expect(definition).toContain('and branch_row.active');
      expect(definition).toContain('and branch_row.deleted_at is null');
    },
  );

  it('keeps the appointment permission and the test-drive organization-wide rule', () => {
    expect(body('get_appointment_workspace_page_legacy')).toContain("array['appointment.view']");
    const drives = body('get_test_drive_workspace_page_legacy');
    expect(drives).toContain("array['test_drive.view', 'test_drive.manage']");
    expect(drives).toContain('organization_wide_drive_view');
    expect(drives).toContain('app_private.has_organization_wide_scope(current_organization_id)');
  });

  it('checks quotation access once, not per test drive', () => {
    const drives = body('get_test_drive_workspace_page_legacy');
    expect(drives).not.toContain(
      "app_private.has_permission(drive_row.organization_id, 'quotation",
    );
    expect(drives).toContain("array['quotation.view', 'quotation.manage']");
    expect(drives).toContain('when quotation_access');
  });
});
