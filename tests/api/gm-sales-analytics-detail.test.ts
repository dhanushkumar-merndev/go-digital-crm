import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202610270157_gm_sales_analytics_detail.sql');
const api = source('src/features/dashboards/gm-sales-analytics-api.ts');
const workspace = source('src/features/dashboards/gm-sales-analytics-workspace.tsx');
const chart = source('src/components/charts/e-chart.tsx');
const leadWorkspace = source('src/features/leads/lead-workspace.tsx');
const salesDocuments = source('src/features/sales/sales-document-workspace.tsx');
const pageSpecs = source('src/config/page-specs.ts');

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

const analytics = functionBody('public.get_gm_sales_analytics_workspace');
const targets = functionBody('public.get_gm_target_workspace');

describe('GM sales analytics migration', () => {
  it('runs as one transaction and keeps the GM gate', () => {
    expect(migration).toContain('\nbegin;\n');
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
    expect(analytics).toContain("access_context->>'role_key' <> 'gm-sales'");
    expect(analytics).toContain("message = 'GM_SALES_BRANCH_SCOPE_REQUIRED'");
    expect(targets).toContain("message = 'GM_TARGET_ACCESS_REQUIRED'");
  });

  it('ranks sales consultants only', () => {
    expect(analytics).toContain("and member_row.member_type = 'SALES_CONSULTANT'");
    expect(analytics).not.toContain("member_type in ('SALES_CONSULTANT', 'TELECALLER_BDC')");
  });

  it('credits drives, quotations and bookings to the model the enquiry asked for', () => {
    expect(analytics).toContain('model_activity as (');
    for (const key of ["'test_drives', model_row.test_drives", "'bookings', model_row.bookings"])
      expect(analytics).toContain(key);
    expect(analytics).toContain("'lost', model_row.lost");
  });

  it('shows stock only to callers who may check it', () => {
    expect(analytics).toContain("array['inventory.view', 'inventory.stock_check']::text[]");
    expect(analytics).toContain('stock_row.branch_id = any(stock_branch_ids)');
    expect(analytics).toContain("'stock_visible', cardinality(stock_branch_ids) > 0");
  });

  it('adds contacted, qualified and branch lost counts', () => {
    expect(analytics).toContain("'contacted', (select contacted from lead_funnel)");
    expect(analytics).toContain("'qualified', (select qualified from lead_funnel)");
    expect(analytics).toContain("'lost', branch_row.lost");
    expect(analytics).toContain("history_row.to_status in ('Qualified', 'Transferred to Sales')");
  });

  it('resolves fully visible branches once in GM targets, keeping the per-record fallback', () => {
    expect(targets).toContain(
      'app_private.can_access_record(current_organization_id, branch_row.id, null, null)',
    );
    expect(targets.match(/= any\(branch_wide_ids\) then true/g)).toHaveLength(2);
    // Own-team and own-record scopes still reach the full check.
    expect(targets.match(/else app_private\.can_access_record\(/g)).toHaveLength(2);
  });
});

describe('GM pages', () => {
  it('reads the new fields as optional so cached responses still parse', () => {
    expect(api).toContain('contacted: z.coerce.number().int().nonnegative().optional()');
    expect(api).toContain('stock_visible: z.boolean().optional()');
    expect(api).toContain('available: z.coerce.number().int().nonnegative().nullable().optional()');
  });

  it('draws the PRD funnel and the showroom comparison charts', () => {
    expect(workspace).toContain("{ name: 'Contacted', value: kpis.contacted }");
    expect(workspace).not.toContain("{ name: 'Calls', value: data.kpis.calls }");
    expect(workspace).toContain('function ShowroomComparison(');
    expect(workspace).toContain("label: 'Sales consultant ranking'");
  });

  it('labels proportional funnels inside the band and every short bar axis', () => {
    expect(chart).toContain("position: 'inside'");
    expect(chart).toContain('const categoryLabels =');
  });

  it('keeps read-only pages free of create and manage actions', () => {
    expect(leadWorkspace).toContain(
      "!spec.readOnly && permissions?.canCreate && slug !== 'lost-leads'",
    );
    expect(salesDocuments).toContain('? { ...loadedPermissions, canManage: false }');
    expect(pageSpecs).toContain("slug.endsWith('-overview') && !slug.includes('booking')");
  });
});
