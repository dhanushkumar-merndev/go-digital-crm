import { afterEach, describe, expect, it } from 'vitest';
import {
  MANUAL_REFRESH_LIMIT,
  MANUAL_REFRESH_WINDOW_MS,
  QUERY_STALE_TIME_MS,
  claimManualRefresh,
  getManualRefreshBudget,
  resetManualRefreshBudget,
} from '../../src/lib/query/cache-policy';

const resource = 'test-dashboard';
const start = 1_800_000_000_000;

afterEach(() => resetManualRefreshBudget());

describe('workspace cache policy', () => {
  it('keeps server data fresh for one hour by default', () => {
    expect(QUERY_STALE_TIME_MS).toBe(60 * 60_000);
  });

  it('allows only three manual refreshes in each ten-minute resource window', () => {
    for (let index = 0; index < MANUAL_REFRESH_LIMIT; index += 1)
      expect(claimManualRefresh(resource, start + index).allowed).toBe(true);

    const limited = claimManualRefresh(resource, start + 4);
    expect(limited.allowed).toBe(false);
    expect(limited.remaining).toBe(0);
    expect(limited.retryAt).toBe(start + MANUAL_REFRESH_WINDOW_MS);
    expect(getManualRefreshBudget(resource, start + MANUAL_REFRESH_WINDOW_MS + 1).allowed).toBe(
      true,
    );
  });
});
