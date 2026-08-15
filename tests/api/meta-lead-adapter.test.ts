import { describe, expect, it } from 'vitest';
import {
  extractMetaLeadEvents,
  normalizeMetaLead,
} from '../../src/lib/providers/meta-lead-adapter';

describe('Meta Lead Ads provider boundary', () => {
  it('extracts only leadgen changes and uses the provider lead ID for idempotency', () => {
    const events = extractMetaLeadEvents({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          changes: [
            { field: 'feed', value: { post_id: 'ignored' } },
            {
              field: 'leadgen',
              value: { leadgen_id: 'lead-42', page_id: 'page-1', form_id: 'form-9' },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        eventId: 'leadgen:lead-42',
        leadId: 'lead-42',
        pageId: 'page-1',
        formId: 'form-9',
        occurredAt: undefined,
      },
    ]);
  });

  it('normalizes required identity fields without creating a customer ID from phone', () => {
    const lead = normalizeMetaLead(
      {
        campaign_name: 'August Drive',
        platform: 'instagram',
        field_data: [
          { name: 'first_name', values: ['Diya'] },
          { name: 'last_name', values: ['Patel'] },
          { name: 'phone_number', values: ['09873 100 001'] },
          { name: 'email', values: ['diya@example.com'] },
          { name: 'car_model', values: ['Nexon EV'] },
        ],
      },
      { externalLeadId: 'lead-42' },
    );
    expect(lead).toMatchObject({
      source: 'Instagram',
      customerName: 'Diya Patel',
      phone: '+919873100001',
      campaign: 'August Drive',
      externalLeadId: 'lead-42',
    });
    expect(lead).not.toHaveProperty('customerId');
  });
});
