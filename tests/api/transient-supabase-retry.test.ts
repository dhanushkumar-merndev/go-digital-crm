import { describe, expect, it } from 'vitest';
import { isTransientSupabaseError } from '../../src/lib/supabase/transient-error';

describe('Supabase retry classification', () => {
  it.each([
    { code: '08006', message: 'connection failure' },
    { code: 'PGRST001', message: 'database unavailable' },
    { code: '57P01', message: 'admin shutdown' },
    { status: 503, message: 'service unavailable' },
    { message: 'TypeError: fetch failed' },
    // supabase-js wraps a browser network failure as `${name}: ${message}`, status 0.
    { status: 0, code: '', message: 'TypeError: Failed to fetch' },
    { status: 0, code: '', message: 'TypeError: Load failed' },
    { status: 0, code: '', message: 'TypeError: NetworkError when attempting to fetch resource.' },
  ])('retries transient infrastructure failures', (error) => {
    expect(isTransientSupabaseError(error)).toBe(true);
  });

  it.each([
    { code: '42501', message: 'permission denied' },
    { code: '22023', message: 'invalid query' },
    { code: 'PGRST202', message: 'function not found' },
    { code: '23505', message: 'unique violation' },
    { code: 20, message: 'The operation was aborted' },
  ])('does not double authorization, validation, or contract failures', (error) => {
    expect(isTransientSupabaseError(error)).toBe(false);
  });
});
