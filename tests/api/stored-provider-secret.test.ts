import { describe, expect, it } from 'vitest';
import {
  MissingProviderSecretError,
  resolveStoredProviderSecret,
} from '../../supabase/functions/_shared/stored-provider-secret';

describe('stored provider secret reuse', () => {
  it('keeps the encrypted value when an existing credential field is left blank', () => {
    expect(resolveStoredProviderSecret('', 'stored-token', 'Access token')).toBe('stored-token');
  });

  it('uses a newly entered value when rotating a credential', () => {
    expect(resolveStoredProviderSecret(' new-token ', 'stored-token', 'Access token')).toBe(
      'new-token',
    );
  });

  it('requires a value when no encrypted credential exists', () => {
    expect(() => resolveStoredProviderSecret('', undefined, 'Access token')).toThrow(
      MissingProviderSecretError,
    );
  });
});
