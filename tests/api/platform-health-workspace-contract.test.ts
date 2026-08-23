import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220020_platform_health_workspace.sql');
const api = source('src/features/platform/platform-health-workspace-api.ts');
const workspace = source('src/features/platform/platform-health-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('platform health workspace backend contract', () => {
  it('requires MFA-assured Super Admin access and aggregates recorded platform signals', () => {
    expect(migration).toContain('create or replace function public.get_platform_health_workspace()');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain("'sync_runs_24h'");
    expect(migration).toContain("'errors_24h'");
    expect(migration).toContain("'provider_attention'");
  });

  it('keeps error data sanitized and attention data bounded', () => {
    expect(migration).toContain('error_logs_platform_service_created_idx');
    expect(migration).toContain("'last_safe_code'");
    expect(migration).not.toContain('safe_message');
    expect(migration).not.toContain('encrypted_payload');
    expect(migration).toContain('limit 25');
  });

  it('does not grant anonymous callers access', () => {
    expect(migration).toContain(
      'revoke all on function public.get_platform_health_workspace() from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_platform_health_workspace() to authenticated',
    );
  });
});

describe('platform health workspace web contract', () => {
  it('validates the payload and labels the boundary honestly', () => {
    expect(api).toContain('const resultSchema = z.object({');
    expect(api).toContain("rpc('get_platform_health_workspace'");
    expect(workspace).toContain('not claimed without a monitoring source.');
    expect(workspace).toContain("['platform-health-workspace']");
  });

  it('routes the real Super Admin health screen before the fallback', () => {
    expect(route).toContain("role === 'super-admin' && slug[0] === 'platform-health'");
    expect(route.indexOf('<PlatformHealthWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
