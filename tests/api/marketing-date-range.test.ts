import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMarketingQuery,
  toMarketingQueryString,
} from '../../src/features/marketing/marketing-query';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202610221453_marketing_workspace_date_range.sql'),
  'utf8',
);
const api = readFileSync(join(process.cwd(), 'src/features/marketing/marketing-api.ts'), 'utf8');

describe('marketing workspace date range', () => {
  it('reads a range from the URL only when both days are valid and ordered', () => {
    const ranged = parseMarketingQuery(
      new URLSearchParams('from=2026-10-01&to=2026-10-21'),
      'CAMPAIGNS',
    );
    expect([ranged.from, ranged.to]).toEqual(['2026-10-01', '2026-10-21']);
    for (const params of ['from=2026-10-21&to=2026-10-01', 'from=2026-10-01', 'from=x&to=y']) {
      const query = parseMarketingQuery(new URLSearchParams(params), 'SOURCES');
      expect([query.from, query.to]).toEqual(['', '']);
    }
  });

  it('round-trips through the query string and omits all time', () => {
    const query = parseMarketingQuery(
      new URLSearchParams('from=2026-09-01&to=2026-09-30&page=2'),
      'SOURCES',
    );
    expect(toMarketingQueryString(query, 'SOURCES')).toBe('page=2&from=2026-09-01&to=2026-09-30');
    expect(toMarketingQueryString({ ...query, from: '', to: '' }, 'SOURCES')).toBe('page=2');
  });

  it('sends the range only when one is chosen', () => {
    expect(api).toContain(
      '...(query.from && query.to ? { target_from: query.from, target_to: query.to } : {})',
    );
  });

  it('accepts both bounds or neither, as whole days in the requested timezone', () => {
    expect(migration).toContain(
      'or (target_from is null) <> (target_to is null) or target_to < target_from',
    );
    expect(migration).toContain(
      'range_start := target_from::timestamp at time zone target_timezone;',
    );
    expect(migration).toContain(
      'range_end := (target_to + 1)::timestamp at time zone target_timezone;',
    );
    expect(migration).toContain(
      '(range_start is null or (lead_row.created_at >= range_start and lead_row.created_at < range_end))',
    );
  });

  it('filters campaign leads by arrival and spend by metric day', () => {
    expect(migration).toContain(
      'app_private.marketing_campaign_stats(current_organization_id, target_from, target_to, target_timezone)',
    );
    expect(migration).toContain(
      'and (target_from is null or metric_row.metric_date >= target_from)',
    );
    expect(migration).toContain('and (target_to is null or metric_row.metric_date <= target_to)');
  });

  it('replaces the old signatures and keeps the page closed to anon', () => {
    expect(migration).toContain(
      'drop function if exists public.get_marketing_workspace_page(text, text, integer, integer, text, text);',
    );
    expect(migration).toContain(
      'revoke all on function public.get_marketing_workspace_page(text, text, integer, integer, text, text, date, date) from public, anon;',
    );
    expect(migration).toContain(
      'revoke all on function app_private.marketing_campaign_stats(uuid, date, date, text) from public, anon, authenticated;',
    );
  });
});
