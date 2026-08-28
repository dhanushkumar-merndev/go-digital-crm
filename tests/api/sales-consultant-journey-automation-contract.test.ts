import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608250011_sales_consultant_journey_automation.sql',
  'utf8',
);
const appointmentStageMigration = readFileSync(
  'supabase/migrations/202608250013_appointment_sales_stage_transition.sql',
  'utf8',
);
const handoffVisibilityMigration = readFileSync(
  'supabase/migrations/202608250014_sales_consultant_handoff_lead_visibility.sql',
  'utf8',
);
const contactedWorkStateMigration = readFileSync(
  'supabase/migrations/202608250015_sales_consultant_contacted_work_state.sql',
  'utf8',
);
const contactStatusQueryMigration = readFileSync(
  'supabase/migrations/202608250016_sales_consultant_contact_status_query.sql',
  'utf8',
);
const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const workDialogs = readFileSync('src/features/work/workspace-dialogs.tsx', 'utf8');

describe('Sales Consultant journey actions', () => {
  it('keeps temperature and follow-up templates at their row controls', () => {
    expect(workspace).toContain('Set temperature');
    expect(workspace).toContain('Schedule follow-up');
    expect(workspace).toContain('followupReasons.map');
  });

  it('keeps only sales progression actions in the overflow menu', () => {
    expect(workspace).toContain('Mark as lost');
    expect(workspace).toContain('Schedule test drive');
    expect(workspace).toContain('Create quotation');
    expect(workspace).toContain('Create booking');
  });

  it('uses the fixed lead and signed-in consultant without loading an assignee selector', () => {
    expect(workDialogs).toContain("workspaceSession?.roleKey === 'sales-consultant'");
    expect(workDialogs).toContain('enabled: open && !lockInitialEntity && hasSearchTerm');
    expect(workDialogs).toContain('workspaceSession?.userId ?? resolvedAssignedUserId');
    expect(workDialogs).toContain('{!isSalesConsultant && (');
    expect(workDialogs).toContain('debouncedSearch.trim().length >= 2');
  });

  it('allows all three sales appointment types and creates next tasks automatically', () => {
    expect(migration).toContain("''Video Call'', ''Consultant Call''");
    expect(migration).toContain('automate_sales_appointment_tasks');
    expect(migration).toContain("'Confirm ' || new.appointment_type");
    expect(migration).toContain("'Follow up after ' || new.appointment_type");
  });

  it('moves a transferred sales lead to Appointment Scheduled after saving an appointment', () => {
    expect(appointmentStageMigration).toContain("'Transferred to Sales'");
    expect(appointmentStageMigration).toContain('create_appointment');
    expect(appointmentStageMigration).toContain(
      'APPOINTMENT_STAGE_TRANSITION_PATCH_TARGET_NOT_FOUND',
    );
  });

  it('shows Sales Consultant work states without changing the handoff lifecycle', () => {
    expect(handoffVisibilityMigration).toContain('actor_is_sales_consultant');
    expect(handoffVisibilityMigration).toContain('sales_handoff_at');
    expect(handoffVisibilityMigration).toContain(
      "''Transferred to Sales'', ''Appointment Scheduled'', ''Lost''",
    );
    for (const label of [
      'All',
      'New',
      'Pending',
      'Contacted',
      'Follow-up',
      'Appointments',
      'Test Drive',
      'Quotation',
      'Booking',
    ])
      expect(workspace).toContain(`label: '${label}'`);
    const salesTabs = workspace.slice(
      workspace.indexOf('const salesConsultantTabs'),
      workspace.indexOf('const tabs = role', workspace.indexOf('const salesConsultantTabs')),
    );
    expect(salesTabs).not.toContain("value: 'hot'");
    expect(workspace).toContain("const showLeadStageFilter = role !== 'sales-consultant'");
  });

  it('records a Call or WhatsApp as Sales Contacted and derives New and Pending from handoff time', () => {
    expect(contactedWorkStateMigration).toContain('record_sales_lead_contact');
    expect(contactedWorkStateMigration).toContain("'SALES_CONTACTED'");
    expect(contactedWorkStateMigration).toContain("target_status = ''sales-new''");
    expect(contactedWorkStateMigration).toContain("target_status = ''sales-pending''");
    expect(contactedWorkStateMigration).toContain("target_status = ''sales-contacted''");
    expect(contactedWorkStateMigration).toContain("''Sales Contacted''");
    expect(contactStatusQueryMigration).toContain("'sales-contacted'");
    expect(workspace).toContain('recordSalesLeadContact');
    expect(workspace).toContain("onSalesContact(row.original, 'CALL')");
    expect(workspace).toContain("onSalesContact(row.original, 'WHATSAPP')");
  });
});
