import { describe, expect, it } from 'vitest';
import {
  normalizeGoogleLead,
  parseGoogleLeadEnvelope,
} from '../../src/lib/providers/google-lead-form-adapter';

const providerPayload = {
  lead_id: 'google-lead-17',
  campaign_id: 10000000000,
  form_id: 123456789,
  google_key: 'server-configured-secret-value',
  is_test: false,
  user_column_data: [
    { column_id: 'FULL_NAME', string_value: 'Aarav Sharma' },
    { column_id: 'PHONE_NUMBER', string_value: '09873 100 001' },
    { column_id: 'EMAIL', string_value: 'aarav@example.com' },
  ],
};

describe('Google Ads lead form provider boundary', () => {
  it('retains the official anti-spoofing key outside the canonical lead', () => {
    const envelope = parseGoogleLeadEnvelope(providerPayload);
    expect(envelope.googleKey).toBe('server-configured-secret-value');
    expect(normalizeGoogleLead(envelope)).not.toHaveProperty('googleKey');
  });

  it('uses lead_id for idempotency and normalizes required fields', () => {
    const lead = normalizeGoogleLead(parseGoogleLeadEnvelope(providerPayload));
    expect(lead).toMatchObject({
      source: 'Google Ads',
      customerName: 'Aarav Sharma',
      phone: '+919873100001',
      email: 'aarav@example.com',
      campaign: '10000000000',
      externalLeadId: 'google-lead-17',
    });
  });
});
