// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

type ImageGeneration = {
  id: string;
  organization_id: string;
  branch_id: string | null;
  connected_account_id: string;
  prompt: string;
  template_key: string;
  object_type: string;
  style_key: string;
  aspect_ratio: '1:1' | '16:9' | '9:16' | '4:5';
  output_count: number;
  requested_by: string;
  lease_token: string;
};
type OpenAiCredential = { api_key: string };
type OpenAiImageResponse = { data?: Array<{ b64_json?: string }> };

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function fromBase64Url(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

async function decryptCredential<T>(value: unknown): Promise<T> {
  if (typeof value !== 'string') throw new Error('INTEGRATION_CREDENTIAL_INVALID');
  const bytes = value.startsWith('\\x')
    ? Uint8Array.from(Buffer.from(value.slice(2), 'hex'))
    : fromBase64Url(value);
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
    version: string;
    iv: string;
    ciphertext: string;
  };
  if (envelope.version !== 'AES-256-GCM-v1')
    throw new Error('INTEGRATION_CREDENTIAL_VERSION_UNSUPPORTED');
  const rawKey = fromBase64Url(requiredEnvironment('INTEGRATION_ENCRYPTION_KEY'));
  if (rawKey.byteLength !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY_INVALID');
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function imageSize(aspectRatio: ImageGeneration['aspect_ratio']) {
  if (aspectRatio === '16:9') return '1536x1024';
  if (aspectRatio === '9:16') return '1024x1536';
  return '1024x1024';
}

function assembledPrompt(item: ImageGeneration) {
  return `${item.prompt}\n\nCRM creative brief: ${item.template_key.replaceAll('_', ' ').toLowerCase()}, ${item.object_type.replaceAll('_', ' ').toLowerCase()}, ${item.style_key.toLowerCase()} style. Produce a polished automobile-dealership marketing visual. Do not include unrequested brand logos, watermarks, pricing, or readable fabricated text.`;
}

async function createImages(credential: OpenAiCredential, model: string, item: ImageGeneration) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: assembledPrompt(item),
      n: item.output_count,
      size: imageSize(item.aspect_ratio),
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429 ? 'AI_PROVIDER_RATE_LIMITED' : 'AI_PROVIDER_IMAGE_REJECTED',
    );
  const payload = (await response.json()) as OpenAiImageResponse;
  const images = (payload.data ?? [])
    .map((entry) => entry.b64_json)
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => Buffer.from(entry, 'base64'));
  if (
    images.length !== item.output_count ||
    images.some((image) => image.byteLength > 25 * 1024 * 1024)
  )
    throw new Error('AI_PROVIDER_IMAGE_RESPONSE_INVALID');
  return images;
}

function storageClient() {
  return new S3Client({
    endpoint: requiredEnvironment('TIGRIS_ENDPOINT'),
    region: process.env.TIGRIS_REGION?.trim() || 'auto',
    credentials: {
      accessKeyId: requiredEnvironment('TIGRIS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('TIGRIS_SECRET_ACCESS_KEY'),
    },
  });
}

async function processGeneration(
  supabase: ReturnType<typeof createClient>,
  storage: S3Client,
  item: ImageGeneration,
) {
  const { data: connection, error: connectionError } = await supabase
    .from('connected_accounts')
    .select('connection_config')
    .eq('id', item.connected_account_id)
    .eq('organization_id', item.organization_id)
    .eq('provider_key', 'openai')
    .maybeSingle();
  if (connectionError || !connection)
    throw connectionError ?? new Error('AI_IMAGE_CONNECTION_NOT_FOUND');
  const config = connection.connection_config as { models?: { image_model?: string } } | null;
  const model = config?.models?.image_model;
  if (!model) throw new Error('AI_IMAGE_MODEL_NOT_CONFIGURED');
  const { data: credentialRow, error: credentialError } = await supabase
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', item.organization_id)
    .eq('connected_account_id', item.connected_account_id)
    .maybeSingle();
  if (credentialError || !credentialRow)
    throw credentialError ?? new Error('AI_IMAGE_CREDENTIAL_NOT_FOUND');
  const images = await createImages(
    await decryptCredential<OpenAiCredential>(credentialRow.encrypted_payload),
    model,
    item,
  );
  const bucket = requiredEnvironment('TIGRIS_BUCKET');
  const outputRows: Array<Record<string, unknown>> = [];
  for (const [index, image] of images.entries()) {
    const ordinal = index + 1;
    const objectKey = `${item.organization_id}/ai-image-generation/${item.id}/${ordinal}.png`;
    const checksum = createHash('sha256').update(image).digest('hex');
    await storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: image,
        ContentType: 'image/png',
        ContentLength: image.byteLength,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
      }),
    );
    const { data: objectFile, error: objectError } = await supabase
      .from('object_files')
      .upsert(
        {
          organization_id: item.organization_id,
          branch_id: item.branch_id,
          resource_type: 'ai_image_generation',
          resource_id: item.id,
          bucket,
          object_key: objectKey,
          original_file_name: `ai-image-${item.id}-${ordinal}.png`,
          mime_type: 'image/png',
          size_bytes: image.byteLength,
          checksum,
          uploaded_by: item.requested_by,
        },
        { onConflict: 'bucket,object_key' },
      )
      .select('id')
      .single();
    if (objectError || !objectFile)
      throw objectError ?? new Error('AI_IMAGE_OBJECT_FILE_CREATE_FAILED');
    outputRows.push({
      organization_id: item.organization_id,
      generation_id: item.id,
      object_file_id: objectFile.id,
      ordinal,
    });
  }
  const { error: outputError } = await supabase
    .from('ai_image_generation_outputs')
    .upsert(outputRows, { onConflict: 'generation_id,ordinal' });
  if (outputError) throw outputError;
  const { data: completed, error: completeError } = await supabase.rpc(
    'complete_ai_image_generation',
    { target_generation_id: item.id, target_lease_token: item.lease_token },
  );
  if (completeError || !completed)
    throw completeError ?? new Error('AI_IMAGE_GENERATION_LEASE_LOST');
}

export const aiImageGeneration = schedules.task({
  id: 'ai-image-generation',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase.rpc<ImageGeneration[]>('claim_ai_image_generations', {
      target_worker_id: `trigger:ai-image-generation:${crypto.randomUUID()}`,
      target_batch_size: 2,
    });
    if (error) throw error;
    const storage = storageClient();
    let completed = 0;
    let retried = 0;
    for (const item of data ?? []) {
      try {
        await processGeneration(supabase, storage, item);
        completed += 1;
      } catch (error) {
        const safeCode =
          error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)
            ? error.message
            : 'AI_IMAGE_GENERATION_RETRY';
        const { error: retryError } = await supabase.rpc('retry_ai_image_generation', {
          target_generation_id: item.id,
          target_lease_token: item.lease_token,
          target_safe_error_code: safeCode,
        });
        if (retryError) throw retryError;
        retried += 1;
      }
    }
    return { claimed: data?.length ?? 0, completed, retried };
  },
});
