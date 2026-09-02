import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { roleNavigation } from '../../src/config/navigation';

const migration = readFileSync(
  'supabase/migrations/202609020004_lead_duplicate_deletion_approval.sql',
  'utf8',
);
const leadWorkspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const managerWorkspace = readFileSync(
  'src/features/leads/duplicate-lead-deletion-workspace.tsx',
  'utf8',
);

describe('untouched duplicate lead deletion approval', () => {
  it('only permits a newer same-phone New lead with no recorded work', () => {
    expect(migration).toContain("duplicate_lead.lifecycle_status = 'New'");
    expect(migration).toContain('retained_lead.normalized_phone');
    expect(migration).toContain('(retained_lead.created_at, retained_lead.id) <');
    expect(migration).toContain('from public.lead_stage_history');
    expect(migration).toContain('from public.activities');
    expect(migration).toContain('from public.followups');
    expect(migration).toContain('from public.calls');
    expect(migration).toContain('from public.appointments');
    expect(migration).toContain('from public.test_drives');
    expect(migration).toContain('from public.quotations');
    expect(migration).toContain('from public.bookings');
  });

  it('requires an in-scope Team Manager and revalidates before soft deletion', () => {
    expect(migration).toContain("role_row.role_key = 'team_manager'");
    expect(migration).toContain('REQUESTER_CANNOT_APPROVE');
    expect(migration).toContain('LEAD_NO_LONGER_ELIGIBLE');
    expect(migration).toContain('set deleted_at = now()');
    expect(migration).toContain('duplicate_of_lead_id = request_row.retained_lead_id');
    expect(migration).not.toMatch(/delete\s+from\s+public\.leads/i);
    expect(migration).toContain("'lead.duplicate_deletion_approved'");
  });

  it('surfaces request and approval actions in the correct role workspaces', () => {
    expect(roleNavigation['team-manager'].items.map((item) => item.slug)).toContain(
      'duplicate-leads',
    );
    expect(roleNavigation.telecaller.items.map((item) => item.slug)).not.toContain(
      'duplicate-leads',
    );
    expect(leadWorkspace).toContain('Request duplicate removal');
    expect(leadWorkspace).toContain("role === 'telecaller' || role === 'sales-consultant'");
    expect(managerWorkspace).toContain('useReactTable');
    expect(managerWorkspace).toContain('Approve soft deletion');
    expect(managerWorkspace).toContain('Reject request');
  });
});
