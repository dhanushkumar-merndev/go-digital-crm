import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultLeadQuery,
  leadSortOptions,
  parseLeadQuery,
  resolveLeadSort,
  toLeadQueryString,
} from '../../src/features/leads/lead-workspace-query';

const migration = readFileSync(
  new URL('../../supabase/migrations/202610100371_lead_followup_due_sort.sql', import.meta.url),
  'utf8',
);
const workspace = readFileSync(
  new URL('../../src/features/leads/lead-workspace.tsx', import.meta.url),
  'utf8',
);
const dialog = readFileSync(
  new URL('../../src/components/shared/date-range-dialog.tsx', import.meta.url),
  'utf8',
);

describe('follow-up tab due-date ordering', () => {
  it('orders the Follow-up tab by due time, most overdue first', () => {
    expect(leadSortOptions['followup:asc']).toEqual({
      column: 'next_followup_at',
      ascending: true,
    });
    expect(resolveLeadSort({ status: 'follow-up', sort: defaultLeadQuery.sort })).toBe(
      'followup:asc',
    );
  });

  it('respects a sort that is not about follow-ups', () => {
    expect(resolveLeadSort({ status: 'follow-up', sort: 'customer:asc' })).toBe('customer:asc');
    expect(resolveLeadSort({ status: 'all', sort: 'created:desc' })).toBe('created:desc');
  });

  it('keeps the default sort out of the URL so the tab default stays derived', () => {
    const query = parseLeadQuery(new URLSearchParams('status=follow-up&temperature=COLD'));
    expect(query.sort).toBe('updated:desc');
    expect(toLeadQueryString(query)).toBe('status=follow-up&temperature=COLD');
    expect(parseLeadQuery(new URLSearchParams('sort=followup%3Aasc')).sort).toBe('followup:asc');
  });

  it('requests the list with the resolved sort', () => {
    expect(workspace).toContain('sort: resolveLeadSort(query)');
  });

  it('patches the deployed functions instead of re-emitting them', () => {
    expect(migration).not.toMatch(/create or replace function (public|app_private)\./i);
    expect(migration).toContain('pg_get_functiondef(');
    expect(migration).toContain('app_private.get_sales_role_lead_workspace_page(');
    expect(migration).toContain('public.get_lead_workspace_page_v2_legacy(');
    expect(migration).toContain('LEAD_FOLLOWUP_SORT_ANCHOR_CHANGED');
    expect(migration).toContain('LEAD_FOLLOWUP_SORT_PATCH_INCOMPLETE');
  });

  it('sorts on the server, in the windowed walk and in the page order', () => {
    expect(migration).toContain(
      "when 'followup:asc' then 'lead_row.next_followup_at asc, lead_row.id desc'",
    );
    expect(migration).toContain(
      "case when target_sort = 'followup:asc' then lead_row.next_followup_at end asc nulls last,",
    );
    expect(migration).toContain(
      "when 'followup:asc' then lead_row.next_followup_at < window_last_followup",
    );
    // The walk compares against a follow-up time, so it only runs where every
    // walked lead has one.
    expect(migration).toContain(
      "and (target_sort <> 'followup:asc' or target_status = 'follow-up')",
    );
    expect(migration).toContain(
      "when 'follow-up' then ' and lead_row.next_followup_at is not null'",
    );
  });
});

describe('follow-up date range dialog', () => {
  it('uses plain date fields that can reach upcoming follow-ups', () => {
    expect(workspace).toContain('title="Follow-up date range"');
    expect(dialog).not.toContain('DayPicker');
    expect(dialog.match(/type="date"/g)).toHaveLength(2);
    expect(dialog).toContain('min={draftFrom || undefined}');
    expect(dialog).toContain('disabled={inverted || unchanged}');
  });

  it('applies a quick range in one click and offers both directions', () => {
    expect(dialog).toContain('onClick={() => onApply(range)}');
    for (const label of ['Last 7 days', 'Yesterday', 'Today', 'Tomorrow', 'Next 7 days']) {
      expect(dialog).toContain(`label: '${label}'`);
    }
  });
});
