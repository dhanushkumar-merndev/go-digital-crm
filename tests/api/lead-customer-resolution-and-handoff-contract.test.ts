import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const explicitResolution = readFileSync(
  'supabase/migrations/202609020013_restore_explicit_customer_resolution.sql',
  'utf8',
);
const handoffVisibility = readFileSync(
  'supabase/migrations/202609020014_telecaller_handoff_read_only_visibility.sql',
  'utf8',
);
const handoffProjectionFix = readFileSync(
  'supabase/migrations/202609020015_fix_handoff_read_only_projection.sql',
  'utf8',
);
const listUi = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const detailUi = readFileSync('src/features/leads/lead-detail-workspace.tsx', 'utf8');
const customerMatchDialog = readFileSync(
  'src/features/customers/customer-match-dialog.tsx',
  'utf8',
);
const requireCustomerBeforeHandoff = readFileSync(
  'supabase/migrations/202609190001_require_customer_before_sales_handoff.sql',
  'utf8',
);

describe('explicit lead customer resolution', () => {
  it('leaves new enquiries unlinked instead of resolving a phone automatically', () => {
    expect(explicitResolution).toContain('Phone and email are customer match signals');
    expect(explicitResolution).toContain('Customer identity is resolved explicitly after creation');
    expect(explicitResolution).toContain(
      "'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure",
    );
    expect(explicitResolution).toContain(
      "position('resolved_customer_id' in updated_definition) > 0",
    );
    expect(explicitResolution).toContain("position('lead_phone_digits' in updated_definition) > 0");
  });

  it('surfaces the reviewed match workflow in both lead list and lead details', () => {
    expect(listUi).toContain('Review possible customer match for');
    expect(listUi).toContain('onMatchCustomer(row.original)');
    expect(detailUi).toContain('Review possible customer');
    expect(detailUi).toContain('<CustomerMatchDialog');
    expect(detailUi).toContain("hasWorkspacePermission(workspaceSession, 'customer.link')");
    expect(detailUi).toContain("hasWorkspacePermission(workspaceSession, 'customer.create')");
  });

  it('shows customer details directly instead of a duplicate create button', () => {
    expect(customerMatchDialog).not.toContain('Create a separate customer UUID');
    expect(customerMatchDialog).toContain("useState<'LINK_EXISTING' | 'CREATE_NEW'>('CREATE_NEW')");
    expect(customerMatchDialog).toContain("setResolution('CREATE_NEW')");
  });
});

describe('Telecaller sales handoff history', () => {
  it('proves the actor was the outgoing Telecaller from immutable history', () => {
    expect(handoffVisibility).toContain(
      'create or replace function app_private.is_telecaller_handoff_viewer(',
    );
    expect(handoffVisibility).toContain("role_row.role_key = 'telecaller_bdc'");
    expect(handoffVisibility).toContain('history_row.previous_owner_id = target_actor_id');
    expect(handoffVisibility).toContain("stage_row.to_status = 'Transferred to Sales'");
    expect(handoffVisibility).toContain(
      'lead_row.assigned_user_id is distinct from target_actor_id',
    );
  });

  it('keeps handoffs in history views without returning them to active ownership', () => {
    expect(handoffVisibility).toContain(
      "target_status in (''all'', ''transferred-to-sales'', ''starred'')",
    );
    expect(handoffVisibility).toContain("''read_only'', is_handoff_read_only");
    expect(handoffVisibility).toContain("'public.get_lead_phone_history(uuid)'::regprocedure");
    expect(handoffVisibility).not.toContain('set assigned_user_id = target_actor_id');
    expect(handoffProjectionFix).toContain('stage_row.is_handoff_read_only');
    expect(handoffProjectionFix).toContain('HANDOFF_READ_ONLY_PROJECTION_PATCH_TARGET_NOT_FOUND');
  });

  it('makes list and detail mutations unavailable but keeps navigation usable', () => {
    expect(handoffVisibility).toContain("''read_only'', handoff_read_only");
    expect(handoffVisibility).toContain('can_update := not handoff_read_only');
    expect(listUi).toContain('Open read-only lead details');
    expect(listUi).toContain('Read only');
    expect(detailUi).toContain('!data.access.read_only');
    expect(detailUi).toContain('Open customer 360');
  });

  it('keeps the private evidence helper unreachable from clients', () => {
    expect(handoffVisibility).toContain(
      'revoke all on function app_private.is_telecaller_handoff_viewer(uuid, uuid, uuid)',
    );
  });
});

describe('customer is required before a sales handoff', () => {
  it('refuses a transfer whose lead still has no customer UUID', () => {
    // Sales opens Customer 360, the vehicle history and the earlier purchases,
    // all of which hang off customers.id. A handoff without one gives the
    // consultant an enquiry and no customer.
    expect(requireCustomerBeforeHandoff).toContain("message = ''LEAD_CUSTOMER_REQUIRED''");
    expect(requireCustomerBeforeHandoff).toContain('target_lead.customer_id is null');
    expect(requireCustomerBeforeHandoff).toContain('pg_get_functiondef(');
    // Re-running the migration must not stack a second copy of the guard.
    expect(requireCustomerBeforeHandoff).toContain(
      "if position('LEAD_CUSTOMER_REQUIRED' in current_definition) > 0 then",
    );
    expect(requireCustomerBeforeHandoff).toContain('LEAD_CUSTOMER_REQUIRED_PATCH_TARGET_NOT_FOUND');
  });

  it('hides the action and explains the block rather than failing at submit', () => {
    expect(listUi).toContain('Boolean(lead.customer_id)');
    expect(listUi).toContain('salesHandoffBlockedReason');
    expect(listUi).toContain('Link or create the customer first, then transfer to Sales');
    expect(listUi).toContain("message.includes('LEAD_CUSTOMER_REQUIRED')");
  });
});

describe('customer match review with no candidate', () => {
  it('stops presenting a review when there is nothing to review', () => {
    expect(customerMatchDialog).toContain('nothingToReview');
    expect(customerMatchDialog).toContain("'Create customer' : 'Review possible customer match'");
    expect(customerMatchDialog).toContain('No existing customer shares this phone or email');
  });

  it('still writes a decision reason to the audit trail without demanding one', () => {
    // resolve_lead_customer requires a 3-500 character reason on every
    // decision, so the no-candidate path states the fact rather than asking
    // the telecaller to justify a choice they were never offered.
    expect(customerMatchDialog).toContain('const NO_MATCH_REASON =');
    expect(customerMatchDialog).toContain('<input type="hidden" name="reason"');
    expect(customerMatchDialog).toContain('Recorded on the customer decision audit trail as:');
  });
});
