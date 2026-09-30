import { describe, expect, it } from 'vitest';
import {
  normalizeGoogleLead,
  parseGoogleLeadEnvelope,
} from '../../src/lib/providers/google-lead-form-adapter';
import { mappedLeadValues } from '../../src/lib/providers/lead-field-mapping';
import { normalizeMetaLead } from '../../src/lib/providers/meta-lead-adapter';

// A dealership form whose columns the built-in guesses do not recognise.
const metaLead = {
  campaign_name: 'Monsoon SUV Lead Campaign',
  ad_name: 'Creta Night Drive',
  platform: 'facebook',
  field_data: [
    { name: 'Customer_Full_Name', values: ['Nisha Rao'] },
    { name: 'WhatsApp_Number', values: ['98450 12345'] },
    { name: 'Which_Car', values: ['Creta SX'] },
  ],
};

describe('ad column mapping at ingestion', () => {
  it('fills CRM fields from mapped ad columns that the default guesses miss', () => {
    const lead = normalizeMetaLead(metaLead, {
      externalLeadId: 'meta-lead-1',
      fieldMappings: [
        { external_field: 'Customer_Full_Name', canonical_field: 'customerName' },
        { external_field: 'WhatsApp_Number', canonical_field: 'phone' },
        { external_field: 'Which_Car', canonical_field: 'interestedModel' },
      ],
    });
    expect(lead).toMatchObject({
      source: 'Facebook',
      customerName: 'Nisha Rao',
      phone: '+919845012345',
      interestedModel: 'Creta SX',
      campaign: 'Monsoon SUV Lead Campaign',
      externalLeadId: 'meta-lead-1',
    });
  });

  it('rejects the same lead when its columns are left unmapped', () => {
    expect(() => normalizeMetaLead(metaLead, { externalLeadId: 'meta-lead-1' })).toThrow(
      'META_LEAD_MINIMUM_FIELDS_MISSING',
    );
  });

  it('lets an ad-level attribute such as ad_name fill the campaign', () => {
    const lead = normalizeMetaLead(metaLead, {
      externalLeadId: 'meta-lead-1',
      fieldMappings: [
        { external_field: 'customer_full_name', canonical_field: 'customerName' },
        { external_field: 'whatsapp_number', canonical_field: 'phone' },
        { external_field: 'ad_name', canonical_field: 'campaign' },
      ],
    });
    expect(lead.campaign).toBe('Creta Night Drive');
  });

  it('prefers a mapped Google column over the default one', () => {
    const envelope = parseGoogleLeadEnvelope({
      lead_id: 'google-lead-9',
      google_key: 'server-configured-secret-value',
      campaign_id: 555,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Default Name' },
        { column_id: 'PHONE_NUMBER', string_value: '9873100001' },
        { column_name: 'Preferred Name', string_value: 'Aarav S' },
        { column_name: 'Campaign Label', string_value: 'Diwali Search' },
      ],
    });
    const lead = normalizeGoogleLead(envelope, [
      { external_field: 'Preferred Name', canonical_field: 'customerName' },
      { external_field: 'campaign label', canonical_field: 'campaign' },
    ]);
    expect(lead).toMatchObject({ customerName: 'Aarav S', campaign: 'Diwali Search' });
    expect(normalizeGoogleLead(envelope).customerName).toBe('Default Name');
  });

  it('never lets a form column set the source, branch or provider lead ID', () => {
    const values = mappedLeadValues(
      new Map([
        ['src', 'Google Ads'],
        ['branch', 'b-1'],
        ['id', 'forged'],
      ]),
      [
        { external_field: 'src', canonical_field: 'source' },
        { external_field: 'branch', canonical_field: 'preferredBranchId' },
        { external_field: 'id', canonical_field: 'externalLeadId' },
      ],
    );
    expect(values).toEqual({});
  });
});
