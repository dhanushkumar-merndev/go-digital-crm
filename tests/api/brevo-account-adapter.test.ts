import { describe, expect, it, vi } from 'vitest';
import { verifyBrevoAccount } from '../../src/lib/providers/brevo-account-adapter';

describe('Brevo account check', () => {
  it('reads account identity without exposing provider secrets or sending email', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        email: 'sender@example.com',
        marketingAutomation: { key: 'private-key' },
        relay: { data: { userName: 'private-account' } },
      }),
    );
    await expect(verifyBrevoAccount('tenant-key', fetcher)).resolves.toEqual({
      email: 'sender@example.com',
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.brevo.com/v3/account');
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it.each([
    [401, { message: 'Unauthorized' }, 'BREVO_AUTH_FAILED'],
    [
      401,
      { message: 'We have detected you are using an unrecognised IP address' },
      'BREVO_IP_NOT_ALLOWED',
    ],
    [429, {}, 'BREVO_RATE_LIMITED'],
    [503, {}, 'BREVO_UNAVAILABLE'],
    [200, {}, 'BREVO_UNAVAILABLE'],
  ])('returns a safe error for HTTP %s', async (status, payload, code) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload, { status }));
    await expect(verifyBrevoAccount('tenant-key', fetcher)).rejects.toMatchObject({
      code,
      message: code,
    });
  });
});
