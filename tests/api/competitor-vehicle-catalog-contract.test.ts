import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202608220047_competitor_vehicle_catalog.sql'),
  'utf8',
);
describe('competitor vehicle catalog contract', () => {
  it('stores explicit tenant-owned competitor specification data instead of inferring it from feedback text', () => {
    expect(migration).toContain('create table public.competitor_vehicle_profiles');
    expect(migration).toContain('specifications jsonb');
    expect(migration).toContain('advantages jsonb');
    expect(migration).toContain('unique (organization_id, manufacturer, model, variant)');
    expect(migration).toContain('force row level security');
  });
  it('separates sales read access from MFA-assured Client Admin catalog management and audits writes', () => {
    expect(migration).toContain('list_sales_competitor_profiles()');
    expect(migration).toContain("role_row.role_key = 'sales_consultant'");
    expect(migration).toContain('save_competitor_vehicle_profile(');
    expect(migration).toContain("role_row.role_key = 'client_admin'");
    expect(migration).toContain('app_private.mfa_policy_satisfied(current_organization_id)');
    expect(migration).toContain("'competitor_profile.saved'");
    expect(migration).toContain('list_competitor_vehicle_profiles()');
    expect(migration).toContain('get_sales_competitor_comparison_options()');
  });
});
