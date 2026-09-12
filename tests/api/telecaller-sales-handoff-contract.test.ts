import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const api = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202608250007_telecaller_sales_handoff.sql',
  'utf8',
);
const candidateMigration = readFileSync(
  'supabase/migrations/202608250008_role_specific_lead_assignment_candidates.sql',
  'utf8',
);
const mandatoryReasonMigration = readFileSync(
  'supabase/migrations/202609100002_require_sales_handoff_reason.sql',
  'utf8',
);

describe('Telecaller to Sales Consultant handoff contract', () => {
  it('keeps reassignment out of the Sales Consultant table action menu', () => {
    expect(workspace).toContain("role === 'team-manager' && Boolean(permissions?.canAssign)");
    expect(workspace).not.toContain(
      'canAssign={!spec.readOnly && Boolean(permissions?.canAssign)}',
    );
  });

  it('limits lifecycle choices by role while preserving the automatic handoff state as read-only', () => {
    expect(workspace).toContain("role === 'sales-consultant'");
    expect(workspace).toContain("['Appointment Scheduled', 'Lost']");
    expect(workspace).toContain("['New', 'Contacted', 'Qualified', 'Lost']");
    expect(workspace).toContain("option === 'Transferred to Sales'");
  });

  it('requires a qualified lead before a Sales Consultant can receive it', () => {
    expect(migration).toContain('SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD');
    expect(migration).toContain("new.assignment_type <> 'QUALIFIED'");
    expect(migration).toContain("current_lifecycle <> 'Qualified'");
  });

  it('offers only Telecallers for intake and only Sales Consultants after qualification', () => {
    expect(candidateMigration).toContain(
      'create or replace function public.get_lead_assignment_candidates',
    );
    expect(candidateMigration).toContain("role_row.role_key = 'telecaller_bdc'");
    expect(candidateMigration).toContain("role_row.role_key = 'sales_consultant'");
    expect(candidateMigration).toContain('FRESH_ASSIGNMENT_REQUIRES_TELECALLER');
    expect(api).toContain("rpc('get_lead_assignment_candidates'");
    expect(workspace).toContain('Hand over to Sales Consultant');
    expect(workspace).toContain('Assign lead to Telecaller');
  });

  it('records the transfer automatically and prevents direct intake changes', () => {
    expect(migration).toContain('Automatic qualified-lead handoff to Sales Consultant');
    expect(migration).toContain("'lead.transferred_to_sales'");
    expect(migration).toContain('SALES_CONSULTANT_CANNOT_ASSIGN_LEADS');
    expect(migration).toContain('SALES_CONSULTANT_LIFECYCLE_FORBIDDEN');
    expect(migration).toContain('TELECALLER_LIFECYCLE_FORBIDDEN');
  });

  it('filters the Sales Consultant lead page to leads with a handoff event', () => {
    expect(migration).toContain('SALES_LEAD_WORKSPACE_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain("handoff_history.to_status = \\'Transferred to Sales\\'");
  });

  it('requires a meaningful handoff reason in the form and database RPC', () => {
    expect(workspace).toContain('Reason <RequiredMark />');
    expect(workspace).toContain('placeholder="Why this lead is ready for Sales"');
    expect(workspace).toContain('!reason.trim()');
    expect(mandatoryReasonMigration).toContain('TRANSFER_REASON_REQUIRED');
    expect(mandatoryReasonMigration).toContain('normalized_reason is null');
    expect(mandatoryReasonMigration).toContain(
      'revoke all on function public.transfer_lead_to_sales',
    );
  });
});
