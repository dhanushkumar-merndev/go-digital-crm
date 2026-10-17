import { describe, expect, it } from 'vitest';
import {
  normalizePortalPhone,
  normalizeSenderDomain,
  parsePortalEmail,
  parsePortalEmailLeads,
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

describe('portal email labels and roles', () => {
  const rules = portalEmailPresets.cardekho.rules;

  it('reads bare Customer / Buyer / Caller labels', () => {
    expect(
      parsePortalEmail('Customer: Asha Rao\nMobile: +91 90000 00101', rules).fields,
    ).toMatchObject({ customer_name: 'Asha Rao', phone: '+919000000101' });
    expect(
      parsePortalEmail(
        'Caller: Bala\nCaller number: +91 90000 00102',
        portalEmailPresets.justdial.rules,
      ).fields,
    ).toMatchObject({ customer_name: 'Bala', phone: '+919000000102' });
  });

  it('needs a separator after a label, so prose and compound words are not labels', () => {
    const result = parsePortalEmail(
      [
        'Billed to Demo Customer. Total Rs 5,000.',
        'This is a customer-facing acknowledgement.',
        'Contact account manager Ravi at +91 90000 00181.',
      ].join('\n'),
      rules,
    );
    expect(result.fields).toEqual({});
  });

  it('never takes a dealer, support or platform number as the customer', () => {
    const result = parsePortalEmail(
      [
        'Customer: Yash',
        'Seller mobile: +91 90000 00163',
        'Dealer mobile: +91 90000 00188',
        'Platform support: +91 90000 00199, support@portal.example',
      ].join('\n'),
      rules,
    );
    expect(result.fields).toMatchObject({ customer_name: 'Yash', phone: '+919000000163' });
    const onlyDealer = parsePortalEmail('Customer: Yash\nDealer mobile: +91 90000 00188', rules);
    expect(onlyDealer.ok).toBe(false);
    expect(onlyDealer.fields.phone).toBeUndefined();
  });

  it('treats placeholders and masked numbers as missing', () => {
    const result = parsePortalEmail(
      'Customer name: Not supplied\nMobile: +91 98XXX XX103\nEmail: Not provided',
      rules,
    );
    expect(result).toEqual({ fields: {}, missing: ['customer_name', 'phone'], ok: false });
  });

  it('does not read the line after a mid-line label', () => {
    const result = parsePortalEmail(
      '---------- Forwarded message ---------\nFrom: Notifications <n@portal.example>\nCustomer: Asha\nMobile: 9000000101',
      rules,
    );
    expect(result.fields.message).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('keeps the closing full stop of a message only', () => {
    const result = parsePortalEmail(
      'Customer: Asha.\nMobile: 9000000101\nRequest: Please send the on-road price.',
      rules,
    );
    expect(result.fields).toMatchObject({
      customer_name: 'Asha',
      message: 'Please send the on-road price.',
    });
  });

  it('reads a number or address that exists only in a tel: or mailto: link', () => {
    const html =
      '<p>Customer: Uma</p><p>Mobile: <a href="tel:+919000000161">Call customer</a></p>' +
      '<p>Contact email: <a href="mailto:uma@example.com">Email customer</a></p>';
    expect(parsePortalEmail(portalEmailHtmlToText(html), rules).fields).toMatchObject({
      customer_name: 'Uma',
      phone: '+919000000161',
      email: 'uma@example.com',
    });
  });
});

describe('portal email samples sent to the test mailbox', () => {
  it('takes the buyer mobile, not the seller (dealer) mobile, on a listing enquiry', () => {
    const result = parsePortalEmail(
      [
        'BUYER DETAILS',
        'Name: Meera Demo',
        'Mobile number: +91 90000 00404',
        'Buyer message:',
        'Is this car still available?',
        'Seller / dealership: Demo Auto Gallery',
        'Seller mobile: +91 90000 00777',
      ].join('\n'),
      portalEmailPresets.carwale.rules,
    );
    expect(result.fields).toMatchObject({
      customer_name: 'Meera Demo',
      phone: '+919000000404',
      message: 'Is this car still available?',
    });
  });

  it('reads "Mobile / Cell", "E-mail" and a heading whose text is on the next line', () => {
    const result = parsePortalEmail(
      [
        'Contact person: Kavya Demo',
        'Mobile / Cell: +91-90000-00202',
        'E-mail: kavya@example.com',
        'Product: Printed Corrugated Boxes',
        'Buyer message:',
        'Please quote for 500 boxes.',
      ].join('\n'),
      portalEmailPresets.indiamart.rules,
    );
    expect(result).toMatchObject({
      ok: true,
      fields: {
        customer_name: 'Kavya Demo',
        phone: '+919000000202',
        email: 'kavya@example.com',
        interested_model: 'Printed Corrugated Boxes',
        message: 'Please quote for 500 boxes.',
      },
    });
  });
});

describe('parsePortalEmailLeads', () => {
  const rules = portalEmailPresets.cardekho.rules;

  it('splits a digest so one customer never gets another customer number', () => {
    const records = parsePortalEmailLeads(
      [
        'Subject: CarDekho dealer enquiry digest',
        'Customer: Gita',
        'Contact email: gita@example.com',
        'Model: Punch',
        '---: Next enquiry',
        'Reference: CD-2',
        'Customer: Hari',
        'Mobile: +91 90000 00108',
        'Model: i20',
      ].join('\n'),
      rules,
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      ok: false,
      fields: { customer_name: 'Gita', email: 'gita@example.com', interested_model: 'Punch' },
    });
    expect(records[0].fields.phone).toBeUndefined();
    expect(records[1]).toMatchObject({
      ok: true,
      fields: { customer_name: 'Hari', phone: '+919000000108', interested_model: 'i20' },
    });
  });

  it('reads one lead when the same customer name repeats', () => {
    const records = parsePortalEmailLeads(
      'Customer Name: Ravi Kumar\nMobile: 9876543210\nSummary\nCustomer Name: Ravi Kumar\nCity: Pune',
      rules,
    );
    expect(records).toHaveLength(1);
    expect(records[0].fields).toMatchObject({
      customer_name: 'Ravi Kumar',
      phone: '+919876543210',
      location: 'Pune',
    });
  });
});
