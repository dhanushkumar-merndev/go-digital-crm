import { describe, expect, it } from 'vitest';
import { canLinkMobileApp } from '../../src/lib/auth/mobile-link-policy';
import {
  getPasswordRecoveryRedirectPath,
  PASSWORD_UPDATE_PATH,
} from '../../src/lib/auth/recovery-redirect';
import { getSafeAuthErrorMessage } from '../../src/lib/auth/safe-errors';

describe('authentication domain policies', () => {
  it('limits mobile linking to MVP field roles', () => {
    expect(canLinkMobileApp('telecaller')).toBe(true);
    expect(canLinkMobileApp('sales-consultant')).toBe(true);
    expect(canLinkMobileApp('team-manager')).toBe(false);
    expect(canLinkMobileApp('super-admin')).toBe(false);
  });

  it('never accepts an external password-recovery destination', () => {
    expect(getPasswordRecoveryRedirectPath('/reset-password')).toBe(PASSWORD_UPDATE_PATH);
    expect(getPasswordRecoveryRedirectPath('https://attacker.example')).toBe(PASSWORD_UPDATE_PATH);
    expect(getPasswordRecoveryRedirectPath('//attacker.example')).toBe(PASSWORD_UPDATE_PATH);
  });

  it('uses stable safe messages instead of provider error details', () => {
    expect(getSafeAuthErrorMessage('SIGN_IN')).not.toContain('user not found');
    expect(getSafeAuthErrorMessage('PASSWORD_RESET_REQUEST')).not.toContain('email exists');
    expect(getSafeAuthErrorMessage('RECOVERY_SESSION')).toContain('invalid');
  });
});
