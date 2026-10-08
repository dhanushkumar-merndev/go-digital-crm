import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '202610080201_customer_phone_enquiries.sql'),
  'utf8',
);
const matchDialog = readFileSync(
  join(process.cwd(), 'src', 'features', 'customers', 'customer-match-dialog.tsx'),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('possible customer matches with lead context', () => {
  const matching = section(
    'create function public.possible_customer_matches(',
    'create function public.get_customer_phone_enquiries(',
  );

  it('keeps the existing permission and record-scope checks', () => {
    expect(matching).toContain(
      "app_private.has_permission(lead_row.organization_id, 'customer.view')",
    );
    expect(matching).toContain(
      "app_private.has_permission(lead_row.organization_id, 'customer.link')",
    );
    expect(matching).toContain('app_private.can_access_record(');
    expect(matching).toContain("message = 'PERMISSION_DENIED'");
  });

  it('adds a lead count and latest model without exposing other leads contact data', () => {
    expect(matching).toContain('lead_count bigint');
    expect(matching).toContain('latest_interested_model text');
    expect(matching).not.toMatch(/linked_lead\.(phone|email|normalized_phone)/);
  });

  it('is re-granted to authenticated only after the drop', () => {
    expect(migration).toContain(
      'revoke all on function public.possible_customer_matches(uuid) from public, anon;',
    );
    expect(migration).toContain(
      'grant execute on function public.possible_customer_matches(uuid) to authenticated, service_role;',
    );
  });
});

describe('customer phone enquiries', () => {
  const enquiries = section(
    'create function public.get_customer_phone_enquiries(',
    'revoke all on function public.get_customer_phone_enquiries(uuid)',
  );

  it('denies callers who cannot open the Customer 360', () => {
    expect(enquiries).toContain(
      'app_private.customer_360_visible(target_organization_id, target_customer_id)',
    );
    expect(enquiries).toContain("message = 'PERMISSION_DENIED'");
    expect(enquiries).toContain("message = 'CUSTOMER_NOT_FOUND'");
  });

  it('stays inside the tenant and the caller lead scope', () => {
    expect(enquiries).toContain('lead_row.organization_id = target_organization_id');
    expect(enquiries).toContain("array['lead.view']::text[]");
    expect(enquiries).toContain('lead_scope.organization_wide');
    expect(enquiries).toContain('lead_row.branch_id = any(lead_scope.branch_scope_ids)');
    expect(enquiries).toContain('lead_row.assigned_user_id = auth.uid()');
  });

  it('lists only leads not already linked to this customer, and never links them itself', () => {
    expect(enquiries).toContain('lead_row.customer_id is distinct from target_customer_id');
    expect(enquiries).not.toMatch(/\bupdate public\.leads\b/);
    expect(enquiries).not.toMatch(/\binsert into\b/);
  });

  it('offers Link only for an unlinked lead the caller may link', () => {
    expect(enquiries).toContain('lead_row.customer_id is null');
    expect(enquiries).toContain(
      "app_private.has_permission(target_organization_id, 'customer.link')",
    );
  });

  it('is not callable anonymously', () => {
    expect(migration).toContain(
      'revoke all on function public.get_customer_phone_enquiries(uuid) from public, anon;',
    );
  });
});

describe('customer match dialog decision', () => {
  it('does not default to creating a new customer when candidates exist', () => {
    expect(matchDialog).toContain('useState<string | null>(null)');
    expect(matchDialog).toContain('!effectiveResolution ||');
    expect(matchDialog).not.toContain("useState<'LINK_EXISTING' | 'CREATE_NEW'>('CREATE_NEW')");
  });
});
