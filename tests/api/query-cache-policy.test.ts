import { describe, expect, it } from 'vitest';
import { QUERY_GC_TIME_MS, QUERY_STALE_TIME_MS } from '../../src/lib/query/cache-policy';

describe('workspace cache policy', () => {
  it('refetches active server data after one minute and bounds inactive memory', () => {
    expect(QUERY_STALE_TIME_MS).toBe(60_000);
    expect(QUERY_GC_TIME_MS).toBe(30 * 60_000);
  });
});
