import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Redis entries behind the dashboard-cache Edge function are per user, so they
// only help when the RPC is slower than the Edge hop. Measured 2026-10-28:
// consultant performance ~150 ms and team/showroom performance 100–550 ms
// direct, against 300–1,200 ms for an Edge hit.
const salesPerformance = readFileSync(
  'src/features/dashboards/sales-consultant-performance-api.ts',
  'utf8',
);
const teamPerformance = readFileSync(
  'src/features/dashboards/team-manager-performance-api.ts',
  'utf8',
);

function body(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

describe('narrow-scope performance pages read PostgreSQL directly', () => {
  it("reads the consultant's own performance without the Edge cache", () => {
    const read = body(salesPerformance, 'fetchSalesPerformance');
    expect(read).toContain("rpc('get_sales_consultant_performance', params)");
    expect(read).not.toContain('fetchCachedAggregate');
  });

  it('reads team and showroom performance without the Edge cache', () => {
    const read = body(teamPerformance, 'fetchTeamManagerPerformance');
    expect(read).toContain("rpc('get_team_manager_performance'");
    expect(teamPerformance).not.toContain('fetchCachedAggregate');
  });

  it('keeps the telecaller performance on the cached path, where it is no slower', () => {
    expect(body(salesPerformance, 'fetchTelecallerPerformance')).toContain(
      "resource: 'telecaller-performance'",
    );
  });
});
