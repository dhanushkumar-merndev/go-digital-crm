import { describe, expect, it, vi } from 'vitest';
import { createDemoSessionProvider, demoJson } from '../e2e/demo-api.mjs';

const login = (token: string, expiresAt = 2_000) =>
  Response.json({ access_token: token, expires_at: expiresAt });
const config = {
  projectUrl: 'https://demo.example.invalid',
  anonKey: 'test-anon',
  password: 'test-only',
};

describe('E2E demo sessions', () => {
  it('reuses an unexpired session instead of signing in for every fixture read', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(login('sales-token'));
    const sessionFor = createDemoSessionProvider({ ...config, fetcher, now: () => 1_000_000 });
    expect(await sessionFor('sales_consultant')).toBe('sales-token');
    expect(await sessionFor('sales_consultant')).toBe('sales-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the two Sales identities separate for sibling privacy checks', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(login('primary'))
      .mockResolvedValueOnce(login('recipient'));
    const sessionFor = createDemoSessionProvider({ ...config, fetcher, now: () => 1_000_000 });
    expect(await sessionFor('sales_consultant')).toBe('primary');
    expect(await sessionFor('sales_consultant_2')).toBe('recipient');
    expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).email)).toEqual([
      'sales-consultant@demo.go-digital.invalid',
      'sales-consultant-2@demo.go-digital.invalid',
    ]);
  });

  it('deduplicates simultaneous sign-ins for one identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(login('sales-token'));
    const sessionFor = createDemoSessionProvider({ ...config, fetcher, now: () => 1_000_000 });
    expect(
      await Promise.all([sessionFor('sales_consultant'), sessionFor('sales_consultant')]),
    ).toEqual(['sales-token', 'sales-token']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renews before expiry instead of passing an expired JWT to RLS', async () => {
    let clock = 1_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(login('old', 1_100))
      .mockResolvedValueOnce(login('new', 2_000));
    const sessionFor = createDemoSessionProvider({ ...config, fetcher, now: () => clock });
    expect(await sessionFor('sales_consultant')).toBe('old');
    clock += 41_000;
    expect(await sessionFor('sales_consultant')).toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed authentication or retry it in a loop', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error_code: 'invalid_credentials' }, { status: 400 }))
      .mockResolvedValueOnce(login('valid'));
    const sessionFor = createDemoSessionProvider({ ...config, fetcher, now: () => 1_000_000 });
    await expect(sessionFor('sales_consultant')).rejects.toThrow(
      'Demo API HTTP 400: invalid_credentials',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await sessionFor('sales_consultant')).toBe('valid');
  });

  it('reports upstream non-JSON failures without printing their body', async () => {
    await expect(
      demoJson(new Response('upstream response containing private details', { status: 502 })),
    ).rejects.toThrow('Demo API returned non-JSON response (HTTP 502)');
  });

  it('does not guess an expiry when the authentication response omits it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'unknown-expiry' }))
      .mockResolvedValueOnce(login('fresh'));
    const sessionFor = createDemoSessionProvider({ ...config, fetcher, now: () => 1_000_000 });
    expect(await sessionFor('sales_consultant')).toBe('unknown-expiry');
    expect(await sessionFor('sales_consultant')).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
