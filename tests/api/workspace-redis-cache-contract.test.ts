import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shared = readFileSync('supabase/functions/_shared/workspace-cache.ts', 'utf8');
const edge = readFileSync('supabase/functions/dashboard-cache/index.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202608150041_workspace_redis_cache.sql',
  'utf8',
);
const environment = readFileSync('.env.example', 'utf8');
const validator = readFileSync('scripts/validate-env.mjs', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');

describe('workspace Redis cache contract', () => {
  it('keeps Upstash configuration server-side and safely optional before setup', () => {
    for (const name of [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'UPSTASH_REDIS_CACHE_PREFIX',
      'UPSTASH_REDIS_ENABLED',
    ]) {
      expect(environment).toContain(`${name}=`);
      expect(validator).toContain(name);
    }
    expect(environment).not.toContain('NEXT_PUBLIC_UPSTASH');
    expect(environment).not.toContain('EXPO_PUBLIC_UPSTASH');
    expect(shared).toContain("Deno.env.get('UPSTASH_REDIS_REST_TOKEN')");
  });

  it('hashes role/scope/version cache identity and does not cache live customer preview data', () => {
    expect(shared).toContain("crypto.subtle.digest('SHA-256'");
    expect(edge).toContain('scope_subject: context.scope_subject');
    expect(edge).toContain('permissions_fingerprint: context.permissions_fingerprint');
    expect(edge).toContain('version: context.version');
    expect(edge).not.toContain('lead_preview');
    expect(edge).not.toContain('customer_name');
    expect(edge).not.toContain('phone');
  });

  it('uses one bounded NX lock and Redis-enforced three-per-ten-minute refresh limit', () => {
    expect(shared).toContain("['SET', key, value, 'NX', 'PX', ttlMs]");
    expect(shared).toContain('MANUAL_REFRESH_LIMIT = 3');
    expect(shared).toContain('MANUAL_REFRESH_WINDOW_MS = 10 * 60_000');
    expect(shared).toContain('forceRefresh?: boolean');
    expect(edge).toContain('forceRefresh: parsed.data.manual_refresh');
    expect(edge).toContain("'MANUAL_REFRESH_LIMITED'");
    expect(shared).toContain('CacheBusyError');
  });

  it('uses authenticated Edge callers and cache-version triggers rather than trusting a browser key', () => {
    expect(config).toContain('[functions.dashboard-cache]');
    expect(config).toContain('[functions.dashboard-cache]\nverify_jwt = true');
    expect(edge).toContain('authenticatedClient(request)');
    expect(edge).toContain("'get_workspace_cache_context'");
    expect(migration).toContain('bump_workspace_cache_version');
    expect(migration).toContain('workspace_cache_inventory_dashboard');
    expect(migration).toContain('workspace_cache_platform_dashboard');
  });
});
