import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610091424_reassign_sales_handoff.sql',
  'utf8',
);
const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const api = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');

function functionBody(signature: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${signature}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('$function$;', start));
}

describe('reassign_sales_handoff: cancel a transfer straight to another consultant', () => {
  const reassign = functionBody('public.reassign_sales_handoff');

  it('is only for the telecaller who handed the lead to Sales', () => {
    expect(reassign).toContain(
      'if not app_private.is_telecaller_handoff_viewer(current_organization_id, target_lead.id, auth.uid()) then',
    );
    expect(reassign).toContain("message = 'HANDOFF_ORIGINAL_TELECALLER_REQUIRED'");
    expect(reassign).toContain(
      "app_private.has_permission(current_organization_id, 'lead.update')",
    );
  });

  it('requires a reason and an eligible, different consultant in the lead’s team', () => {
    expect(reassign).toContain("message = 'HANDOFF_CANCELLATION_REASON_REQUIRED'");
    expect(reassign).toContain("message = 'SALES_CONSULTANT_UNCHANGED'");
    expect(reassign).toContain('and member_row.team_id = target_lead.team_id');
    expect(reassign).toContain('and member_row.eligible_for_qualified_leads');
    expect(reassign).toContain("and role_row.role_key = 'sales_consultant'");
    expect(reassign).toContain("message = 'SALES_CONSULTANT_NOT_ELIGIBLE'");
  });

  it('keeps the lead’s stage and history, changing only the owner', () => {
    expect(reassign).toContain(
      "target_lead.lifecycle_status not in ('Transferred to Sales', 'Appointment Scheduled')",
    );
    expect(reassign).not.toMatch(/set lifecycle_status/);
    for (const table of ['bookings', 'quotations', 'test_drives', 'appointments']) {
      expect(reassign).not.toMatch(new RegExp(`(delete from|update) public\\.${table}`));
    }
  });

  it('writes the assignment, history, follow-up move, activity and audit row', () => {
    expect(reassign).toContain(
      "target_user_id, 'QUALIFIED', 'MANUAL_ASSIGNMENT', auth.uid(), normalized_reason",
    );
    expect(reassign).toContain('insert into public.lead_assignment_history');
    expect(reassign).toContain('and followup_row.assigned_user_id = target_lead.assigned_user_id');
    expect(reassign).toContain("'SALES_HANDOFF_REASSIGNED', auth.uid(),");
    expect(reassign).toContain("'lead.sales_handoff_reassigned'");
  });

  it('is not callable by anon', () => {
    expect(migration).toContain(
      'revoke all on function public.reassign_sales_handoff(uuid, uuid, text) from public, anon;',
    );
  });
});

describe('the surrounding functions follow the move', () => {
  it('lets the handoff telecaller list consultants', () => {
    expect(functionBody('public.get_sales_handoff_candidates')).toContain(
      'if app_private.is_telecaller_handoff_viewer(target_lead.organization_id, target_lead.id, auth.uid())',
    );
  });

  it('still finds the telecaller’s handoff after a move between consultants', () => {
    const cancel = functionBody('public.cancel_sales_handoff');
    expect(cancel).toContain('and history_row.new_owner_id is not null');
    expect(cancel).not.toContain('and history_row.new_owner_id = target_lead.assigned_user_id');
  });

  it('titles the move in the timeline with both consultants', () => {
    const journey = functionBody('public.get_lead_journey');
    expect(journey).toContain("|| ' cancelled, moved to ' || coalesce(next_consultant.full_name");
    expect(journey).toContain(
      "next_consultant.id::text = activity_row.metadata->>'new_sales_consultant_id'",
    );
  });
});

describe('Cancel transfer dialog', () => {
  it('asks who takes the lead and moves it in one press', () => {
    expect(api).toContain("rpc('reassign_sales_handoff'");
    expect(workspace).toContain("const RETURN_TO_TELECALLER = 'return-to-me';");
    expect(workspace).toContain('consultant.user_id !== lead?.assigned_user_id');
    expect(workspace).toContain('disabled={mutation.isPending || !reason.trim() || !nextOwner}');
  });
});
