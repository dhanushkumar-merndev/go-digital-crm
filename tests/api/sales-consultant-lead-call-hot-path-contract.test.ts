import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608220003_sales_consultant_lead_call_hot_paths.sql',
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

const leadFastPath = section(
  'create or replace function app_private.get_sales_consultant_lead_workspace_page(',
  'revoke all on function app_private.get_sales_consultant_lead_workspace_page(',
);
const callFastPath = section(
  'create or replace function app_private.get_sales_consultant_call_workspace_page(',
  'revoke all on function app_private.get_sales_consultant_call_workspace_page(',
);
const leadWrapper = section(
  'create or replace function public.get_lead_workspace_page_v2(',
  'revoke all on function public.get_lead_workspace_page_v2(',
);
const callWrapper = section(
  'create or replace function public.get_call_workspace_page(',
  'revoke all on function public.get_call_workspace_page(',
);

describe('Sales Consultant lead/call hot paths', () => {
  it('preserves revoked legacy implementations and the established lead JSON boundary', () => {
    expect(migration).toContain('rename to get_lead_workspace_page_v2_legacy');
    expect(migration).toContain('rename to get_call_workspace_page_legacy');
    expect(migration).toContain(
      'get_lead_workspace_page_v2_legacy(\n  integer, integer, text, text, text, text, text, text, text, date, date\n) from public, anon, authenticated',
    );
    expect(migration).toContain(
      'get_call_workspace_page_legacy(\n  text, integer, integer, text, text, text, text\n) from public, anon, authenticated',
    );
    expect(leadWrapper).toContain('return public.get_lead_workspace_page_v2_legacy(');
    expect(callWrapper).toContain('return public.get_call_workspace_page_legacy(');
    for (const key of ["'records'", "'total'", "'kpis'", "'filters'"]) {
      expect(leadFastPath).toContain(key);
    }
  });

  it('gates Sales once and enforces direct organization, owner, and allowed-branch scope', () => {
    expect(leadWrapper).toContain("access_context->>'role_key' = 'sales-consultant'");
    expect(leadWrapper).toContain("access_context->>'destination' <> 'CRM'");
    for (const wrapper of [leadWrapper, callWrapper]) {
      expect(wrapper.match(/app_private\.sales_consultant_permissions\(/g)).toHaveLength(1);
      expect(wrapper).not.toContain('app_private.has_permission(');
    }
    expect(leadWrapper).toContain("'lead.view' = any(permission_keys)");
    expect(callWrapper).toContain("'call.view' = any(permission_keys)");
    expect(migration).toContain('app_private.sales_consultant_allowed_branches(');

    for (const fastPath of [leadFastPath, callFastPath]) {
      expect(fastPath).toContain('organization_id = target_organization_id');
      expect(fastPath).toContain('assigned_user_id = auth.uid()');
      expect(fastPath).toContain('branch_id = any(target_branch_ids)');
      expect(fastPath).not.toContain('app_private.can_access_record(');
    }
    expect(callFastPath).not.toContain('app_private.can_access_customer(');
    expect(callFastPath).not.toContain('app_private.can_access_lead(');
  });

  it('keeps call customer and lead PII behind explicit permission-derived gates', () => {
    expect(callWrapper).toContain("customer_access := 'customer.view' = any(permission_keys)");
    expect(callWrapper).toContain("lead_access := 'lead.view' = any(permission_keys)");
    expect(callFastPath).toContain('where target_customer_access');
    expect(callFastPath).toContain(
      'case when target_lead_access and accessible_lead.id is not null',
    );
    expect(callFastPath).toContain('customer_row.id = accessible_customer.customer_id');
    expect(migration).toContain(
      'uuid, uuid[], boolean, boolean, text, integer, integer, text, text, text, text, text\n) from public, anon, authenticated',
    );
  });

  it('validates server pagination and selects page IDs before display enrichment', () => {
    expect(leadFastPath).toContain('target_page is null or target_page < 1');
    expect(leadFastPath).toContain(
      'target_page_size is null or target_page_size not in (25, 50, 100)',
    );
    expect(callFastPath).toContain('target_page is null or target_page not between 1 and 1000000');
    expect(callFastPath).toContain(
      'target_page_size is null or target_page_size not in (25, 50, 100)',
    );
    for (const fastPath of [leadFastPath, callFastPath]) {
      expect(fastPath).toContain('page_ids as materialized');
      expect(fastPath).toContain('limit target_page_size');
      expect(fastPath).toContain('offset ((target_page - 1)::bigint * target_page_size)');
    }
    expect(leadFastPath.indexOf('page_ids as materialized')).toBeLessThan(
      leadFastPath.indexOf('page_rows as materialized'),
    );
    expect(callFastPath.indexOf('page_ids as materialized')).toBeLessThan(
      callFastPath.indexOf('page_parties as materialized'),
    );
    expect(callFastPath.indexOf('page_ids as materialized')).toBeLessThan(
      callFastPath.indexOf('page_recordings as materialized'),
    );
    expect(leadFastPath).toContain('quotation_row.deleted_at is null');
  });

  it('keeps normalized-phone lookup sargable and uses the existing name trigram expression', () => {
    expect(leadFastPath).toContain(
      'search_phone_digits := app_private.normalize_phone_digits(normalized_search)',
    );
    expect(leadFastPath).toContain(
      "lower(lead_row.customer_name) like '%' || lower(normalized_search) || '%'",
    );
    expect(leadFastPath).toContain('lead_row.normalized_phone = search_phone_digits');
    expect(leadFastPath).toContain("lead_row.normalized_phone like search_phone_digits || '%'");
    expect(callFastPath).toContain('party_row.search_phone = search_phone_digits');
    expect(callFastPath).toContain("party_row.search_phone like search_phone_digits || '%'");
    expect(callFastPath).not.toContain(
      'app_private.normalize_phone_digits(customer_row.normalized_phone)',
    );
    expect(callFastPath).not.toContain(
      'app_private.normalize_phone_digits(linked_lead.normalized_phone)',
    );
  });

  it('filters the Sales call view before count/page and keeps the trailing public argument', () => {
    expect(callWrapper).toContain("target_view text default 'HISTORY'");
    expect(callWrapper).toContain(
      "normalized_view not in ('TODAY', 'HISTORY', 'MISSED', 'RECORDINGS', 'AI')",
    );
    expect(callFastPath).toContain("normalized_view = 'TODAY'");
    expect(callFastPath).toContain("normalized_view = 'MISSED'");
    expect(callFastPath).toContain("normalized_view = 'RECORDINGS'");
    expect(callFastPath).toContain("normalized_view = 'AI'");
    expect(callFastPath).toContain("'NO_ANSWER', 'BUSY', 'SWITCHED_OFF'");
    expect(callFastPath.indexOf('filtered_calls as materialized')).toBeLessThan(
      callFastPath.indexOf('page_ids as materialized'),
    );
    expect(callFastPath).toContain("'total', (select count(*) from filtered_calls)");
    expect(migration).toContain(
      'public.get_call_workspace_page(\n  text, integer, integer, text, text, text, text, text\n) to authenticated',
    );
  });

  it('returns every call KPI needed without the separate today-summary RPC', () => {
    for (const key of [
      'total_today',
      'connected_today',
      'not_connected_today',
      'talk_time_seconds',
      'average_duration_seconds',
      'connection_rate',
      'callbacks_required',
      'recordings_ready',
    ]) {
      expect(callFastPath).toContain(`'${key}'`);
    }
    expect(callFastPath).toContain("'trend'");
    expect(callFastPath).not.toContain("'object_key'");
    expect(callFastPath).not.toContain("'bucket'");
    expect(callFastPath).not.toContain('recording_url');
  });
});
