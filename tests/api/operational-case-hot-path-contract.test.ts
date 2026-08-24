import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source(
  'supabase/migrations/202608240006_optimize_operational_case_workspace.sql',
);

function section(startMarker: string, endMarker: string) {
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('operational case list hot path', () => {
  const page = section(
    'create or replace function public.get_operational_case_workspace_page(',
    'revoke all on function public.get_operational_case_workspace_page(',
  );

  it('preserves the public RPC boundary and authenticated grant', () => {
    expect(page).toContain("target_status text default 'OPEN'");
    expect(page).toContain('target_from_date date default null');
    expect(page).toContain('target_page_size integer default 25');
    expect(page).toContain("target_timezone text default 'Asia/Kolkata'");
    expect(page).toContain('returns jsonb');
    expect(page).toContain('stable');
    expect(page).toContain('security definer');
    expect(page).toContain("set search_path = ''");
    expect(migration).toContain(
      'grant execute on function public.get_operational_case_workspace_page(',
    );
    expect(migration).toContain(') to authenticated;');
  });

  it('resolves actor scope once and applies direct branch, owner and customer predicates', () => {
    const scope = section(
      'create or replace function app_private.operational_case_actor_scope(',
      'revoke all on function app_private.operational_case_actor_scope(uuid, text)',
    );
    expect(page.match(/operational_case_actor_scope\(/g)).toHaveLength(1);
    expect(page).toContain('current_organization_id, normalized_department');
    expect(scope).toContain("assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')");
    expect(scope).toContain("assignment_row.data_scope = 'ONE_BRANCH'");
    expect(scope).toContain("assignment_row.data_scope = 'SELECTED_BRANCHES'");
    expect(scope).toContain("assignment_row.data_scope = 'OWN_RECORDS'");
    expect(scope).toContain("assignment_row.data_scope = 'OWN_TEAM'");
    expect(page).toContain('case_row.branch_id = any(allowed_full_branch_ids)');
    expect(page).toContain('case_row.assigned_user_id = current_actor_id');
    expect(page).toContain('case_row.branch_id = any(allowed_own_record_branch_ids)');
    expect(page).toContain('lead_row.team_id = any(allowed_customer_team_ids)');
    expect(page).toContain('lead_row.branch_id = any(allowed_customer_branch_ids)');
    expect(page).not.toContain('app_private.can_access_record(');
    expect(page).not.toContain('app_private.can_access_customer(');
    expect(page).not.toContain('app_private.operational_case_rows(');
  });

  it('binds department and customer scopes to the roles that grant each permission', () => {
    const scope = section(
      'create or replace function app_private.operational_case_actor_scope(',
      'revoke all on function app_private.operational_case_actor_scope(uuid, text)',
    );
    for (const permission of [
      'finance.view',
      'insurance.view',
      'rto.view',
      'exchange.view',
      'delivery.view',
    ]) {
      expect(scope).toContain(`then '${permission}'`);
    }
    expect(scope).toContain('permission_row.permission_key = department_permission_key');
    expect(scope).toContain("permission_row.permission_key = 'customer.view'");
    expect(scope).toContain('support_access or customer_organization_wide');
    expect(scope).not.toContain('support_access or organization_wide');
    expect(scope).toContain('customer_own_record_branch_ids uuid[]');
    expect(scope).toContain('if case_owns_records or customer_owns_records then');
    expect(scope).toContain('join public.branches branch_row');
    expect(scope).toContain('branch_row.active');
    expect(scope).toContain('branch_row.deleted_at is null');
    expect(scope).toContain('join public.teams team_row');
    expect(scope).toContain('team_row.active');
    expect(page).toContain('lead_row.branch_id = any(allowed_customer_own_record_branch_ids)');
  });

  it('pages lean rows before display and child-record enrichment', () => {
    const pageSlice = page.indexOf('page_slice as materialized (');
    const enrichment = page.indexOf('enriched_page as materialized (');
    expect(pageSlice).toBeGreaterThanOrEqual(0);
    expect(enrichment).toBeGreaterThan(pageSlice);
    expect(page.indexOf('join public.profiles profile_row')).toBeGreaterThan(enrichment);
    expect(page.indexOf('from public.exchange_evaluations evaluation_row')).toBeGreaterThan(
      enrichment,
    );
    expect(page.indexOf('from public.delivery_checklist_items item_row')).toBeGreaterThan(
      enrichment,
    );
    const pageSliceSource = page.slice(pageSlice, enrichment);
    expect(pageSliceSource).toContain('limit target_page_size');
    expect(pageSliceSource).not.toContain('jsonb_build_object(');
    expect(pageSliceSource).not.toContain('from public.exchange_evaluations');
    expect(pageSliceSource).not.toContain('from public.delivery_checklist_items');
  });

  it('keeps every department, bounded pagination, filters and stable sort tie-breakers', () => {
    for (const [department, table] of [
      ['FINANCE', 'finance_cases'],
      ['INSURANCE', 'insurance_cases'],
      ['RTO', 'rto_cases'],
      ['EXCHANGE', 'exchange_cases'],
      ['DELIVERY', 'delivery_cases'],
    ]) {
      expect(page).toContain(`normalized_department = '${department}'`);
      expect(page).toContain(`from public.${table} case_row`);
    }
    expect(page).toContain('target_page_size is null or target_page_size not in (25, 50, 100)');
    expect(page).toContain("case when target_sort = 'updated:desc'");
    expect(page).toContain("case when target_sort = 'updated:asc'");
    expect(page).toContain("case when target_sort = 'due:asc'");
    expect(page).toContain("case when target_sort = 'customer:asc'");
    expect(page).toContain('filtered_row.id desc');
    expect(page).toContain('page_slice_row.id desc');
    expect(page).toContain('case normalized_status');
    expect(page).toContain("when 'DOCUMENTS' then");
    expect(page).toContain("when 'ACTION_DUE' then");
  });

  it('uses raw timestamp boundaries and set-based document presence for aggregate work', () => {
    expect(page).toContain('case_row.updated_at >= from_timestamp');
    expect(page).toContain('case_row.updated_at < to_timestamp_exclusive');
    expect(page).not.toContain('timezone(target_timezone, case_row.updated_at)::date');
    expect(page).toContain('documented_cases as materialized (');
    expect(page).toContain('group by file_row.resource_id');
    expect(page).toContain('documented_row.resource_id is not null as has_document');
    expect(page).toContain('due_at >= today_start');
    expect(page).toContain('due_at < tomorrow_start');
    expect(page).toContain('updated_at >= month_start');
    expect(page).toContain('updated_at < next_month_start');
  });

  it('does not pre-materialize the entire tenant customer or booking directories', () => {
    expect(page).toContain('authorized_customer_ids as not materialized (');
    expect(page).not.toContain('active_bookings as materialized (');
    expect(page).toContain('join public.bookings booking_scope');
    expect(page).toContain('booking_scope.organization_id = case_row.organization_id');
    expect(page).toContain("replace(normalized_search, '!', '!!')");
    expect(page).toContain("ilike '%' || normalized_name_pattern || '%' escape '!'");
    expect(page).toContain('app_private.normalize_phone_digits(customer_row.normalized_phone)');
  });

  it('retains the response keys and page-only detail payloads', () => {
    for (const key of [
      'records',
      'total',
      'organization_id',
      'department',
      'kpis',
      'open',
      'pending_documents',
      'overdue',
      'due_today',
      'completed_this_month',
      'booking_number',
      'customer_name',
      'assigned_user_name',
      'details',
      'document_count',
    ]) {
      expect(page).toContain(`'${key}'`);
    }
    expect(page).toContain("when 'FINANCE' then jsonb_strip_nulls");
    expect(page).toContain("when 'INSURANCE' then jsonb_strip_nulls");
    expect(page).toContain("when 'RTO' then jsonb_strip_nulls");
    expect(page).toContain("when 'EXCHANGE' then jsonb_strip_nulls");
    expect(page).toContain("when 'DELIVERY' then jsonb_strip_nulls");
  });

  it('adds tenant, branch and owner date indexes for the five case tables', () => {
    expect(
      migration.match(/create index concurrently if not exists \w+_cases_org_updated_page_idx/g),
    ).toHaveLength(5);
    expect(
      migration.match(/create index concurrently if not exists \w+_cases_branch_updated_page_idx/g),
    ).toHaveLength(5);
    expect(
      migration.match(/create index concurrently if not exists \w+_cases_owner_updated_page_idx/g),
    ).toHaveLength(5);
    expect(migration.match(/\(organization_id, updated_at desc, id desc\)/g)).toHaveLength(5);
    expect(
      migration.match(/\(organization_id, branch_id, updated_at desc, id desc\)/g),
    ).toHaveLength(5);
    expect(
      migration.match(/\(organization_id, assigned_user_id, updated_at desc, id desc\)/g),
    ).toHaveLength(5);
    expect(migration).not.toContain('(organization_id, status, updated_at desc, id desc)');
  });
});
