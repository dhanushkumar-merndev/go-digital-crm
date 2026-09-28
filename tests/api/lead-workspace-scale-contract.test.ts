import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const facts = source('supabase/migrations/202609280004_lead_sales_facts.sql');
const paging = source('supabase/migrations/202609280005_lead_workspace_windowed_paging.sql');

describe('lead sales facts', () => {
  it('lives beside leads so maintaining it never fires lead triggers', () => {
    expect(facts).toContain('create table app_private.lead_sales_facts (');
    expect(facts).not.toMatch(/update public\.leads/);
    expect(facts).toContain('enable row level security');
    expect(facts).toContain(
      'revoke all on table app_private.lead_sales_facts from public, anon, authenticated;',
    );
  });

  it('is maintained by every write that can change a fact', () => {
    for (const table of [
      'public.test_drive_appointments',
      'public.quotations',
      'public.bookings',
      'public.lead_stage_history',
      'public.activities',
    ])
      expect(facts).toContain(`on ${table}`);
    expect(facts).toContain("when (new.activity_type = 'SALES_CONTACTED')");
    expect(facts).toContain("when (new.to_status = 'Transferred to Sales')");
    expect(facts).toContain(
      'after insert or delete or update of lead_id, status, deleted_at on public.bookings',
    );
  });

  it('refuses to deploy a backfill that disagrees with the inline definitions', () => {
    expect(facts).toContain("raise exception 'LEAD_SALES_FACTS_BACKFILL_MISMATCH: %'");
    expect(facts).toContain("b.status <> 'CANCELLED'");
  });
});

describe('windowed lead workspace paging', () => {
  it('patches the deployed function with anchors that must each match once', () => {
    expect(paging).toContain("pg_get_functiondef('app_private.get_sales_role_lead_workspace_page(");
    expect(
      paging.match(/LEAD_WORKSPACE_PATCH_ANCHOR_\d+_NOT_UNIQUE/g)?.length,
    ).toBeGreaterThanOrEqual(9);
    expect(paging).toContain("raise exception 'LEAD_WORKSPACE_PATCH_INCOMPLETE'");
    expect(paging).toContain("raise exception 'LEAD_WORKSPACE_ALREADY_PATCHED'");
  });

  it('reads facts instead of per-lead subqueries and flag CTEs', () => {
    expect(paging).toContain(
      'left join app_private.lead_sales_facts fact_row on fact_row.lead_id = lead_row.id',
    );
    expect(paging).toContain('flags_start := position(');
  });

  it('fetches a window by primary key rather than filtering the whole scope', () => {
    expect(paging).toContain(
      'where candidate_lead_ids is not null and window_row.id = any(candidate_lead_ids)',
    );
    expect(paging).toContain(
      'where candidate_lead_ids is null and scope_row.organization_id = target_organization_id',
    );
  });

  it('keeps phone groups and pins complete and falls back to the full scope', () => {
    expect(paging).toContain('select unnest(walk_ids || pinned_lead_ids) as member_id');
    expect(paging).toContain('sibling_row.normalized_phone in (');
    expect(paging).toContain('if window_size > 20000 then');
    expect(paging).toContain(
      "exit when window_exhausted\n      or (result->>'window_eligible')::bigint >= window_needed;",
    );
    expect(paging).toContain("return result - 'window_eligible';");
  });

  it('only narrows the walk with predicates the exact filter also applies', () => {
    expect(paging).toContain(
      "' or lower(lead_row.customer_name) like $11 escape ' || quote_literal(chr(92))",
    );
    expect(paging).toContain("replace(lower(normalized_search), '_', E'\\\\_')");
    expect(paging).toContain('leads_org_customer_name_active_idx');
  });
});
