import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150029_customer_care_workspace.sql');
const workspace = source('src/features/customer-care/customer-care-workspace.tsx');
const dialogs = source('src/features/customer-care/customer-care-dialogs.tsx');
const api = source('src/features/customer-care/customer-care-api.ts');
const dashboardMigration = source(
  'supabase/migrations/202608210001_customer_relationship_dashboard.sql',
);
const route = source('src/app/[role]/[[...slug]]/page.tsx');
const topics = source('src/lib/realtime/topics.ts');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('customer-care tenant and permission boundary', () => {
  it('keeps view, workflow mutation and escalation authority separate', () => {
    expect(migration).toContain("('customer_care.view', 'customer-care'");
    expect(migration).toContain("('customer_care.manage', 'customer-care'");
    expect(migration).toContain("('customer_care.escalate', 'customer-care'");
    expect(migration).toContain('roles_apply_default_customer_care_permissions');
    expect(migration).toContain("'customer_relationship_manager'");
  });

  it('anchors cases to Customer 360, booking, branch and vehicle with tenant composite keys', () => {
    expect(migration).toContain('create table public.customer_care_cases');
    for (const constraint of [
      'customer_care_cases_branch_org_fk',
      'customer_care_cases_customer_org_fk',
      'customer_care_cases_booking_org_fk',
      'customer_care_cases_assignee_org_fk',
      'customer_care_cases_creator_org_fk',
      'customer_care_cases_vehicle_org_fk',
    ]) {
      expect(migration).toContain(`constraint ${constraint}`);
      expect(migration).toContain(`validate constraint ${constraint}`);
    }
    expect(migration).toContain("values ('customer_care_cases', 'DELETE', 515)");
  });

  it('uses RLS for reads and RPC-only writes', () => {
    expect(migration).toContain('alter table public.customer_care_cases force row level security');
    expect(migration).toContain('create policy customer_care_cases_read');
    expect(migration).toContain("has_permission(organization_id, 'customer_care.view')");
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('app_private.can_access_customer');
    expect(migration).toContain(
      'revoke insert, update, delete, truncate on public.customer_care_cases from anon, authenticated',
    );
  });
});

describe('customer-care server query boundary', () => {
  const page = section(
    'create or replace function public.get_customer_care_workspace_page(',
    'create or replace function public.get_customer_care_customer_options(',
  );
  const options = section(
    'create or replace function public.get_customer_care_customer_options(',
    'create or replace function public.create_customer_care_case(',
  );

  it('uses bounded pagination, local search, allowlisted sorting and one KPI/chart bundle', () => {
    expect(page).toContain('target_page_size is null or target_page_size not in (25, 50, 100)');
    expect(page).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
    expect(page).toContain(
      "target_sort not in ('updated:desc', 'sla:asc', 'created:desc', 'priority:desc')",
    );
    for (const key of [
      'followups_due',
      'feedback_pending',
      'review_pending',
      'complaints_open',
      'sla_risk',
      'resolved_today',
      'average_resolution_hours',
      'status_chart',
      'activity_chart',
    ])
      expect(page).toContain(`'${key}'`);
  });

  it('does not let a child follow-up KPI bypass its lead or customer scope', () => {
    expect(page).toContain('app_private.can_access_lead(followup_row.lead_id)');
    expect(page).toContain('app_private.can_access_customer(');
  });

  it('bounds Customer 360 booking options and rechecks record and customer access', () => {
    expect(options).toContain('target_limit not between 1 and 25');
    expect(options).toContain('app_private.can_access_record');
    expect(options).toContain('app_private.can_access_customer');
    expect(options).toContain('limit 1');
  });
});

describe('customer-care atomic workflow boundary', () => {
  const create = section(
    'create or replace function public.create_customer_care_case(',
    'create or replace function public.update_customer_care_case(',
  );
  const update = section(
    'create or replace function public.update_customer_care_case(',
    'alter table public.customer_care_cases enable row level security',
  );

  it('makes creation scoped, booking-derived, replay-safe and audited', () => {
    expect(create).toContain('pg_advisory_xact_lock');
    expect(create).toContain('app_private.replay_customer_care_request');
    expect(create).toContain('from public.bookings source_row');
    expect(create).toContain('app_private.can_access_record');
    expect(create).toContain('app_private.can_access_customer');
    expect(create).toContain('insert into public.activities');
    expect(create).toContain('insert into public.audit_logs');
    expect(create).toContain("'COMPLAINT'");
    expect(create).toContain("'FEEDBACK'");
  });

  it('serializes optimistic updates and enforces forward flow, reason and resolution evidence', () => {
    expect(update).toContain('for update');
    expect(update).toContain('CUSTOMER_CARE_VERSION_CONFLICT');
    expect(update).toContain('app_private.customer_care_transition_allowed');
    expect(update).toContain('CUSTOMER_CARE_CHANGE_REASON_REQUIRED');
    expect(update).toContain('CUSTOMER_CARE_RESOLUTION_REQUIRED');
    expect(update).toContain('CUSTOMER_CARE_ESCALATE_PERMISSION_REQUIRED');
    expect(update).toContain('insert into public.activities');
    expect(update).toContain('insert into public.audit_logs');
  });
});

describe('customer-care production UI and realtime contract', () => {
  it('uses shadcn, TanStack Query/Table and Apache ECharts only', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain('useDebouncedValue(routeQuery.search, 300)');
    expect(workspace).toContain('<EChart kind="donut"');
    expect(workspace).toMatch(/<EChart\s+kind="line"/);
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
    expect(dialogs).toContain("from '@/components/ui/dialog'");
    expect(dialogs).toContain("from '@/components/ui/sheet'");
    expect(api).toContain("rpc('get_customer_care_workspace_page'");
  });

  it('keeps customer relationship dashboard aggregates server-side and scope-filtered', () => {
    expect(dashboardMigration).toContain(
      'create or replace function public.get_customer_care_dashboard_summary(',
    );
    expect(dashboardMigration).toContain('app_private.can_access_record');
    expect(dashboardMigration).toContain('app_private.can_access_customer');
    expect(dashboardMigration).toContain("'rating_breakdown'");
    expect(dashboardMigration).toContain("'consultant_performance'");
    expect(dashboardMigration).toContain(
      'grant execute on function public.get_customer_care_dashboard_summary(text) to authenticated',
    );
    expect(api).toContain("rpc('get_customer_care_dashboard_summary'");
  });

  it('uses the private customer-care topic and routes every approved page before fallback', () => {
    expect(migration).toContain("when 'customer-care' then");
    expect(migration).toContain("broadcast_tenant_invalidation('customer-care')");
    expect(topics).toContain("'customer-care'");
    expect(workspace).toContain("resource: 'customer-care'");
    expect(route).toContain('<CustomerCareWorkspace');
    expect(route.indexOf("role === 'customer-care'")).toBeLessThan(
      route.indexOf("if (slug[0] === 'dashboard'"),
    );
    expect(route.indexOf('<CustomerCareWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
