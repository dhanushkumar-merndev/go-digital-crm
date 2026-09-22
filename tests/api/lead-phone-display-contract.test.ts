import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatInternationalPhone,
  formatNationalPhone,
  toDialableDigits,
  toTelHref,
  toWhatsAppClickToChatUrl,
} from '../../src/lib/phone';

const leadWorkspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const telecmi = readFileSync('supabase/functions/_shared/telecmi.ts', 'utf8');

describe('dialable phone digits', () => {
  it('adds the default country code to the shapes a telecaller actually types', () => {
    expect(toDialableDigits('9042606830')).toBe('919042606830');
    expect(toDialableDigits('09988838833')).toBe('919988838833');
    expect(toDialableDigits('+91 85939 39234')).toBe('918593939234');
  });

  it('leaves a number that already carries a country code untouched', () => {
    expect(toDialableDigits('919042606830')).toBe('919042606830');
    expect(toDialableDigits('917943445183')).toBe('917943445183');
    // Rewriting this into 91… would dial a real, unrelated Indian mobile.
    expect(toDialableDigits('+12025550102')).toBe('12025550102');
  });

  it('feeds the same digits to every outbound link', () => {
    expect(toWhatsAppClickToChatUrl('9042606830')).toBe('https://wa.me/919042606830');
    expect(toTelHref('9042606830')).toBe('tel:+919042606830');
  });
});

describe('phone display', () => {
  it('shows one ten-digit form whatever shape the row was stored in', () => {
    expect(formatNationalPhone('9042606830')).toBe('9042606830');
    expect(formatNationalPhone('919042606830')).toBe('9042606830');
    expect(formatNationalPhone('09042606830')).toBe('9042606830');
    expect(formatNationalPhone('+91 90426 06830')).toBe('9042606830');
  });

  it('keeps a foreign number international rather than faking ten Indian digits', () => {
    // '2025550102' in the Mobile column would read as an Indian mobile.
    expect(formatNationalPhone('+12025550102')).toBe('+12025550102');
  });

  it('puts the country code on the tooltip', () => {
    expect(formatInternationalPhone('9042606830')).toBe('+919042606830');
    expect(formatInternationalPhone('919042606830')).toBe('+919042606830');
  });

  it('never blanks a value it cannot parse', () => {
    expect(formatNationalPhone('')).toBe('');
    expect(formatNationalPhone('not a phone')).toBe('not a phone');
  });
});

describe('lead workspace and provider agree on the number', () => {
  it('renders the national form with the full number on hover', () => {
    expect(leadWorkspace).toContain('formatNationalPhone(phone)');
    expect(leadWorkspace).toContain('title={formatInternationalPhone(phone)}');
  });

  it('applies the same default country code server-side before dialling', () => {
    // customer_phone reaches the Edge Function straight from the row, so the
    // browser-side helper alone would not make the dialled number complete.
    expect(telecmi).toContain('raw.length === 10');
    expect(telecmi).toContain('`91${raw}`');
    expect(telecmi).toContain("raw.startsWith('0')");
    expect(telecmi).toContain('PHONE_NOT_INTERNATIONAL');
  });
});
