import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../supabase/migrations/202609020001_group_leads_by_phone.sql', import.meta.url),
  'utf8',
);
const api = readFileSync(
  new URL('../../src/features/leads/lead-workspace-api.ts', import.meta.url),
  'utf8',
);

describe('lead phone grouping boundary', () => {
  it('pages one newest representative per normalized phone without merging leads', () => {
    expect(migration).toContain('phone_group_lead_ids as materialized');
    expect(migration).toContain(
      "coalesce(nullif(lead_row.normalized_phone, ''''), lead_row.id::text)",
    );
    expect(migration).toContain('lead_row.created_at desc');
    expect(migration).toContain('from phone_group_lead_ids lead_row');
    expect(migration).toContain('select count(*) from phone_group_lead_ids');
    expect(migration).toContain("''lead_total''");
    expect(migration).not.toContain('update public.leads');
    expect(migration).not.toContain('update public.customers');
  });

  it('loads every visible stage for the phone through a bounded scoped RPC', () => {
    expect(migration).toContain(
      'create or replace function public.get_lead_phone_history(target_lead_id uuid)',
    );
    expect(migration).toContain('app_private.resolve_sales_lead_workspace_scope');
    expect(migration).toContain('lead_row.normalized_phone = anchor_phone');
    expect(migration).toContain("when lead_row.lifecycle_status = 'Lost' then 'Lost'");
    expect(migration).toContain('limit 100');
    expect(migration).toContain('LEAD_WORKSPACE_ACCESS_REQUIRED');
    expect(api).toContain("supabase.rpc('get_lead_phone_history'");
  });
});
