import { describe, expect, it, vi } from 'vitest';
import { MSG91_FLOW_URL, sendMsg91TemplateSms } from '../../src/lib/providers/msg91-sms-adapter';

const input = {
  credential: { authkey: 'private-tenant-key' },
  templateId: 'approved-template',
  recipient: '98765 43210',
  variables: { NAME: 'Dhanush', SOURCE: 'Facebook' },
};

describe('MSG91 SMS adapter', () => {
  it('uses the template API and preserves named variables and country code', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ type: 'success', message: 'request-id' }));
    await expect(sendMsg91TemplateSms(input, fetcher)).resolves.toBe('request-id');
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(MSG91_FLOW_URL);
    expect(request.headers.authkey).toBe(input.credential.authkey);
    expect(JSON.parse(request.body)).toEqual({
      template_id: input.templateId,
      short_url: '0',
      recipients: [{ mobiles: '919876543210', NAME: 'Dhanush', SOURCE: 'Facebook' }],
    });
  });

  it.each([
    [401, { message: 'private authentication details' }, 'DRIP_SMS_AUTH_FAILED', false],
    [418, { message: 'private IP details' }, 'DRIP_SMS_IP_NOT_ALLOWED', false],
    [429, {}, 'DRIP_SMS_RATE_LIMITED', true],
    [503, {}, 'DRIP_SMS_PROVIDER_UNAVAILABLE', true],
    [
      200,
      { type: 'error', code: '418', message: 'private details' },
      'DRIP_SMS_IP_NOT_ALLOWED',
      false,
    ],
    [200, { type: 'error', message: 'Invalid template' }, 'DRIP_SMS_TEMPLATE_INVALID', false],
    [200, { type: 'error', message: 'Rejected private content' }, 'DRIP_SMS_REJECTED', false],
  ])('handles a provider rejection with HTTP %s', async (status, payload, code, retryable) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload, { status }));
    await expect(sendMsg91TemplateSms(input, fetcher)).rejects.toMatchObject({
      code,
      retryable,
      message: code,
    });
  });

  it('does not submit an invalid phone or template', async () => {
    const fetcher = vi.fn();
    await expect(
      sendMsg91TemplateSms({ ...input, recipient: '123' }, fetcher),
    ).rejects.toMatchObject({ code: 'DRIP_SMS_RECIPIENT_INVALID' });
    await expect(
      sendMsg91TemplateSms({ ...input, templateId: '../invalid' }, fetcher),
    ).rejects.toMatchObject({ code: 'DRIP_SMS_TEMPLATE_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('handles connection failures without exposing provider details', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private provider details'));
    await expect(sendMsg91TemplateSms(input, fetcher)).rejects.toMatchObject({
      code: 'DRIP_SMS_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});
