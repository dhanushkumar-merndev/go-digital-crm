import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220016_platform_integration_workspace.sql');
const api = source('src/features/platform/platform-integration-workspace-api.ts');
const workspace = source('src/features/platform/platform-integration-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('platform integration workspace backend contract', () => {
  it('requires an MFA-assured Super Admin and validates bounded query inputs', () => {
    expect(migration).toContain('create or replace function public.get_platform_integration_workspace(');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain("normalized_status not in ('ALL', 'CONNECTED', 'ATTENTION', 'PENDING')");
  });

  it('returns a paged aggregate-only view without credentials or provider payloads', () => {
    expect(migration).toContain('paged_connections as materialized');
    expect(migration).toContain('limit target_page_size offset ((target_page - 1) * target_page_size)');
    expect(migration).toContain("'external_account_hint'");
    expect(migration).toContain("'events_last_30_days'");
    expect(migration).toContain("'sync_runs_last_30_days'");
    expect(migration).not.toContain('encrypted_payload');
    expect(migration).not.toContain('payload_reference');
  });

  it('indexes the connection event and sync paths and excludes anonymous execution', () => {
    expect(migration).toContain('connected_accounts_platform_status_updated_idx');
    expect(migration).toContain('provider_events_connection_received_idx');
    expect(migration).toContain('sync_runs_connection_started_idx');
    expect(migration).toContain(
      'revoke all on function public.get_platform_integration_workspace(integer, integer, text, text) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_platform_integration_workspace(integer, integer, text, text) to authenticated',
    );
  });
});

describe('platform integration workspace web contract', () => {
  it('validates the server response and uses a filter/page-specific Query key', () => {
    expect(api).toContain('const resultSchema = z.object({');
    expect(api).toContain("rpc('get_platform_integration_workspace'");
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain("['platform-integration-workspace', page, search, status]");
  });

  it('uses the approved shadcn and ECharts visual foundation', () => {
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain('kind="donut"');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('routes only the genuine Super Admin platform-provider workspace', () => {
    expect(route).toContain("role === 'super-admin' && slug[0] === 'integrations-providers'");
    expect(route.indexOf('<PlatformIntegrationWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
