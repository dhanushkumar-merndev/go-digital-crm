export type PlatformAiCreditAllocationFailure =
  'MFA_REQUIRED' | 'ORGANIZATION_NOT_ACTIVE' | 'INVALID_INPUT' | 'REQUEST_CONFLICT' | 'UNKNOWN';

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== 'object') return '';

  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' ? message : '';
}

export function classifyPlatformAiCreditAllocationFailure(
  error: unknown,
): PlatformAiCreditAllocationFailure {
  switch (errorMessage(error)) {
    case 'SUPER_ADMIN_MFA_REQUIRED':
      return 'MFA_REQUIRED';
    case 'AI_CREDIT_ORGANIZATION_NOT_ACTIVE':
      return 'ORGANIZATION_NOT_ACTIVE';
    case 'INVALID_AI_CREDIT_ALLOCATION':
      return 'INVALID_INPUT';
    case 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT':
      return 'REQUEST_CONFLICT';
    default:
      return 'UNKNOWN';
  }
}

export function platformAiCreditAllocationFailureDescription(
  failure: PlatformAiCreditAllocationFailure,
) {
  switch (failure) {
    case 'MFA_REQUIRED':
      return 'Your Super Admin MFA session has expired. Verify MFA and retry.';
    case 'ORGANIZATION_NOT_ACTIVE':
      return 'This dealership is not active. Approve its onboarding before adding AI credits.';
    case 'INVALID_INPUT':
      return 'Enter 1–1,000,000 credits and an allocation reason of at least 5 characters.';
    case 'REQUEST_CONFLICT':
      return 'This allocation request changed. Close the dialog and start a new allocation.';
    default:
      return 'The allocation result could not be confirmed. Retry with the same values; the request ID prevents duplicate credits.';
  }
}
