import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultLeadQuery,
  leadOverdueDirection,
  leadSortOptions,
  parseLeadQuery,
  resolveLeadSort,
  toLeadQueryString,
} from '../../src/features/leads/lead-workspace-query';
import {
  emptySavedLeadFilterValues,
  savedLeadFilterValues,
} from '../../src/features/leads/saved-lead-filters';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const migration = read(
  'supabase/migrations/202610100573_lead_overdue_first_sort_and_created_filter.sql',
);
const workspace = read('src/features/leads/lead-workspace.tsx');
const api = read('src/features/leads/lead-workspace-api.ts');
const dialog = read('src/components/shared/date-range-dialog.tsx');

describe('overdue follow-ups lead every lead tab', () => {
  it('puts the overdue block first on every tab by default', () => {
    for (const status of ['all', 'contacted', 'pending', 'sales-contacted', 'lost'] as const) {
      expect(resolveLeadSort({ status, sort: defaultLeadQuery.sort })).toBe('overdue:asc');
    }
    expect(resolveLeadSort({ status: 'follow-up', sort: defaultLeadQuery.sort })).toBe(
      'followup:asc',
    );
  });

  it('flips the order inside the blocks without dropping overdue-first', () => {
    expect(resolveLeadSort({ status: 'all', sort: 'overdue:desc' })).toBe('overdue:desc');
    expect(resolveLeadSort({ status: 'follow-up', sort: 'overdue:desc' })).toBe('followup:desc');
    // The direction survives a tab change in either spelling.
    expect(resolveLeadSort({ status: 'all', sort: 'followup:desc' })).toBe('overdue:desc');
    expect(resolveLeadSort({ status: 'all', sort: 'followup:asc' })).toBe('overdue:asc');
  });

  it('reports the direction, and none for sorts that are not about follow-ups', () => {
    expect(leadOverdueDirection('updated:desc')).toBe('asc');
    expect(leadOverdueDirection('overdue:asc')).toBe('asc');
    expect(leadOverdueDirection('overdue:desc')).toBe('desc');
    expect(leadOverdueDirection('followup:desc')).toBe('desc');
    expect(leadOverdueDirection('customer:asc')).toBeNull();
    expect(leadOverdueDirection('created:desc')).toBeNull();
  });

  it('keeps the default direction out of the URL and round-trips the other', () => {
    expect(toLeadQueryString({ ...defaultLeadQuery })).toBe('');
    const descending = { ...defaultLeadQuery, sort: 'overdue:desc' as const };
    expect(toLeadQueryString(descending)).toBe('sort=overdue%3Adesc');
    expect(parseLeadQuery(new URLSearchParams('sort=overdue%3Adesc')).sort).toBe('overdue:desc');
    for (const sort of ['followup:desc', 'overdue:asc', 'overdue:desc'] as const) {
      expect(leadSortOptions[sort].column).toBe('next_followup_at');
    }
  });

  it('toggles the direction from the Next follow-up header', () => {
    expect(workspace).toContain("header.column.id === 'next_followup_at'");
    expect(workspace).toContain(
      "sort: overdueDirection === 'asc' ? 'overdue:desc' : 'updated:desc'",
    );
  });

  it('decides overdue once, on the server, for the walk and the page alike', () => {
    expect(migration).toContain("target_sort in ('overdue:asc', 'overdue:desc', 'followup:desc')");
    // Still open and already due: a Lost lead is closed, not overdue.
    expect(migration).toContain('case when lead_row.next_followup_at < query_now');
    expect(migration).toContain(
      "and lead_row.lifecycle_status <> 'Lost' then 0 else 1 end as overdue_tier",
    );
    expect(migration).toContain('and lead_row.next_followup_at < $13');
    expect(migration).toContain('order by both_tiers.tier, both_tiers.rn');
    expect(migration).toContain(
      'case when overdue_first then lead_row.overdue_tier end asc nulls last,',
    );
    expect(migration).toContain("when 'overdue:asc' then lead_row.overdue_tier < window_last_tier");
    // A due-date walk needs a due date on every walked lead.
    expect(migration).toContain(
      "and (target_sort not in ('followup:asc', 'followup:desc') or target_status = 'follow-up')",
    );
  });

  it('patches the deployed functions and re-applies their grants', () => {
    expect(migration).not.toMatch(/create or replace function (public|app_private)\./i);
    expect(migration).toContain('pg_get_functiondef(target)');
    expect(migration).toContain('PATCH_ANCHOR_COUNT');
    expect(migration).toContain('PATCH_EXPECTED_ONE_NEW_OVERLOAD');
    expect(migration).toContain("execute format('drop function %s', old_identity);");
    expect(migration).toContain("array['authenticated', 'service_role']::text[]");
  });
});

describe('lead created-date filter', () => {
  it('carries the range through the URL, the request and saved filters', () => {
    const query = parseLeadQuery(
      new URLSearchParams('createdFrom=2026-10-01&createdTo=2026-10-09T23:59'),
    );
    expect(query.createdFrom).toBe('2026-10-01');
    expect(query.createdTo).toBe('2026-10-09');
    expect(toLeadQueryString(query)).toBe('createdFrom=2026-10-01&createdTo=2026-10-09');
    expect(api).toContain('target_created_from: query.createdFrom || null,');
    expect(api).toContain('target_created_to: query.createdTo || null,');
    expect(savedLeadFilterValues(query)).toMatchObject({
      createdFrom: '2026-10-01',
      createdTo: '2026-10-09',
    });
    expect(emptySavedLeadFilterValues()).toMatchObject({ createdFrom: '', createdTo: '' });
  });

  it('counts as an active filter and clears with the rest', () => {
    expect(workspace).toContain('query.createdFrom ||');
    expect(workspace).toContain('title="Created date range"');
    expect(workspace).toContain(
      'onQueryChange({ createdFrom: range.from, createdTo: range.to, page: 1 })',
    );
  });

  it('offers only past ranges, since a lead cannot be created in the future', () => {
    expect(workspace).toMatch(/title="Created date range"[\s\S]{0,260}pastOnly/);
    expect(dialog).toContain("{ label: 'Last 30 days', fromOffset: -29, toOffset: 0 }");
    expect(dialog).toContain('max={pastOnly ? today : undefined}');
  });

  it('filters on the Asia/Kolkata calendar day in every lead list function', () => {
    expect(migration).toContain(
      'target_created_from date DEFAULT NULL::date, target_created_to date DEFAULT NULL::date)',
    );
    expect(migration).toContain('(target_created_to + 1)::timestamp');
    expect(migration).toContain(
      'and (created_from_at is null or lead_row.created_at >= created_from_at)',
    );
    expect(migration).toContain(
      "or (lead_row.created_at at time zone 'Asia/Kolkata')::date >= target_created_from",
    );
    expect(migration).toContain('and target_created_from > target_created_to)');
  });
});
