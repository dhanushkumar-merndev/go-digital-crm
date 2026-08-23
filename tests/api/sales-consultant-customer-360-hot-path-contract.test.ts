import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608220006_sales_consultant_customer_360_hot_path.sql',
  'utf8',
);
const legacyMigration = readFileSync(
  'supabase/migrations/202608150011_customer_workspace.sql',
  'utf8',
);
const api = readFileSync('src/features/customers/customer-workspace-api.ts', 'utf8');
const workspace = readFileSync('src/features/customers/customer-360-workspace.tsx', 'utf8');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

const scopeHelper = section(
  'create or replace function app_private.sales_consultant_customer_scope(',
  'revoke all on function app_private.sales_consultant_customer_scope(uuid)',
);
const coreRpc = section(
  'create or replace function public.get_sales_consultant_customer_360_core(',
  'revoke all on function public.get_sales_consultant_customer_360_core(uuid)',
);
const sectionRpc = section(
  'create or replace function public.get_sales_consultant_customer_360_section(',
  'revoke all on function public.get_sales_consultant_customer_360_section(',
);

describe('Sales Consultant Customer 360 hot path', () => {
  it('keeps the legacy RPC intact and adds separate focused Sales contracts', () => {
    expect(legacyMigration).toContain(
      'create or replace function public.get_customer_360(target_customer_id uuid)',
    );
    expect(migration).not.toContain('alter function public.get_customer_360');
    expect(migration).not.toContain('drop function public.get_customer_360');
    expect(migration).toContain('get_sales_consultant_customer_360_core(uuid)');
    expect(migration).toContain(
      'get_sales_consultant_customer_360_section(\n  uuid, text, integer, integer, timestamptz, uuid',
    );
  });

  it('fails closed behind Sales CRM context, customer.view, and direct customer ownership', () => {
    expect(scopeHelper).toContain("access_context->>'destination' <> 'CRM'");
    expect(scopeHelper).toContain("access_context->>'role_key' <> 'sales-consultant'");
    expect(scopeHelper.match(/app_private\.sales_consultant_permissions\(/g)).toHaveLength(1);
    expect(scopeHelper).toContain("not ('customer.view' = any(current_permission_keys))");
    expect(scopeHelper).toContain('customer_row.organization_id = current_organization_id');
    expect(scopeHelper).toContain('lead_row.customer_id = customer_row.id');
    expect(scopeHelper).toContain('lead_row.assigned_user_id = auth.uid()');
    expect(scopeHelper).toContain('lead_row.branch_id = any(allowed_branch_ids)');
    expect(scopeHelper).toContain('lead_row.deleted_at is null');
    expect(migration).toContain(
      'app_private.sales_consultant_customer_scope(uuid)\n  from public, anon, authenticated',
    );
  });

  it('returns only bounded overview data and does not run eager module queries', () => {
    expect(coreRpc).toContain('limit 1');
    expect(coreRpc).toContain('limit 25');
    expect(coreRpc).toContain('limit 10');
    expect(coreRpc).toContain('limit 50');
    expect(coreRpc).toContain('limit 8');
    expect(coreRpc).toContain('25 is a deliberate guard');
    expect(coreRpc).toContain('renders at most eight');
    for (const table of [
      'public.calls',
      'public.conversations',
      'public.followups',
      'public.appointments',
      'public.test_drives',
      'public.quotations',
      'public.bookings',
      'public.object_files',
      'public.activities',
    ]) {
      expect(coreRpc).not.toContain(`from ${table}`);
    }
    expect(coreRpc).toContain("'section_access', jsonb_build_object(");
  });

  it('allowlists sections, validates 25/50/100 pages, and checks each domain permission', () => {
    expect(sectionRpc).toContain('target_page not between 1 and 1000000');
    expect(sectionRpc).toContain('target_page_size not in (25, 50, 100)');
    for (const value of [
      'LEADS',
      'CALLS',
      'CONVERSATIONS',
      'FOLLOWUPS',
      'APPOINTMENTS',
      'TEST_DRIVES',
      'QUOTATIONS',
      'BOOKINGS',
      'VEHICLES',
      'DOCUMENTS',
      'TIMELINE',
    ]) {
      expect(sectionRpc).toContain(`'${value}'`);
    }
    for (const permission of [
      'lead.view',
      'call.view',
      'message.view',
      'followup.view',
      'appointment.view',
      'test_drive.manage',
      'quotation.manage',
      'booking.manage',
      'document.download',
    ]) {
      expect(sectionRpc).toContain(`'${permission}'`);
    }
    expect(sectionRpc).toContain("message = 'CUSTOMER_360_SECTION_DENIED'");
  });

  it('uses direct owner/org/customer/branch scope and enriches bounded call pages set-wise', () => {
    for (const predicate of [
      'organization_id = current_organization_id',
      'customer_id = target_customer_id',
      'assigned_user_id = auth.uid()',
      'branch_id = any(allowed_branch_ids)',
    ]) {
      expect(sectionRpc).toContain(predicate);
    }
    const callSection = sectionRpc.slice(
      sectionRpc.indexOf("elsif normalized_section = 'CALLS'"),
      sectionRpc.indexOf("elsif normalized_section = 'CONVERSATIONS'"),
    );
    expect(callSection).toContain('page_calls as materialized');
    expect(callSection.indexOf('limit target_page_size offset offset_rows')).toBeLessThan(
      callSection.indexOf('recordings as materialized'),
    );
    expect(callSection).toContain('join page_calls call_row');
    expect(callSection).not.toContain('join lateral');
    expect(sectionRpc).not.toContain('app_private.can_access_record(');
    expect(sectionRpc).not.toContain('app_private.can_access_customer(');
  });

  it('uses a bounded stable timeline cursor and never returns storage locators', () => {
    expect(sectionRpc).toContain("normalized_section <> 'TIMELINE'");
    expect(sectionRpc).toContain(
      '(activity_row.occurred_at, activity_row.id)\n            < (target_cursor_at, target_cursor_id)',
    );
    expect(sectionRpc).toContain('limit target_page_size + 1');
    expect(sectionRpc).toContain(
      'select id, lead_id, activity_type, actor_name, occurred_at\n      from page_source',
    );
    expect(sectionRpc).not.toMatch(/select\s+(?:[a-z_]+\.)?\*/i);
    expect(sectionRpc).toContain("'next_cursor', case");
    expect(sectionRpc).not.toContain("'object_key'");
    expect(sectionRpc).not.toContain("'bucket'");
    expect(sectionRpc).not.toContain('transcript_text');
  });
});

describe('Sales Consultant Customer 360 client boundary', () => {
  it('loads core first and only the active lazy section with cancellation', () => {
    expect(api).toContain("rpc('get_sales_consultant_customer_360_core'");
    expect(api).toContain("rpc('get_sales_consultant_customer_360_section'");
    expect(api.match(/request\.abortSignal\(signal\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(workspace).toContain('enabled: !useSalesBootstrap && Boolean(permissions?.canView)');
    expect(workspace).toContain('fetchSalesCustomer360Core(customerId, signal)');
    expect(workspace).toContain('fetchSalesCustomer360Section(');
    expect(workspace).toContain("activeTab === 'overview' ? null : lazySectionByTab[activeTab]");
  });

  it('keys section queries by scope, customer, section, page, and filters', () => {
    expect(workspace).toContain("'customer-360',");
    expect(workspace).toContain('customerId,');
    expect(workspace).toContain("lazySection ?? 'overview'");
    expect(workspace).toContain('sectionPage,');
    expect(workspace).toContain('sectionFilters,');
    expect(workspace).toContain('[25, 50, 100].map');
    expect(workspace).toContain('timelineCursors[sectionPage]');
  });
});
