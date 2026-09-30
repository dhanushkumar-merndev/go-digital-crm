import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260928175900_restore_create_lead_intake_and_explicit_customer.sql',
  ),
  'utf8',
);

describe('create_lead restored after the out-of-band replacement', () => {
  it('rebuilds from the documented lineage and refuses to deploy an incomplete rebuild', () => {
    expect(migration).toContain('create or replace function public.create_lead(');
    expect(migration).toContain('EXPLICIT_CUSTOMER_RESOLUTION_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain('TELECALLER_CREATE_LEAD_INTAKE_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain('CREATE_LEAD_ROUND_ROBIN_TELECALLER_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain("message = 'CREATE_LEAD_LINEAGE_REBUILD_INCOMPLETE'");
  });

  it('never links a new lead to a customer by phone', () => {
    expect(migration).toContain("or position('resolved_customer_id' in definition) > 0");
    expect(migration).toContain("or position('lead_phone_digits' in definition) > 0");
    expect(migration).not.toContain('Match on phone digits to prevent duplicate customer records');
  });

  it('keeps a Telecaller-typed lead at New and only hands off a Sales Consultant lead', () => {
    expect(migration).toContain("if position('actor_is_sales_consultant' in definition) = 0");
    expect(migration).toContain("intake_role.role_key = ''telecaller_bdc''");
  });

  it('repairs only the rows the replacement wrote, bounded and audited', () => {
    expect(migration).toContain("window_start constant timestamptz := '2026-09-28 09:45:39+00';");
    expect(migration).toContain("message = 'AUTO_LINK_REPAIR_SCOPE_TOO_BROAD'");
    expect(migration).toContain("message = 'FALSE_HANDOFF_RESET_SCOPE_TOO_BROAD'");
    expect(migration).toContain(
      "and activity_row.activity_type in ('CUSTOMER_LINKED', 'CUSTOMER_CREATED_AND_LINKED')",
    );
    expect(migration).toContain('set deleted_at = now(),');
    expect(migration).not.toMatch(/delete from public\.customers/);
    expect(migration).toContain("'lead.out_of_band_create_lead_repaired'");
  });
});
