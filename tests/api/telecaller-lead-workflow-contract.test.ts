import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const workspaceApi = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');
const intakeMigration = readFileSync(
  'supabase/migrations/202608310003_telecaller_created_lead_intake_workflow.sql',
  'utf8',
);
const distributionMigration = readFileSync(
  'supabase/migrations/202608310004_telecaller_intake_distribution_and_sales_handoff.sql',
  'utf8',
);
const handoffMigration = readFileSync(
  'supabase/migrations/202608310005_telecaller_sales_handoff_assignment.sql',
  'utf8',
);

describe('Telecaller lead workflow', () => {
  it('shows the intake queues, including the actual sales handoff state', () => {
    expect(workspace).toContain('const telecallerTabs');
    expect(workspace).toContain("{ label: 'Pending', value: 'pending'");
    expect(workspace).toContain("{ label: 'Contacted', value: 'contacted'");
    expect(workspace).toContain("label: 'Transferred to Sales'");
    expect(workspace).toContain("{ label: 'Follow-up', value: 'follow-up'");
    expect(workspace).toContain("{ label: 'Lost', value: 'lost'");
    expect(workspace).toContain("role === 'telecaller'");
  });

  it('keeps a Telecaller-created lead in intake until it is truly qualified and handed over', () => {
    expect(intakeMigration).toContain("role_row.role_key = ''sales_consultant''");
    expect(intakeMigration).toContain(
      "case when self_assigned and actor_is_sales_consultant then ''Transferred to Sales'' else ''New''",
    );
    expect(intakeMigration).toContain(
      'case when self_assigned and actor_is_sales_consultant then clock_timestamp() else null end',
    );
    expect(intakeMigration).toContain('if self_assigned and actor_is_sales_consultant then');
  });
});

describe('Provider intake distribution', () => {
  it('round-robins an ingested lead across the mapped team’s Telecallers only', () => {
    expect(distributionMigration).toContain('public.ingest_provider_lead(');
    expect(distributionMigration).toContain("intake_role.role_key = ''telecaller_bdc''");
    expect(distributionMigration).toContain('tm.last_fresh_assigned_at asc nulls first');
    expect(distributionMigration).toContain('PROVIDER_INTAKE_ROUND_ROBIN_PATCH_TARGET_NOT_FOUND');
  });

  it('lets the system-owned handoff status land without tripping the Telecaller guard', () => {
    expect(distributionMigration).toContain('app_private.enforce_role_lead_lifecycle');
    expect(distributionMigration).toContain(
      "new.lifecycle_status = 'Transferred to Sales'\n      and old.lifecycle_status = 'Qualified'",
    );
    expect(distributionMigration).toContain('TELECALLER_LIFECYCLE_FORBIDDEN');
  });
});

describe('Telecaller first contact', () => {
  it('records Call and WhatsApp as first contact and moves New to Contacted', () => {
    expect(distributionMigration).toContain('public.record_telecaller_lead_contact(');
    expect(distributionMigration).toContain("normalized_channel not in ('CALL', 'WHATSAPP')");
    expect(distributionMigration).toContain("role_row.role_key = 'telecaller_bdc'");
    expect(distributionMigration).toContain('TELECALLER_REQUIRED');
    expect(distributionMigration).toContain(
      "when target_lead.lifecycle_status = 'New' then 'Contacted'::public.lead_lifecycle",
    );
    expect(distributionMigration).toContain('first_contacted_at = coalesce(first_contacted_at,');
    expect(distributionMigration).toContain('LEAD_NOT_IN_INTAKE');
    expect(distributionMigration).toContain(
      'grant execute on function public.record_telecaller_lead_contact(uuid, text) to authenticated',
    );
  });

  it('fires that contact from the workspace Call and WhatsApp buttons', () => {
    expect(workspaceApi).toContain('record_telecaller_lead_contact');
    expect(workspace).toContain("onIntakeContact(row.original, 'CALL')");
    expect(workspace).toContain("onIntakeContact(row.original, 'WHATSAPP')");
    expect(workspace).toContain('recordTelecallerLeadContact');
  });
});

describe('Telecaller to Sales handoff', () => {
  it('offers every eligible Sales Consultant with the book they already carry', () => {
    expect(handoffMigration).toContain('public.get_sales_handoff_candidates(');
    expect(handoffMigration).toContain("role_row.role_key = 'sales_consultant'");
    expect(handoffMigration).toContain('member_row.eligible_for_qualified_leads');
    expect(handoffMigration).toContain("lead_row.lifecycle_status <> 'Lost'");
    expect(handoffMigration).toContain('as recommended');
  });

  it('auto-assigns to the consultant with the fewest open leads when none is picked', () => {
    expect(handoffMigration).toContain('public.transfer_lead_to_sales(');
    expect(handoffMigration).toContain('order by candidate.open_leads asc');
    expect(handoffMigration).toContain('candidate.last_qualified_assigned_at asc nulls first');
    expect(handoffMigration).toContain("selected_method := 'ROUND_ROBIN'");
    expect(handoffMigration).toContain("selected_method := 'MANUAL_ASSIGNMENT'");
    expect(handoffMigration).toContain('NO_ELIGIBLE_SALES_CONSULTANT');
    expect(handoffMigration).toContain('SALES_CONSULTANT_NOT_ELIGIBLE');
  });

  it('qualifies and assigns in one transaction, and audits the decision', () => {
    expect(handoffMigration).toContain("set lifecycle_status = 'Qualified'");
    expect(handoffMigration).toContain('insert into public.lead_stage_history');
    expect(handoffMigration).toContain('insert into public.lead_assignments');
    expect(handoffMigration).toContain('insert into public.lead_assignment_history');
    expect(handoffMigration).toContain("'QUALIFIED',");
    expect(handoffMigration).toContain('set last_qualified_assigned_at = handoff_at');
    expect(handoffMigration).toContain("'lead.sales_handoff_requested'");
    expect(handoffMigration).toContain('LEAD_ALREADY_WITH_SALES');
    expect(handoffMigration).toContain('LOST_LEAD_CANNOT_TRANSFER');
  });

  it('is reachable only for the owning Telecaller or a manager who may assign', () => {
    expect(handoffMigration).toContain('actor_is_owning_telecaller');
    expect(handoffMigration).toContain(
      "app_private.has_permission(current_organization_id, 'lead.assign')",
    );
    expect(workspace).toContain('canTransferToSales');
    expect(workspace).toContain("role === 'telecaller' && Boolean(permissions?.canUpdate)");
  });

  it('lets the Telecaller pick a consultant or take the auto recommendation', () => {
    expect(workspace).toContain('function SalesHandoffDialog');
    expect(workspace).toContain("const AUTO_SALES_HANDOFF = 'auto'");
    expect(workspace).toContain('Auto-assign · fewest open leads');
    expect(workspace).toContain('{consultant.open_leads} open');
    expect(workspace).toContain('userId: selection === AUTO_SALES_HANDOFF ? null : selection');
    expect(workspace).toContain('function canHandOffToSales');
    expect(workspaceApi).toContain('transfer_lead_to_sales');
    expect(workspaceApi).toContain('get_sales_handoff_candidates');
  });
});
