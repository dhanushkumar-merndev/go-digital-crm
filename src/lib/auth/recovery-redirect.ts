export const PASSWORD_UPDATE_PATH = '/reset-password';

export function getPasswordRecoveryRedirectPath(requestedPath: string | null | undefined) {
  return requestedPath === PASSWORD_UPDATE_PATH ? requestedPath : PASSWORD_UPDATE_PATH;
}
