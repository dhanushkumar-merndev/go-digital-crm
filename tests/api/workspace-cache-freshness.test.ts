import { describe, expect, it } from 'vitest';
import { classifyCacheEntry } from '../../supabase/functions/_shared/cache-freshness';

const builtAt = '2026-10-08T10:00:00.000Z';
const built = Date.parse(builtAt);
const minute = 60_000;

describe('workspace cache freshness', () => {
  it('serves an entry whose data version is current', () => {
    expect(
      classifyCacheEntry({ created_at: builtAt, data_version: 7 }, 7, built + 10 * minute, minute),
    ).toBe('HIT');
  });

  it('serves an entry written before data versions were stored', () => {
    expect(classifyCacheEntry({ created_at: builtAt }, 99, built + 10 * minute, minute)).toBe(
      'HIT',
    );
  });

  it('does not rebuild when the context version lags the entry', () => {
    expect(
      classifyCacheEntry({ created_at: builtAt, data_version: 8 }, 7, built + 10 * minute, minute),
    ).toBe('HIT');
  });

  it('keeps serving an out-of-date entry inside the minimum rebuild interval', () => {
    expect(
      classifyCacheEntry({ created_at: builtAt, data_version: 7 }, 8, built + 59_999, minute),
    ).toBe('STALE_SERVE');
  });

  it('rebuilds an out-of-date entry once the interval has passed', () => {
    expect(
      classifyCacheEntry({ created_at: builtAt, data_version: 7 }, 8, built + minute, minute),
    ).toBe('REBUILD');
  });

  it('rebuilds an out-of-date entry with an unreadable build time', () => {
    expect(
      classifyCacheEntry({ created_at: 'not-a-date', data_version: 7 }, 8, built, minute),
    ).toBe('REBUILD');
  });
});
