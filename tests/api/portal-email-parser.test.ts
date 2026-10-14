import { describe, expect, it } from 'vitest';
import {
  normalizePortalPhone,
  normalizeSenderDomain,
  parsePortalEmail,
  portalEmailHtmlToText,
  portalEmailPresets,
  senderMatches,
  type PortalEmailRule,
} from '../../src/lib/providers/portal-email-parser';

describe('portal email sender domain', () => {
  it('derives the domain from an address, an @-prefix or a bare domain', () => {
    expect(normalizeSenderDomain('customer@cardekho.com')).toBe('cardekho.com');
    expect(normalizeSenderDomain(' @CarDekho.com ')).toBe('cardekho.com');
    expect(normalizeSenderDomain('cardekho.com')).toBe('cardekho.com');
    expect(normalizeSenderDomain('not a domain')).toBeNull();
    expect(normalizeSenderDomain('localhost')).toBeNull();
  });

  it('matches the domain and its subdomains but not lookalikes', () => {
    const domains = ['cardekho.com'];
    expect(senderMatches('customer@cardekho.com', domains)).toBe(true);
    expect(senderMatches('noreply@leads.cardekho.com', domains)).toBe(true);
    expect(senderMatches('x@notcardekho.com', domains)).toBe(false);
    expect(senderMatches('x@cardekho.com.evil.io', domains)).toBe(false);
    expect(senderMatches('no-at-sign', domains)).toBe(false);
  });
});

describe('portal email phone normalisation', () => {
  it('normalises Indian mobiles and rejects short numbers', () => {
    expect(normalizePortalPhone('98765 43210')).toBe('+919876543210');
    expect(normalizePortalPhone('09876543210')).toBe('+919876543210');
    expect(normalizePortalPhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalizePortalPhone('919876543210')).toBe('+919876543210');
    expect(normalizePortalPhone('Call 12345')).toBeNull();
  });
});

describe('parsePortalEmail', () => {
  const rules: PortalEmailRule[] = [
    { field: 'customer_name', keywords: ['Customer Name', 'Name'], capture: 'REST_OF_LINE' },
    { field: 'phone', keywords: ['Mobile'], capture: 'REST_OF_LINE' },
    { field: 'email', keywords: ['Email'], capture: 'NEXT_WORD' },
    { field: 'interested_model', keywords: ['Car Name', 'Model'], capture: 'REST_OF_LINE' },
    { field: 'location', keywords: ['City'], capture: 'NEXT_LINE' },
  ];

  it('reads label: value lines with each capture mode', () => {
    const result = parsePortalEmail(
      [
        'You have a new lead!',
        'Customer Name: Ravi Kumar',
        'Mobile: 98765 43210',
        'Email: ravi@example.com (verified)',
        'Car Name - Honda Elevate ZX',
        'City',
        'Bengaluru',
      ].join('\n'),
      rules,
    );
    expect(result).toEqual({
      ok: true,
      missing: [],
      fields: {
        customer_name: 'Ravi Kumar',
        phone: '+919876543210',
        email: 'ravi@example.com',
        interested_model: 'Honda Elevate ZX',
        location: 'Bengaluru',
      },
    });
  });

  it('prefers a label at the start of a line over the same word mid-sentence', () => {
    const result = parsePortalEmail(
      'Please call the customer by name soon.\nName: Sneha\nMobile: 9876543210',
      rules,
    );
    expect(result.fields.customer_name).toBe('Sneha');
  });

  it('does not let "Car Name" fill the customer name', () => {
    const result = parsePortalEmail('Car Name: Nexon\nName: Priya\nMobile: 9876543210', rules);
    expect(result.fields).toMatchObject({ customer_name: 'Priya', interested_model: 'Nexon' });
  });

  it('splits several labels on one line', () => {
    const result = parsePortalEmail('Name: Arun Das Mobile: 9876543210 Email: a@b.in', rules);
    expect(result.fields).toMatchObject({
      customer_name: 'Arun Das',
      phone: '+919876543210',
      email: 'a@b.in',
    });
  });

  it('reads HTML tables and Gmail-copied tab-separated rows the same way', () => {
    const html =
      '<html><head><style>td{color:red}</style></head><body><table>' +
      '<tr><td>Customer Name</td><td>Ravi &amp; Sons</td></tr>' +
      '<tr><td>Mobile</td><td>+91 98765 43210</td></tr>' +
      '</table></body></html>';
    const fromHtml = parsePortalEmail(portalEmailHtmlToText(html), rules);
    const fromCopy = parsePortalEmail('Customer Name\tRavi & Sons\nMobile\t+91 98765 43210', rules);
    expect(fromHtml.fields).toEqual({ customer_name: 'Ravi & Sons', phone: '+919876543210' });
    expect(fromCopy.fields).toEqual(fromHtml.fields);
  });

  it('takes the value from the next line when the label stands alone', () => {
    const result = parsePortalEmail('Customer Name\nMeera\nMobile\n9876543210', rules);
    expect(result.fields).toMatchObject({ customer_name: 'Meera', phone: '+919876543210' });
  });

  it('reports a missing name or phone as not ok', () => {
    const result = parsePortalEmail('Customer Name: Ravi\nMobile: call me', rules);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['phone']);
  });

  it('parses a typical email with every portal preset', () => {
    const email = [
      'Dear Dealer, a buyer enquired.',
      'Customer Name: Kiran',
      'Buyer Name: Kiran',
      'Caller Name: Kiran',
      'Mobile Number: 9876543210',
      'Email ID: kiran@example.com',
    ].join('\n');
    for (const preset of Object.values(portalEmailPresets)) {
      const result = parsePortalEmail(email, preset.rules);
      expect(result.ok).toBe(true);
      expect(result.fields).toMatchObject({
        customer_name: 'Kiran',
        phone: '+919876543210',
        email: 'kiran@example.com',
      });
    }
  });
});
