/**
 * Returns an RFC 4122 version-4 UUID in both secure and plain-HTTP browser
 * contexts. `crypto.randomUUID` is unavailable in some browsers when the CRM
 * is opened through a LAN HTTP address, while request-idempotency keys still
 * need to be valid UUIDs there.
 */
export function createUuid() {
  const cryptoApi = globalThis.crypto;
  const nativeRandomUuid = cryptoApi?.randomUUID;
  if (typeof nativeRandomUuid === 'function' && nativeRandomUuid !== createUuid) {
    try {
      return nativeRandomUuid.call(cryptoApi);
    } catch {
      // Fall through to a version-4 UUID when the browser exposes the method
      // but denies it for the current (for example, non-secure) context.
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    // This fallback is only an idempotency/request identifier, never an auth
    // token, credential, reset secret, or authorization decision.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Older/insecure browser contexts can expose `crypto` without
 * `crypto.randomUUID`. Install the compatible function before child client
 * components render, so existing request-id call sites keep working.
 */
export function installRandomUuidFallback() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID === 'function') return;
  try {
    Object.defineProperty(cryptoApi, 'randomUUID', {
      configurable: true,
      value: createUuid,
    });
  } catch {
    // A non-extensible Crypto object is rare. New call sites use createUuid
    // directly, which remains safe without this compatibility installation.
  }
}
