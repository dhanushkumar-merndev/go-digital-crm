import { S3Client } from 'npm:@aws-sdk/client-s3@3.1110.0';

function requiredEnvironment(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

let cachedClient: S3Client | undefined;

export function tigrisClient() {
  cachedClient ??= new S3Client({
    endpoint: requiredEnvironment('TIGRIS_ENDPOINT'),
    region: Deno.env.get('TIGRIS_REGION')?.trim() || 'auto',
    credentials: {
      accessKeyId: requiredEnvironment('TIGRIS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('TIGRIS_SECRET_ACCESS_KEY'),
    },
  });
  return cachedClient;
}

export function tigrisBucket() {
  return requiredEnvironment('TIGRIS_BUCKET');
}

export function safeObjectFileName(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function attachmentDisposition(fileName: string) {
  const normalized = safeObjectFileName(fileName) || 'download';
  const fallback = normalized.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(normalized)}`;
}
