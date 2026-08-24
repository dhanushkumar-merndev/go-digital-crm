import { describe, expect, it } from 'vitest';
import {
  isValidTestDriveRegistration,
  normalizeTestDriveRegistration,
  sanitizeTestDriveRegistrationInput,
  TEST_DRIVE_REGISTRATION_MAX_LENGTH,
} from '../../src/features/test-drives/test-drive-registration';

describe('test-drive registration boundary', () => {
  it('accepts only the same 4–24 character alphabet enforced by PostgreSQL', () => {
    expect(isValidTestDriveRegistration('KA 01 AB 1234')).toBe(true);
    expect(isValidTestDriveRegistration('AB-1')).toBe(true);
    expect(isValidTestDriveRegistration('A'.repeat(TEST_DRIVE_REGISTRATION_MAX_LENGTH))).toBe(true);
    expect(isValidTestDriveRegistration('A-1')).toBe(false);
    expect(isValidTestDriveRegistration('A'.repeat(TEST_DRIVE_REGISTRATION_MAX_LENGTH + 1))).toBe(
      false,
    );
    expect(isValidTestDriveRegistration('KA_01')).toBe(false);
    expect(isValidTestDriveRegistration('KA/01')).toBe(false);
    expect(isValidTestDriveRegistration('KA०१')).toBe(false);
  });

  it('normalizes case and edges without inventing a registration', () => {
    expect(normalizeTestDriveRegistration('  ka 01 ab 1234  ')).toBe('KA 01 AB 1234');
    expect(normalizeTestDriveRegistration('')).toBe('');
  });

  it('filters unsupported typing and paste characters and enforces the backend maximum', () => {
    expect(sanitizeTestDriveRegistrationInput('ka@01_ab/1234🙂')).toBe('KA01AB1234');
    expect(sanitizeTestDriveRegistrationInput('ab - 12')).toBe('AB - 12');
    expect(sanitizeTestDriveRegistrationInput('a'.repeat(40))).toBe(
      'A'.repeat(TEST_DRIVE_REGISTRATION_MAX_LENGTH),
    );
  });
});
