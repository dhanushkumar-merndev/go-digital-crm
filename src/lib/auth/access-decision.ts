import type { TenantStatus } from '@/lib/domain';

export type AccessContext = {
  authenticated: boolean;
  userActive: boolean;
  tenantStatus: TenantStatus;
  hasRoleAssignment: boolean;
  mfaRequired: boolean;
  mfaSatisfied: boolean;
  supportController: boolean;
};

export type AccessDecision =
  | { allowed: true; destination: 'CRM' }
  | {
      allowed: false;
      destination: 'LOGIN' | 'ACCOUNT_LOCKED' | 'ONBOARDING' | 'MFA' | 'MAINTENANCE' | 'NO_ROLE';
    };

export function decideAccess(context: AccessContext): AccessDecision {
  if (!context.authenticated) return { allowed: false, destination: 'LOGIN' };
  if (
    !context.userActive ||
    ['SUSPENDED', 'REJECTED', 'SOFT_DELETED'].includes(context.tenantStatus)
  )
    return { allowed: false, destination: 'ACCOUNT_LOCKED' };
  if (['ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED'].includes(context.tenantStatus))
    return { allowed: false, destination: 'ONBOARDING' };
  if (!context.hasRoleAssignment) return { allowed: false, destination: 'NO_ROLE' };
  if (context.mfaRequired && !context.mfaSatisfied) return { allowed: false, destination: 'MFA' };
  if (context.tenantStatus === 'SUPPORT_MAINTENANCE' && !context.supportController)
    return { allowed: false, destination: 'MAINTENANCE' };
  return { allowed: true, destination: 'CRM' };
}
