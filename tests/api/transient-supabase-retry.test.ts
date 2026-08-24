import { describe, expect, it } from 'vitest';
import { isTransientSupabaseError } from '../../src/lib/supabase/transient-error';

describe('Supabase retry classification', () => {
  it.each([
    { code: '08006', message: 'connection failure' },
    { code: 'PGRST001', message: 'database unavailable' },
    { code: '57P01', message: 'admin shutdown' },
    { status: 503, message: 'service unavailable' },
    { message: 'TypeError: fetch failed' },
  ])('retries transient infrastructure failures', (error) => {
    expect(isTransientSupabaseError(error)).toBe(true);
  });

  it.each([
    { code: '42501', message: 'permission denied' },
    { code: '22023', message: 'invalid query' },
    { code: 'PGRST202', message: 'function not found' },
    { code: '23505', message: 'unique violation' },
  ])('does not double authorization, validation, or contract failures', (error) => {
    expect(isTransientSupabaseError(error)).toBe(false);
  });
});
