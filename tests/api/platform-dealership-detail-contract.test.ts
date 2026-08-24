import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformDealershipActivitySchema } from '../../src/features/platform/dealership-detail-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220039_platform_dealership_detail.sql');
const api = source('src/features/platform/dealership-detail-api.ts');
const workspace = source('src/features/platform/dealership-detail-workspace.tsx');
const list = source('src/features/platform/dealership-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('platform dealership detail contract', () => {
  it('requires Super Admin MFA and returns only bounded, sanitized tenant aggregates', () => {
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('PLATFORM_DEALERSHIP_DETAIL_ACCESS_REQUIRED');
    expect(migration).toContain('limit 8');
    expect(migration).toContain("'summary', coalesce(audit_row.metadata->>'safe_message'");
    expect(migration).not.toContain('object_key');
    expect(migration).not.toContain('integration_credentials');
  });

  it('validates the response, uses approved charts, and links from the server-paginated list', () => {
    expect(api).toContain("rpc('get_platform_dealership_detail'");
    expect(api).toContain('const dealershipDetailSchema');
    expect(api).toContain('z.array(platformDealershipActivitySchema)');
    expect(workspace).toContain('kind="line"');
    expect(workspace).toContain('kind="donut"');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
    expect(list).toContain('href={`/super-admin/dealerships/${row.original.id}`}');
  });

  it('accepts PostgreSQL numeric audit IDs and normalizes them for React keys', () => {
    const activity = platformDealershipActivitySchema.parse({
      id: 42,
      action: 'dealership.updated',
      resource_type: 'organization',
      summary: null,
      created_at: '2026-08-24T10:00:00Z',
    });

    expect(activity.id).toBe('42');
  });

  it('handles the UUID detail path before the one-segment workspace route and production fallback', () => {
    expect(route).toContain(
      "role === 'super-admin' &&\n    slug.length === 2 &&\n    slug[0] === 'dealerships'",
    );
    expect(route.indexOf('<DealershipDetailWorkspace')).toBeLessThan(
      route.indexOf('if (slug.length !== 1) notFound()'),
    );
    expect(route.indexOf('<DealershipDetailWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
