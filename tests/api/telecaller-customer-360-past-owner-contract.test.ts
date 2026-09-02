import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202609020003_telecaller_customer_360_past_owner_access.sql',
  'utf8',
);
const handoff = readFileSync(
  'supabase/migrations/202608310005_telecaller_sales_handoff_assignment.sql',
  'utf8',
);

describe('Telecaller Customer 360 after a sales handoff', () => {
  it('still moves lead ownership on handoff, which is what this migration compensates for', () => {
    // If the handoff ever stopped reassigning the lead, the past-owner rule
    // below would be dead code rather than the fix for a live dead end.
    expect(handoff).toContain('set assigned_user_id = selected_user_id');
    expect(handoff).toContain('previous_owner_id');
  });

  it('reads ownership as "owns or has owned" from both assignment tables', () => {
    expect(migration).toContain('create or replace function app_private.has_owned_lead(');
    // lead_assignments carries the deactivated row for a previous owner;
    // lead_assignment_history names the outgoing owner on every transfer.
    expect(migration).toContain('from public.lead_assignments assignment_row');
    expect(migration).toContain('from public.lead_assignment_history history_row');
    expect(migration).toContain('history_row.previous_owner_id = auth.uid()');
    expect(migration).toContain('assignment_row.assigned_user_id = auth.uid()');
  });

  it('answers customer visibility from one function on both surfaces', () => {
    // The dead end was Customer 360 and the header lookup disagreeing.
    expect(migration).toContain('create or replace function app_private.customer_360_visible(');
    const mentions = migration.match(/app_private\.customer_360_visible\(/g) ?? [];
    // Definition, revoke, the call in get_customer_360, the call in the lookup.
    expect(mentions.length).toBe(4);
    expect(migration).toContain(
      'if not app_private.customer_360_visible(target_organization_id, target_customer_id) then',
    );
    expect(migration).toContain(
      'and app_private.customer_360_visible(customer_row.organization_id, customer_row.id)',
    );
  });

  it('keeps the hardened scope rule everywhere except the own-records arm', () => {
    // customer.view scope must still come from an assignment that grants it,
    // and still has to reach an active branch.
    expect(migration).toContain("array['customer.view']::text[]");
    expect(migration).toContain('customer_branch_row.active');
    expect(migration).toContain('customer_lead_row.branch_id = any(scope_row.branch_scope_ids)');
    expect(migration).toContain('customer_lead_row.team_id = any(scope_row.team_scope_ids)');
    expect(migration).toContain('scope_row.own_record_branch_ids');
  });

  it('fails closed when the scope record is null or absent', () => {
    // Callers test this with `if not ...`; a NULL there would skip the raise
    // and hand out the customer.
    expect(migration).toContain('bool_or(');
    expect(migration).toMatch(
      /\)\s*,\s*\n\s*false\s*\n\s*\)\s*\n\s*from customer_scope scope_row;/,
    );
  });

  it('widens can_access_customer additively so no caller loses access', () => {
    // It guards the legacy Customer 360 body and the customer RLS policies, so
    // every existing branch has to survive untouched.
    for (const scope of [
      'ORGANIZATION',
      'ALL_BRANCHES',
      'OWN_TEAM',
      'ONE_BRANCH',
      'SELECTED_BRANCHES',
    ])
      expect(migration).toContain(scope);
    expect(migration).toContain('app_private.has_active_approved_support_session');
    expect(migration).toContain(
      'or app_private.has_owned_lead(target_organization_id, lead_row.id)',
    );
  });

  it('keeps the private helpers unreachable from the client', () => {
    for (const helper of ['has_owned_lead(uuid, uuid)', 'customer_360_visible(uuid, uuid)'])
      expect(migration).toContain(
        `revoke all on function app_private.${helper}\n  from public, anon, authenticated;`,
      );
    expect(migration).toContain(
      'grant execute on function public.get_customer_360(uuid) to authenticated;',
    );
    expect(migration).toContain(
      'grant execute on function public.search_authorized_customers(text, integer, integer) to authenticated;',
    );
  });

  it('runs as one transaction', () => {
    expect(migration.startsWith('begin;')).toBe(true);
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
  });
});
