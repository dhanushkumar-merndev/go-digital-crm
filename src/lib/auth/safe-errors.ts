export type AuthErrorContext =
  'SIGN_IN' | 'PASSWORD_RESET_REQUEST' | 'PASSWORD_UPDATE' | 'RECOVERY_SESSION' | 'SIGN_OUT';

const safeMessages: Record<AuthErrorContext, string> = {
  SIGN_IN: 'The email or password was not accepted. Check your details and try again.',
  PASSWORD_RESET_REQUEST:
    'Password recovery could not be started right now. Wait a moment and try again.',
  PASSWORD_UPDATE: 'Your password could not be updated. Check the requirements and try again.',
  RECOVERY_SESSION:
    'This password recovery link is invalid or has expired. Request a new recovery email.',
  SIGN_OUT: 'You could not be signed out right now. Try again.',
};

export function getSafeAuthErrorMessage(context: AuthErrorContext) {
  return safeMessages[context];
}
