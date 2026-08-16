import { describe, expect, it } from 'vitest';
import { QUERY_GC_TIME_MS, QUERY_STALE_TIME_MS } from '../../src/lib/query/cache-policy';

describe('workspace cache policy', () => {
  it('keeps server data fresh for one hour by default', () => {
    expect(QUERY_STALE_TIME_MS).toBe(60 * 60_000);
    expect(QUERY_GC_TIME_MS).toBe(2 * 60 * 60_000);
  });
});
