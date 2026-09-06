import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function sign(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
) {
  return createHmac('sha256', secret)
    .update([method, path, timestamp, nonce, body].join('\n'))
    .digest('hex');
}

export function validSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
  now = Date.now(),
) {
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 60_000 ||
    !/^[0-9a-f-]{36}$/i.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(sign(secret, method, path, timestamp, nonce, body), 'hex'),
  );
}

export function encrypt(key: Buffer, context: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decrypt(key: Buffer, context: string, value: string) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('SESSION_CIPHERTEXT_INVALID');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64')), cipher.final()]).toString(
    'utf8',
  );
}

export function hasCapacity(count: number, limit: number, rss: number, memoryMb: number) {
  return count < Math.min(5, limit) && rss < memoryMb * 1024 * 1024 * 0.7;
}
