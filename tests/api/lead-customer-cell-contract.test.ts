import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const repair = readFileSync(
  'supabase/migrations/202609020019_undo_auto_linked_lead_customers.sql',
  'utf8',
);

const cell = workspace.slice(
  workspace.indexOf("header: 'Customer',"),
  workspace.indexOf("accessorKey: 'phone'"),
);

describe('customer name cell', () => {
  it('is plain text when the lead has no resolved customer', () => {
    // Leads start with customer_id null and are resolved deliberately, so most
    // rows have no Customer 360. Styling those as links offers a destination
    // that does not exist.
    expect(cell).toContain('if (!customerId)');
    // A span, never a Link. It truncates because Telecaller customer names are
    // long enough to push the table into a horizontal scroll, and carries a
    // `title` so the full name is still reachable once it ellipsizes.
    expect(cell).toContain('className="block truncate font-semibold text-foreground"');
    expect(cell).toContain('title={customerName}');
  });

  it('links to Customer 360 only when there is one to open', () => {
    expect(cell).toContain('href={customerDetailHref(role, customerId)}');
    // The old fallback sent the customer name to the lead page, which made the
    // name look like a Customer 360 link and land somewhere else.
    expect(cell).not.toContain('leadDetailHref(role, id)');
  });

  it('undoes the auto-created customers without destroying them', () => {
    // Soft delete: every read filters deleted_at, so they vanish from search
    // and Customer 360 while staying recoverable.
    expect(repair).toContain('set deleted_at = now()');
    expect(repair).not.toMatch(/delete\s+from\s+public\.customers/i);
    expect(repair).toContain('set customer_id = null');
  });

  it('identifies the backfilled rows structurally, not by timestamp', () => {
    expect(repair).toContain('customer_row.created_by is null');
    // The customer is newer than every lead pointing at it, which only happens
    // when it was manufactured for leads that already existed.
    expect(repair).toContain('lead_row.created_at >= customer_row.created_at');
  });

  it('refuses to run if the rule stops being narrow', () => {
    expect(repair).toContain('AUTO_LINKED_CUSTOMER_CLEANUP_SCOPE_TOO_BROAD');
    // A customer in use anywhere else is left alone.
    for (const table of ['customer_drip_enrollments', 'followups', 'appointments', 'calls'])
      expect(repair).toContain(`from public.${table} row_`);
  });
});
