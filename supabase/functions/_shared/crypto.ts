type CipherEnvelope = {
  version: 'AES-256-GCM-v1';
  iv: string;
  ciphertext: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytea(value: Uint8Array) {
  return `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function parseBytea(value: string | Uint8Array) {
  if (value instanceof Uint8Array) return value;
  if (value.startsWith('\\x')) {
    const hex = value.slice(2);
    if (hex.length % 2 !== 0) throw new Error('INVALID_ENCRYPTED_PAYLOAD');
    return Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  return fromBase64Url(value);
}

async function encryptionKey() {
  const encoded = Deno.env.get('INTEGRATION_ENCRYPTION_KEY');
  if (!encoded) throw new Error('INTEGRATION_ENCRYPTION_KEY_MISSING');
  const raw = fromBase64Url(encoded);
  if (raw.byteLength !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(input: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await encryptionKey(),
      encoder.encode(JSON.stringify(input)),
    ),
  );
  const envelope: CipherEnvelope = {
    version: 'AES-256-GCM-v1',
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext),
  };
  return bytea(encoder.encode(JSON.stringify(envelope)));
}

export async function decryptJson<T>(input: string | Uint8Array): Promise<T> {
  const envelope = JSON.parse(decoder.decode(parseBytea(input))) as CipherEnvelope;
  if (envelope.version !== 'AES-256-GCM-v1') throw new Error('UNSUPPORTED_CIPHER_VERSION');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    await encryptionKey(),
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function randomBase64Url(size = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function sha256Base64Url(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
