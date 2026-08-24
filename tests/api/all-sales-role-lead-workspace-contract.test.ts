import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608240005_optimize_all_sales_role_lead_workspace.sql',
  'utf8',
);
const api = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

const scopeResolver = section(
  'create or replace function app_private.resolve_sales_lead_workspace_scope(',
  'revoke all on function app_private.resolve_sales_lead_workspace_scope(uuid)',
);
const branchScope = section('), branch_scope as (', '), team_scope as (');
const fastPath = section(
  'create or replace function app_private.get_sales_role_lead_workspace_page(',
  'revoke all on function app_private.get_sales_role_lead_workspace_page(',
);
const scopedLeads = section(
  'with scoped_leads as materialized (',
  '), test_drive_leads as materialized (',
);
const wrapper = section(
  'create or replace function public.get_lead_workspace_page_v2(',
  'revoke all on function public.get_lead_workspace_page_v2(',
);

describe('all-sales-role lead workspace hot path', () => {
  it('dispatches every actual sales route key through the shared fast path', () => {
    for (const roleKey of [
      'telecaller',
      'sales-consultant',
      'team-manager',
      'showroom-manager',
      'gm-sales',
    ]) {
      expect(wrapper).toContain(`'${roleKey}'`);
    }
    expect(wrapper).toContain("access_context->>'destination' <> 'CRM'");
    expect(wrapper).toContain(
      'from app_private.resolve_sales_lead_workspace_scope(current_organization_id)',
    );
    expect(wrapper).toContain("'lead.view' = any(workspace_scope.permission_keys)");
    expect(wrapper).toContain('return app_private.get_sales_role_lead_workspace_page(');
    expect(wrapper).toContain('return public.get_lead_workspace_page_v2_legacy(');
  });

  it('unions only lead-authorized assignment scopes without widening branch access', () => {
    expect(scopeResolver.match(/active_assignments as materialized/g)).toHaveLength(1);
    expect(scopeResolver).toContain('array_agg(permission_key order by permission_key)');
    expect(scopeResolver).toContain("data_scope in ('ORGANIZATION', 'ALL_BRANCHES')");
    expect(scopeResolver).toContain("assignment_row.data_scope = 'ONE_BRANCH'");
    expect(scopeResolver).toContain("assignment_row.data_scope = 'SELECTED_BRANCHES'");
    expect(scopeResolver).toContain("assignment_row.data_scope = 'OWN_TEAM'");
    expect(scopeResolver).toContain("assignment_row.data_scope = 'OWN_RECORDS'");
    expect(scopeResolver).toContain('assignment_row.user_id = auth.uid()');
    expect(scopeResolver).toContain('assignment_row.active');
    expect(scopeResolver).toContain('role_row.organization_id = assignment_row.organization_id');
    expect(scopeResolver).toContain('lead_role_permission_row.role_id = assignment_row.role_id');
    expect(scopeResolver).toContain(
      'lead_permission_row.id = lead_role_permission_row.permission_id',
    );
    expect(scopeResolver).toContain("lead_permission_row.permission_key = 'lead.view'");
    expect(scopeResolver.indexOf("lead_permission_row.permission_key = 'lead.view'")).toBeLessThan(
      scopeResolver.indexOf('), active_branches as materialized'),
    );

    expect(branchScope).not.toContain('public.user_branch_access');
    expect(scopeResolver).toContain('owner_branch_candidates as (');
    expect(scopeResolver).toContain('public.user_branch_access access_row');
    expect(scopeResolver).toContain('access_row.active');
  });

  it('keeps active-branch validation and direct organization, branch, team, and owner gates', () => {
    expect(scopeResolver).toContain('branch_row.active');
    expect(scopeResolver).toContain('branch_row.deleted_at is null');
    expect(scopedLeads).toContain('branch_row.active');
    expect(scopedLeads).toContain('branch_row.deleted_at is null');
    expect(scopedLeads).toContain('target_organization_wide');
    expect(scopedLeads).toContain('lead_row.branch_id = any(target_branch_scope_ids)');
    expect(scopedLeads).toContain('lead_row.team_id = any(target_team_scope_ids)');
    expect(scopedLeads).toContain('lead_row.assigned_user_id = target_actor_id');
    expect(scopedLeads).toContain('lead_row.branch_id = any(target_owner_branch_ids)');
    expect(fastPath).toContain('target_actor_id is distinct from auth.uid()');
    expect(fastPath).not.toContain('app_private.can_access_record(');
    expect(fastPath).not.toContain('app_private.can_access_branch(');
  });

  it('filters lean rows and page IDs before hydrating the display contract', () => {
    expect(scopedLeads).not.toContain('lead_row.phone,');
    expect(scopedLeads).not.toContain('lead_row.email,');
    expect(scopedLeads).not.toContain('lead_row.raw_payload');
    expect(fastPath).toContain('filtered_lead_ids as materialized');
    expect(fastPath).toContain('page_ids as materialized');
    expect(fastPath).toContain('page_rows as materialized');
    expect(fastPath.indexOf('filtered_lead_ids as materialized')).toBeLessThan(
      fastPath.indexOf('page_ids as materialized'),
    );
    expect(fastPath.indexOf('page_ids as materialized')).toBeLessThan(
      fastPath.indexOf('page_rows as materialized'),
    );
    expect(fastPath).toContain('limit target_page_size');
    expect(fastPath).toContain('offset ((target_page - 1)::bigint * target_page_size)');
  });

  it('retains bounded pagination, stable ordering, and guarded phone search', () => {
    expect(fastPath).toContain('target_page is null or target_page < 1');
    expect(fastPath).toContain('target_page_size is null or target_page_size not in (25, 50, 100)');
    expect(fastPath).toContain('lead_row.id desc');
    expect(fastPath).toContain(
      'search_phone_digits := coalesce(\n    app_private.normalize_phone_digits(normalized_search)',
    );
    expect(fastPath).toContain("search_phone_digits <> ''");
    expect(fastPath).toContain('lead_row.normalized_phone = search_phone_digits');
    expect(fastPath).toContain("lead_row.normalized_phone like search_phone_digits || '%'");
    expect(fastPath).toContain("replace(lower(normalized_search), '_', E'\\\\_')");
    expect(fastPath).toContain("escape E'\\\\'");
    expect(fastPath).not.toContain("like '%' || lower(normalized_search) || '%'");
  });

  it('preserves the records, count, KPI, and filter-options JSON contract', () => {
    for (const key of ["'records'", "'total'", "'kpis'", "'filters'"]) {
      expect(fastPath).toContain(key);
    }
    for (const key of [
      'new_today',
      'pending',
      'sla_risk',
      'qualified',
      'new_count',
      'contacted_count',
      'appointment_scheduled_count',
      'transferred_to_sales_count',
      'lost_count',
      'hot',
      'warm',
      'cold',
      'follow_up',
      'test_drive',
      'quotation',
      'booking',
    ]) {
      expect(fastPath).toContain(`as ${key}`);
    }
    for (const key of [
      'id',
      'organization_id',
      'branch_id',
      'team_id',
      'customer_id',
      'phone',
      'email',
      'work_state',
      'lead_stage',
      'assigned_user_name',
      'updated_at',
    ]) {
      expect(fastPath).toContain(`'${key}'`);
    }
    expect(fastPath).toContain("'models'");
    expect(fastPath).toContain("'sources'");
    expect(fastPath).toContain('quotation_row.deleted_at is null');
  });

  it('adds only the two missing manager updated-sort indexes', () => {
    expect(migration.match(/create index concurrently if not exists/g)).toHaveLength(2);
    expect(migration).toContain(
      'leads_team_updated_active_idx\n  on public.leads (organization_id, team_id, updated_at desc, id desc)',
    );
    expect(migration).toContain(
      'leads_branch_updated_active_idx\n  on public.leads (organization_id, branch_id, updated_at desc, id desc)',
    );
    expect(migration.match(/where deleted_at is null;/g)).toHaveLength(2);
  });

  it('keeps the public RPC signature and TypeScript request unchanged', () => {
    expect(migration).toContain(
      'public.get_lead_workspace_page_v2(\n  integer, integer, text, text, text, text, text, text, text, date, date\n) to authenticated',
    );
    expect(api).toContain("supabase.rpc('get_lead_workspace_page_v2'");
    for (const argumentName of [
      'target_page',
      'target_page_size',
      'target_search',
      'target_status',
      'target_sort',
      'target_model',
      'target_source',
      'target_stage',
      'target_temperature',
      'target_followup_from',
      'target_followup_to',
    ]) {
      expect(api).toContain(`${argumentName}:`);
    }
  });
});
