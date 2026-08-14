import { describe, expect, it } from 'vitest';
import { decideAccess, type AccessContext } from '../../src/lib/auth/access-decision';

const active: AccessContext = {
  authenticated: true,
  userActive: true,
  tenantStatus: 'ACTIVE',
  hasRoleAssignment: true,
  mfaRequired: false,
  mfaSatisfied: false,
  supportController: false,
};

describe('account access decision', () => {
  it('allows a valid active user', () =>
    expect(decideAccess(active)).toEqual({ allowed: true, destination: 'CRM' }));
  it('requires MFA before privileged access', () =>
    expect(decideAccess({ ...active, mfaRequired: true })).toEqual({
      allowed: false,
      destination: 'MFA',
    }));
  it('blocks normal users during support maintenance', () =>
    expect(decideAccess({ ...active, tenantStatus: 'SUPPORT_MAINTENANCE' })).toEqual({
      allowed: false,
      destination: 'MAINTENANCE',
    }));
  it('allows the authorized support controller during maintenance', () =>
    expect(
      decideAccess({ ...active, tenantStatus: 'SUPPORT_MAINTENANCE', supportController: true }),
    ).toEqual({ allowed: true, destination: 'CRM' }));
});
