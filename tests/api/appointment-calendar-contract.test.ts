import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/202608200008_appointment_calendar_workspace.sql');
const view = source('src/features/work/appointment-workspace-view.tsx');
const workspace = source('src/features/work/workspace.tsx');
const api = source('src/features/work/workspace-api.ts');
const dialogs = source('src/features/work/workspace-dialogs.tsx');
const query = source('src/features/work/workspace-query.ts');
const separation = source('supabase/migrations/202608260001_appointment_test_drive_separation.sql');

describe('sales consultant appointment workspace contract', () => {
  it('keeps calendar and summary queries tenant scoped and permission guarded', () => {
    expect(migration).toContain('get_appointment_calendar');
    expect(migration).toContain('get_appointment_type_summary');
    expect(migration).toContain("has_permission(current_organization_id, 'appointment.view')");
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('app_private.can_access_customer');
    expect(migration).toContain('row_number() over');
    expect(migration).toContain('record_row.day_rank <= 3');
  });

  it('supports every bookable appointment type through list, create and update flows', () => {
    for (const type of ['Showroom Visit', 'Video Call', 'Consultant Call']) {
      expect(migration).toContain(type);
      expect(query).toContain(type);
      expect(view).toContain(type);
    }
  });

  it('does not offer Test Drive as an appointment type', () => {
    // Test drives are their own module with their own tables. An appointment
    // typed 'Test Drive' created no test-drive record, held no vehicle,
    // registration, route or feedback, and never appeared in Test Drives, so
    // the type is not offered for booking, filtering or retyping.
    expect(query).not.toContain("'Test Drive'");
    expect(dialogs).not.toContain("'Test Drive'");
    expect(separation).toContain('create_appointment');
    expect(separation).toContain('update_appointment');
    expect(separation).toContain('get_appointment_workspace_page');
    expect(separation).toContain('APPOINTMENT_TEST_DRIVE_PATCH_TARGET_NOT_FOUND');

    // Rows booked with the type before the split must still render rather than
    // failing the whole page on a schema parse error.
    expect(api).toContain('appointment_type: z.enum(');
    expect(api).toContain("'Test Drive'");
  });

  it('keeps the list, compact selected-day agenda and working actions without a full calendar mode', () => {
    expect(view).toContain('Appointments (');
    expect(view).toContain("Today's agenda");
    expect(view).toContain('AppointmentActions');
    expect(view).toContain('fetchAppointmentCalendar');
    expect(view).toContain('Customer 360');
    expect(view).not.toContain("view: 'table' | 'calendar'");
    expect(workspace).not.toContain('Calendar view');
  });
});
