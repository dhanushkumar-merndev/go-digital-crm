import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasMobileSupabaseConfiguration } from '../../mobile/src/lib/runtime-config';

const layout = readFileSync('mobile/app/_layout.tsx', 'utf8');
const login = readFileSync('mobile/app/index.tsx', 'utf8');
const mobileExample = readFileSync('mobile/.env.example', 'utf8');
const validator = readFileSync('scripts/validate-env.mjs', 'utf8');

describe('mobile runtime configuration contract', () => {
  it('fails closed when either public Supabase value is missing or is the constructor fallback', () => {
    expect(hasMobileSupabaseConfiguration({})).toBe(false);
    expect(
      hasMobileSupabaseConfiguration({
        url: 'https://not-configured.invalid',
        anonKey: 'not-configured',
      }),
    ).toBe(false);
    expect(
      hasMobileSupabaseConfiguration({
        url: 'https://example.supabase.co',
        anonKey: 'public-anon-key-value',
      }),
    ).toBe(true);
  });

  it('blocks all routed screens and never exposes raw provider/network errors on login', () => {
    expect(layout).toContain('if (!mobileSupabaseConfigured)');
    expect(layout.indexOf('if (!mobileSupabaseConfigured)')).toBeLessThan(
      layout.indexOf('<Stack screenOptions'),
    );
    expect(login).toContain('if (!mobileSupabaseConfigured)');
    expect(login).not.toContain('setError(authError.message)');
    expect(login).toContain('The sign-in service could not be reached.');
  });

  it('documents only public mobile values and validates Expo project-local env files', () => {
    expect(mobileExample).toContain('EXPO_PUBLIC_SUPABASE_URL=');
    expect(mobileExample).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY=');
    expect(mobileExample).not.toMatch(/SERVICE_ROLE|SECRET|PROVIDER/);
    expect(validator).toContain("target === 'mobile' ? resolve(root, 'mobile') : root");
  });
});
