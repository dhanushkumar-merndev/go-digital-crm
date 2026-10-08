import { describe, expect, it } from 'vitest';
import {
  classifyWhatsAppGraphError,
  extractWhatsAppEvents,
} from '../../src/lib/providers/whatsapp-cloud-adapter';

describe('WhatsApp Business Cloud webhook normalization', () => {
  it('normalizes inbound text and delivery status events without inventing a customer', () => {
    const result = extractWhatsAppEvents({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-1' },
                contacts: [{ wa_id: '919873100001', profile: { name: 'Diya Patel' } }],
                messages: [
                  {
                    id: 'wamid.inbound',
                    from: '919873100001',
                    timestamp: '1786782000',
                    type: 'text',
                    text: { body: 'I would like a test drive.' },
                  },
                ],
                statuses: [
                  {
                    id: 'wamid.outbound',
                    recipient_id: '919873100001',
                    timestamp: '1786782010',
                    status: 'delivered',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(result.messages[0]).toMatchObject({
      eventId: 'whatsapp-message:wamid.inbound',
      senderName: 'Diya Patel',
      body: 'I would like a test drive.',
    });
    expect(result.messages[0]).not.toHaveProperty('customerId');
    expect(result.statuses[0]).toMatchObject({
      providerMessageId: 'wamid.outbound',
      status: 'DELIVERED',
    });
  });
});

describe('WhatsApp Graph connection-test errors', () => {
  const graphError = (code: number, subcode?: number) => ({
    error: {
      message: 'Error validating access token: EAAG-should-never-leak',
      type: 'OAuthException',
      code,
      error_subcode: subcode,
      fbtrace_id: 'trace-1',
    },
  });

  it('names an expired token separately from an invalid one', () => {
    const expired = classifyWhatsAppGraphError(401, graphError(190, 463));
    expect(expired.code).toBe('WHATSAPP_TOKEN_INVALID');
    expect(expired.message).toMatch(/expired/);
    expect(classifyWhatsAppGraphError(401, graphError(190, 467)).message).not.toMatch(/expired/);
  });

  it('points at the System User asset assignment when the phone number is invisible', () => {
    expect(classifyWhatsAppGraphError(400, graphError(100, 33)).code).toBe(
      'WHATSAPP_ASSET_NOT_ASSIGNED',
    );
    expect(classifyWhatsAppGraphError(400, graphError(100)).code).toBe(
      'WHATSAPP_PHONE_NUMBER_ID_INVALID',
    );
  });

  it('classifies permission, rate-limit and Meta-side failures', () => {
    expect(classifyWhatsAppGraphError(403, graphError(200)).code).toBe(
      'WHATSAPP_PERMISSION_MISSING',
    );
    expect(classifyWhatsAppGraphError(400, graphError(80007)).status).toBe(429);
    expect(classifyWhatsAppGraphError(500, graphError(2)).code).toBe(
      'WHATSAPP_PROVIDER_UNAVAILABLE',
    );
    expect(classifyWhatsAppGraphError(502, null).status).toBe(502);
  });

  it('keeps only numeric codes and the trace ID, never Graph message text', () => {
    const failure = classifyWhatsAppGraphError(400, graphError(9999, 12));
    expect(failure.code).toBe('WHATSAPP_CONNECTION_TEST_FAILED');
    expect(failure.message).toContain('Meta error 9999/12');
    expect(JSON.stringify(failure)).not.toContain('EAAG');
    expect(failure).toMatchObject({
      providerCode: 9999,
      providerSubcode: 12,
      fbtraceId: 'trace-1',
    });
  });
});
