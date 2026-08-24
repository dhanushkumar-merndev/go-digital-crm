import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202608240012_optimize_tenant_performance_dashboard.sql'),
  'utf8',
);

describe('tenant dashboard 100k-lead scale contract', () => {
  it('keeps additive index builds concurrent and function replacement atomic', () => {
    const transactionStart = migration.indexOf('\nbegin;');

    expect(transactionStart).toBeGreaterThan(0);
    expect(migration.slice(0, transactionStart)).toContain(
      'create index concurrently if not exists leads_dashboard_customer_scope_idx',
    );
    expect(migration.slice(0, transactionStart)).toContain(
      'create index concurrently if not exists leads_dashboard_lifecycle_created_idx',
    );
    expect(migration.slice(0, transactionStart)).toContain(
      'create index concurrently if not exists followups_dashboard_team_due_idx',
    );
    expect(migration.slice(transactionStart)).not.toContain('create index concurrently');
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('binds every resource permission to the assignment that contributes scope', () => {
    expect(migration).toContain(
      'create or replace function app_private.resolve_dashboard_record_scope(',
    );
    expect(migration).toContain('join public.user_role_assignments assignment_row');
    expect(migration).toContain('role_permission_row.role_id = assignment_row.role_id');
    expect(migration).toContain(
      'permission_row.permission_key = any(\n            coalesce(target_permission_keys',
    );
    expect(migration).toContain("assignment_row.data_scope = 'ONE_BRANCH'");
    expect(migration).toContain("assignment_row.data_scope = 'SELECTED_BRANCHES'");
    expect(migration).toContain("assignment_row.data_scope = 'OWN_TEAM'");
    expect(migration).toContain("assignment_row.data_scope = 'OWN_RECORDS'");
    expect(migration).toContain("('ORGANIZATION', 'ALL_BRANCHES')");
    expect(migration).toContain('branch_row.active');
    expect(migration).toContain('branch_row.deleted_at is null');
  });

  it('removes per-row security-definer access calls from every high-volume path', () => {
    for (const perRowHelper of [
      'app_private.can_access_record(',
      'app_private.can_access_customer(',
      'app_private.can_access_lead(',
      'app_private.can_access_branch(',
      'app_private.operational_case_rows(',
    ]) {
      expect(migration).not.toContain(perRowHelper);
    }

    for (const table of [
      'public.leads',
      'public.followups',
      'public.appointments',
      'public.calls',
      'public.bookings',
      'public.test_drive_appointments',
      'public.stock_units',
    ]) {
      expect(migration).toContain(table);
    }

    expect(migration).toContain('lead_row.branch_id = any(lead_scope.branch_scope_ids)');
    expect(migration).toContain('followup_row.team_id = any(followup_scope.team_scope_ids)');
    expect(migration).toContain('appointment_row.assigned_user_id = auth.uid()');
    expect(migration).toContain('call_row.branch_id = any(call_scope.branch_scope_ids)');
    expect(migration).toContain('booking_row.team_id = any(booking_scope.team_scope_ids)');
    expect(migration).toContain('stock_row.branch_id = any(inventory_scope.branch_scope_ids)');
    expect(migration).toContain(
      'create or replace function app_private.tenant_dashboard_operational_counts(',
    );
    expect(migration).toContain('from public.finance_cases case_row');
    expect(migration).toContain('from public.delivery_cases case_row');
  });

  it('keeps PII live output separately bounded before display joins', () => {
    expect(migration).toContain(
      'create or replace function app_private.tenant_dashboard_live_items(',
    );
    expect(migration).toContain('with candidate_ids as materialized');
    expect(migration).toContain('limit 5');
    expect(migration).toContain('with attention_candidates as materialized');
    expect(migration).toContain('limit 12');
    expect(migration).toContain(
      'create or replace function public.get_tenant_dashboard_live_items(',
    );
    expect(migration).toContain("'lead_preview', preview_result");
    expect(migration).toContain("'attention', attention_result");
  });

  it('builds call activity once and labels every supported series truthfully', () => {
    expect(migration).toContain('with scoped_calls as materialized (');
    expect(migration).toContain('from scoped_calls call_row\n      group by 1');
    expect(migration).toContain('into call_today_count, activity_result');
    expect(migration).toContain("when can_view_calls then 'Calls'");
    expect(migration).toContain("when can_view_bookings then 'Bookings'");
    expect(migration).toContain("when can_view_calls and can_view_leads then 'Calls'");
    expect(migration).toContain(
      "when can_view_bookings and (can_view_leads or can_view_calls) then 'Bookings'",
    );
  });

  it('preserves all public signatures, JSON fields and authenticated-only grants', () => {
    expect(migration).toContain(
      'create or replace function public.get_tenant_performance_dashboard(',
    );
    expect(migration).toContain('create or replace function public.get_tenant_dashboard_summary(');
    expect(migration).toContain(
      'create or replace function public.get_tenant_dashboard_live_items(',
    );
    expect(migration).toContain("'kpis', jsonb_build_object(");
    expect(migration).toContain("'activity', activity_result");
    expect(migration).toContain("'pipeline', pipeline_result");
    expect(migration).toContain("'capabilities', jsonb_build_object(");
    expect(migration).toContain(
      'grant execute on function public.get_tenant_performance_dashboard(integer, text)\n  to authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.get_tenant_dashboard_summary(integer, text)\n  to authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.get_tenant_dashboard_live_items(text)\n  to authenticated',
    );
  });
});
