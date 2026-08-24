import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608240007_optimize_customer_care_workspace.sql');
const workspace = source('src/features/customer-care/customer-care-workspace.tsx');
const api = source('src/features/customer-care/customer-care-api.ts');

function section(startMarker: string, endMarker: string) {
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('customer-care 100k-scale query boundary', () => {
  const scope = section(
    'create or replace function app_private.customer_care_actor_scope(',
    'revoke all on function app_private.customer_care_actor_scope(uuid, text)',
  );
  const page = section(
    'create or replace function public.get_customer_care_workspace_page(',
    'create or replace function public.get_customer_care_customer_options(',
  );
  const options = section(
    'create or replace function public.get_customer_care_customer_options(',
    'create or replace function public.get_customer_care_dashboard_summary(',
  );
  const dashboard = section(
    'create or replace function public.get_customer_care_dashboard_summary(',
    'revoke all on function public.get_customer_care_workspace_page(',
  );

  it('binds the requested permission and customer visibility to the same assignment scope', () => {
    expect(scope).toContain('permission_row.permission_key = normalized_permission');
    expect(scope).toContain("permission_row.permission_key = 'customer.view'");
    expect(scope).toContain("assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')");
    expect(scope).toContain("assignment_row.data_scope = 'ONE_BRANCH'");
    expect(scope).toContain("assignment_row.data_scope = 'SELECTED_BRANCHES'");
    expect(scope).toContain("assignment_row.data_scope = 'OWN_RECORDS'");
    expect(scope).toContain("assignment_row.data_scope = 'OWN_TEAM'");
    expect(scope).toContain('access_row.active');
    expect(scope).toContain('member_row.active');
  });

  it('resolves scope once and uses direct predicates instead of per-row access helpers', () => {
    expect(page.match(/customer_care_actor_scope\(/g)).toHaveLength(1);
    expect(dashboard.match(/customer_care_actor_scope\(/g)).toHaveLength(1);
    expect(options.match(/customer_care_actor_scope\(/g)).toHaveLength(1);

    for (const sql of [page, dashboard, options]) {
      expect(sql).not.toContain('app_private.can_access_record(');
      expect(sql).not.toContain('app_private.can_access_customer(');
      expect(sql).not.toContain('app_private.can_access_lead(');
    }
    expect(page).toContain('case_row.branch_id = any(scope_branch_ids)');
    expect(dashboard).toContain('case_row.branch_id = any(scope_branch_ids)');
    expect(options).toContain('source_booking.branch_id = any(scope_branch_ids)');
    expect(page).toContain('followup_row.team_id = any(scope_team_ids)');
    expect(dashboard).toContain('drive_row.team_id = any(scope_team_ids)');
    expect(options).toContain('source_booking.team_id = any(scope_team_ids)');
  });

  it('pages lean case ids before enriching only visible records', () => {
    const pageIds = page.indexOf('page_ids as materialized (');
    const pageRows = page.indexOf('page_rows as materialized (');
    expect(pageIds).toBeGreaterThanOrEqual(0);
    expect(pageRows).toBeGreaterThan(pageIds);
    const leanPage = page.slice(pageIds, pageRows);
    expect(leanPage).toContain('select case_row.id');
    expect(leanPage).toContain('limit target_page_size');
    expect(leanPage).toContain('offset ((target_page - 1)::bigint * target_page_size)');
    expect(leanPage).not.toContain('join public.profiles');
    expect(leanPage).not.toContain('join public.customer_vehicles');
    expect(page.indexOf('join public.profiles profile_row')).toBeGreaterThan(pageRows);
    expect(page.indexOf('left join public.customer_vehicles vehicle_row')).toBeGreaterThan(
      pageRows,
    );
  });

  it('keeps bounded 25/50/100 server pagination and stable workspace JSON keys', () => {
    expect(page).toContain('target_page_size is null or target_page_size not in (25, 50, 100)');
    expect(page).toContain(
      "target_sort not in ('updated:desc', 'sla:asc', 'created:desc', 'priority:desc')",
    );
    expect(page).toContain('case_summary as (');
    expect(page).toContain('followup_summary as (');
    expect(page).toContain('created_activity as (');
    expect(page).toContain('resolved_activity as (');
    expect(page).not.toContain('timezone(target_timezone, followup_row.due_at)::date');
    expect(page).toContain('followup_row.due_at >= today_start');
    expect(page).toContain('followup_row.due_at < tomorrow_start');
    for (const key of [
      'organization_id',
      'records',
      'total',
      'kpis',
      'open',
      'followups_due',
      'feedback_pending',
      'review_pending',
      'complaints_open',
      'sla_risk',
      'resolved_today',
      'average_resolution_hours',
      'status_chart',
      'activity_chart',
    ]) {
      expect(page).toContain(`'${key}'`);
    }
  });

  it('returns a bounded dashboard queue and enriches only its 25 selected ids', () => {
    const dashboardIds = dashboard.indexOf('dashboard_ids as materialized (');
    const dashboardRows = dashboard.indexOf('dashboard_records as materialized (');
    expect(dashboardIds).toBeGreaterThanOrEqual(0);
    expect(dashboardRows).toBeGreaterThan(dashboardIds);
    expect(dashboard.slice(dashboardIds, dashboardRows)).toContain('limit 25');
    expect(dashboard.indexOf('join public.profiles profile_row')).toBeGreaterThan(dashboardRows);
    expect(dashboard).toContain('dashboard_summary as (');
    expect(dashboard).toContain('test_drive_summary as (');
    expect(dashboard).toContain("'records'");
    expect(dashboard).toContain("'attention'");
    expect(dashboard).toContain("'consultant_performance'");
    expect(dashboard).not.toContain('app_private.can_access_record(');
    expect(dashboard).not.toContain('app_private.can_access_customer(');
  });

  it('keeps create-dialog options bounded and uses direct booking/customer scope', () => {
    expect(options).toContain('target_limit is null or target_limit not between 1 and 25');
    expect(options).toContain("current_organization_id, 'customer_care.manage'");
    expect(options).toContain('limit target_limit');
    expect(options).toContain('limit 1');
    expect(options).toContain('authorized_customer_ids as materialized (');
    expect(options).not.toContain('app_private.can_access_record(');
    expect(options).not.toContain('app_private.can_access_customer(');
  });

  it('adds the missing organization, owner, type and activity indexes', () => {
    for (const indexName of [
      'customer_care_org_status_updated_page_idx',
      'customer_care_org_owner_status_updated_page_idx',
      'customer_care_org_type_status_updated_page_idx',
      'customer_care_org_created_activity_idx',
      'customer_care_org_resolved_activity_idx',
      'customer_care_case_number_trgm_idx',
      'bookings_booking_number_trgm_active_idx',
    ]) {
      expect(migration).toContain(`create index concurrently if not exists ${indexName}`);
    }
    const transactionStart = migration.indexOf('begin;');
    expect(migration.indexOf('create index concurrently')).toBeLessThan(transactionStart);
    expect(migration.slice(transactionStart)).not.toContain('create index');
  });
});

describe('customer-care dashboard request fan-out', () => {
  it('loads either the dashboard summary or the paginated workspace, never both', () => {
    expect(workspace).toContain('enabled: !isDashboard && Boolean(permissions.data)');
    expect(workspace).toContain('enabled: isDashboard && Boolean(permissions.data)');
    expect(workspace).toContain('records={dashboard.data.records}');
    expect(workspace).not.toContain('records={result.records}');
  });

  it('parses the dashboard-owned queue with a rolling-deploy fallback', () => {
    expect(api).toContain('records: z.array(customerCareRecordSchema).default([])');
    expect(api).toContain("rpc('get_customer_care_dashboard_summary'");
  });
});
