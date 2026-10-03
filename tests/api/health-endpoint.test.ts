import { describe, expect, it } from 'vitest';
import { GET, HEAD } from '../../src/app/api/health/route';

describe('public CRM health endpoint', () => {
  it('returns a non-cacheable healthy response without checking external dependencies', async () => {
    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(body).toMatchObject({
      status: 'ok',
      service: 'go-digital-marketing-crm',
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('supports lightweight HEAD checks', async () => {
    const response = HEAD();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});
