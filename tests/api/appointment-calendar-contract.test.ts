import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/202608200008_appointment_calendar_workspace.sql');
const view = source('src/features/work/appointment-workspace-view.tsx');
const api = source('src/features/work/workspace-api.ts');
const dialogs = source('src/features/work/workspace-dialogs.tsx');

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

  it('supports all approved appointment types through list, create and update flows', () => {
    for (const type of ['Showroom Visit', 'Video Call', 'Test Drive', 'Consultant Call']) {
      expect(migration).toContain(type);
      expect(api).toContain(type);
      expect(dialogs).toContain(type);
      expect(view).toContain(type);
    }
  });

  it('implements the reference list, month calendar, agenda and working actions', () => {
    expect(view).toContain('Appointments (');
    expect(view).toContain("Today's agenda");
    expect(view).toContain('AppointmentActions');
    expect(view).toContain('fetchAppointmentCalendar');
    expect(view).toContain('Customer 360');
    expect(view).toContain('+{(day?.total ?? 0) - 3} more');
  });
});
