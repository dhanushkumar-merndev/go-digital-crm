import { describe, expect, it } from 'vitest';
import { extractWhatsAppEvents } from '../../src/lib/providers/whatsapp-cloud-adapter';

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
