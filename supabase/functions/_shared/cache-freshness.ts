// Pure freshness rule for workspace cache entries. Kept free of Deno APIs so
// the API test suite can exercise it directly.

export type CacheEntryDecision = 'HIT' | 'STALE_SERVE' | 'REBUILD';

/**
 * HIT: the entry reflects the current data version (entries written before
 * versions were stored match by construction: their key carried the version).
 * STALE_SERVE: out of date, but built inside the minimum rebuild interval.
 * REBUILD: out of date and old enough to rebuild from PostgreSQL.
 */
export function classifyCacheEntry(
  entry: { created_at: string; data_version?: number },
  currentVersion: number,
  nowMs: number,
  minRebuildIntervalMs: number,
): CacheEntryDecision {
  if (entry.data_version === undefined || entry.data_version >= currentVersion) return 'HIT';
  const builtAt = Date.parse(entry.created_at);
  if (Number.isFinite(builtAt) && nowMs - builtAt < minRebuildIntervalMs) return 'STALE_SERVE';
  return 'REBUILD';
}
