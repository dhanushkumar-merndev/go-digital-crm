import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { roleNavigation } from '../../src/config/navigation';

const read = (path: string) => readFileSync(path, 'utf8');
const dashboard = read('src/features/dashboards/telecaller-dashboard.tsx');
const mobileDashboard = read('mobile/src/lib/telecaller-dashboard.ts');
const workspace = read('src/features/leads/lead-workspace.tsx');
const pageSpecs = read('src/config/page-specs.ts');
const migration = read('supabase/migrations/202609020002_remove_telecaller_appointments.sql');

describe('Telecaller appointment exclusion', () => {
  it('removes appointment navigation and dashboard actions', () => {
    expect(roleNavigation.telecaller.items.map((item) => item.slug)).not.toContain('appointments');
    expect(pageSpecs).toContain(
      'roleNavigation[role].items.find((candidate) => candidate.slug === slug)',
    );
    expect(dashboard.toLowerCase()).not.toContain('appointment');
    expect(dashboard).toContain('Contacted leads');
    expect(dashboard).toContain('Qualified for handoff');
    expect(dashboard).toContain('Transferred to Sales');
    expect(dashboard).toContain('Qualified leads');
    expect(mobileDashboard.toLowerCase()).not.toContain('appointment');
    expect(workspace).toContain("role !== 'telecaller'");
  });

  it('revokes and permanently rejects Telecaller appointment permissions', () => {
    expect(migration).toContain("role_row.role_key = 'telecaller_bdc'");
    expect(migration).toContain("permission_row.permission_key like 'appointment.%'");
    expect(migration).toContain("when new.role_key = 'telecaller_bdc' then array[");
    expect(migration).toContain('TELECALLER_APPOINTMENT_PERMISSION_NOT_ALLOWED');
    expect(migration).toContain('before insert or update of role_id, permission_id');
  });
});
