import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/202610090491_lead_journey.sql', 'utf8');
const journeyComponent = readFileSync('src/features/leads/lead-journey.tsx', 'utf8');
const customerWorkspace = readFileSync('src/features/customers/customer-360-workspace.tsx', 'utf8');
const customerApi = readFileSync('src/features/customers/customer-workspace-api.ts', 'utf8');
const leadDetail = readFileSync('src/features/leads/lead-detail-workspace.tsx', 'utf8');

describe('lead journey', () => {
  it('requires a visible lead before returning any event', () => {
    expect(migration).toContain(
      "if not app_private.has_permission(org, 'lead.view') or not app_private.can_access_lead(lead_row.id) then",
    );
    expect(migration).toContain("message = 'PERMISSION_DENIED'");
    expect(migration).toContain("message = 'AUTHENTICATION_REQUIRED'");
  });

  it('gates every event family on its own module permission', () => {
    for (const gate of [
      'where call_access and',
      'where followup_access and',
      'where appointment_access and',
      'where test_drive_access and',
      'where quotation_access and',
      'where booking_access and',
      'where message_access and',
    ]) {
      expect(migration).toContain(gate);
    }
  });

  it('shows call notes and AI summaries only to callers who can open that call', () => {
    expect(migration).toContain(
      'case when app_private.can_access_call(org, call_row.id) then jsonb_strip_nulls(jsonb_build_object(',
    );
    expect(migration).toContain("else '{}'::jsonb end as extra");
  });

  it('pages with a keyset cursor and caps the page size', () => {
    expect(migration).toContain('(occurred_at, id) < (target_cursor_at, target_cursor_id)');
    expect(migration).toContain('least(greatest(coalesce(target_limit, 50), 1), 100)');
    expect(journeyComponent).toContain('getNextPageParam: (page) => page.next_cursor');
  });

  it('does not repeat structured events through their activity rows', () => {
    for (const duplicate of ['LEAD_RECEIVED', 'FOLLOWUP_SCHEDULED', 'BOOKING_CREATED']) {
      expect(migration).toMatch(new RegExp(`activity_type not in \\([^)]*'${duplicate}'`, 's'));
    }
  });

  it('is the timeline on both lead detail and Customer 360', () => {
    expect(leadDetail).toContain('<LeadJourney leadId={lead.id} />');
    expect(customerWorkspace).toContain('<LeadJourney leadId={option.id} />');
  });
});

describe('Customer 360 lead scope', () => {
  it('filters Sales Consultant sections by lead in SQL, not in the browser', () => {
    expect(migration).toContain('target_lead_id uuid DEFAULT NULL::uuid)');
    expect(migration).toContain("execute 'drop function ' || old_signature::text");
    expect(customerApi).toContain('target_lead_id: input.leadId ?? null');
    expect(customerWorkspace).toContain('filterRecordsByLead={!useSalesHotPath}');
  });

  it('reads messages one enquiry at a time', () => {
    expect(customerWorkspace).toContain(
      "lazySection !== 'conversations' || Boolean(messageLeadId)",
    );
    expect(customerWorkspace).toContain('allowAll={false}');
  });
});
