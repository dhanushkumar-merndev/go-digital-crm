export class MissingProviderSecretError extends Error {
  constructor(label: string) {
    super(`${label} is required because this connection has no stored credential.`);
    this.name = 'MissingProviderSecretError';
  }
}

export function resolveStoredProviderSecret(
  enteredValue: string | undefined,
  storedValue: string | undefined,
  label: string,
) {
  const entered = enteredValue?.trim();
  if (entered) return entered;
  const stored = storedValue?.trim();
  if (stored) return stored;
  throw new MissingProviderSecretError(label);
}
