import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registry = readFileSync('supabase/functions/dashboard-cache/registry.ts', 'utf8');
const edge = readFileSync('supabase/functions/dashboard-cache/index.ts', 'utf8');
const client = readFileSync('src/lib/query/cached-dashboard-api.ts', 'utf8');
const persisted = readFileSync('src/lib/query/persisted-query.ts', 'utf8');
const providers = readFileSync('src/components/providers/app-providers.tsx', 'utf8');
const realtime = readFileSync('src/lib/realtime/use-realtime-invalidation.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202610080401_dashboard_cache_version_dedupe.sql',
  'utf8',
);

const resources = [
  'tenant-dashboard',
  'inventory-dashboard',
  'platform-dashboard',
  'telecaller-performance',
  'sales-consultant-performance',
  'team-manager-performance',
  'gm-sales-analytics',
  'business-sales-overview',
  'business-showroom-performance',
  'business-showroom-analytics',
  'business-operations-overview',
];

describe('dashboard cache registry', () => {
  it.each(resources)(
    '%s is registered on the Edge function and known to the client',
    (resource) => {
      expect(registry).toContain(`'${resource}': {`);
      expect(client).toContain(`'${resource}',`);
    },
  );

  it('validates parameters against a strict allow-list before they reach an RPC', () => {
    expect(registry).toContain('.strict()');
    expect(registry).toContain('z.coerce.number().int().min(1).max(9999)');
    expect(edge).toContain('definition.params.safeParse(parsed.data.params)');
    expect(edge).toContain('isDashboardCacheResource(parsed.data.resource)');
  });

  it('keys every entry per user and keeps the data version out of the key', () => {
    expect(edge).toContain('user_id: userId,');
    expect(edge).toContain('version: context.version,');
    const fingerprint = edge.slice(
      edge.indexOf('fingerprintInput: {'),
      edge.indexOf('forceRefresh:'),
    );
    expect(fingerprint).not.toContain('version');
  });

  it('falls back to the direct RPC when the Edge path fails, except for a refused manual refresh', () => {
    expect(client).toContain('export async function fetchCachedAggregate');
    expect(client).toContain('error instanceof ManualDashboardRefreshLimitError) throw error;');
    expect(client).toContain('return input.direct();');
  });
});

describe('browser-persisted aggregates', () => {
  it('expires the IndexedDB copy with the dashboard freshness window and re-validates it', () => {
    expect(persisted).toContain(
      'const PERSISTED_QUERY_MAX_AGE_MS = DASHBOARD_QUERY_STALE_TIME_MS;',
    );
    expect(persisted).toContain('schema.safeParse(entry.data)');
    expect(persisted).toContain('{ updatedAt: entry.savedAt }');
  });

  it('clears persisted aggregates on sign-out and user switch', () => {
    expect(providers).toContain('void clearPersistedQueries();');
  });

  it('throttles aggregate refetches per query key with jitter', () => {
    expect(realtime).toContain('minIntervalMs?: number;');
    expect(realtime).toContain('const timerKey = `aggregate:${JSON.stringify(queryKey)}`;');
    expect(realtime).toContain('Math.random() * AGGREGATE_REFETCH_JITTER_MS');
  });
});

describe('cache version ledger', () => {
  it('bumps once per transaction and covers test drives and tasks', () => {
    expect(migration).toContain("pg_catalog.set_config(bumped_setting, '1', true)");
    expect(migration).toContain("pg_catalog.current_setting(bumped_setting, true) = '1'");
    expect(migration).toContain("array['test_drives', 'tasks']");
  });
});
