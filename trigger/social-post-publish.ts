// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type SocialPost = {
  id: string;
  organization_id: string;
  platform: 'FACEBOOK' | 'INSTAGRAM';
  content: string;
  connected_account_id: string | null;
  media_object_file_ids: string[];
  lease_token: string;
};
type MetaCredential = { access_token: string; page_id?: string; instagram_account_id?: string };

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

/**
 * Meta fetches the image from a URL it can reach, so a private object needs a
 * short-lived signed URL. It is minted per publish and never stored.
 */
async function signedMediaUrl(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  objectFileId: string,
) {
  const { data: file, error } = await supabase
    .from('object_files')
    .select('bucket,object_key')
    .eq('id', objectFileId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error || !file) throw error ?? new Error('SOCIAL_MEDIA_NOT_FOUND');
  const storage = new S3Client({
    endpoint: requiredEnvironment('TIGRIS_ENDPOINT'),
    region: process.env.TIGRIS_REGION?.trim() || 'auto',
    credentials: {
      accessKeyId: requiredEnvironment('TIGRIS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('TIGRIS_SECRET_ACCESS_KEY'),
    },
  });
  return getSignedUrl(
    storage,
    new GetObjectCommand({ Bucket: file.bucket, Key: file.object_key }),
    { expiresIn: 900 },
  );
}

function graphUrl(path: string) {
  return `https://graph.facebook.com/${requiredEnvironment('META_GRAPH_API_VERSION')}/${path}`;
}

async function publishFacebook(credential: MetaCredential, post: SocialPost, mediaUrl?: string) {
  if (!credential.page_id) throw new Error('SOCIAL_PAGE_NOT_CONFIGURED');
  // A photo post and a text post are different endpoints on the page.
  const endpoint = mediaUrl ? `${credential.page_id}/photos` : `${credential.page_id}/feed`;
  const body = mediaUrl
    ? { url: mediaUrl, caption: post.content, access_token: credential.access_token }
    : { message: post.content, access_token: credential.access_token };
  const response = await fetch(graphUrl(endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    id?: string;
    post_id?: string;
  } | null;
  if (!response.ok || !(payload?.post_id ?? payload?.id))
    throw new Error(
      response.status === 429 ? 'SOCIAL_PROVIDER_RATE_LIMITED' : 'SOCIAL_PROVIDER_REJECTED',
    );
  return (payload.post_id ?? payload.id) as string;
}

async function publishInstagram(credential: MetaCredential, post: SocialPost, mediaUrl?: string) {
  if (!credential.instagram_account_id) throw new Error('SOCIAL_INSTAGRAM_NOT_CONFIGURED');
  // Instagram will not accept a caption-only post.
  if (!mediaUrl) throw new Error('SOCIAL_IMAGE_REQUIRED');
  // Two steps by design: a container is created, then published.
  const container = await fetch(graphUrl(`${credential.instagram_account_id}/media`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image_url: mediaUrl,
      caption: post.content,
      access_token: credential.access_token,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const containerPayload = (await container.json().catch(() => null)) as { id?: string } | null;
  if (!container.ok || !containerPayload?.id) throw new Error('SOCIAL_PROVIDER_REJECTED');
  const published = await fetch(graphUrl(`${credential.instagram_account_id}/media_publish`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      creation_id: containerPayload.id,
      access_token: credential.access_token,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const publishedPayload = (await published.json().catch(() => null)) as { id?: string } | null;
  if (!published.ok || !publishedPayload?.id)
    throw new Error(
      published.status === 429 ? 'SOCIAL_PROVIDER_RATE_LIMITED' : 'SOCIAL_PROVIDER_REJECTED',
    );
  return publishedPayload.id;
}

async function publish(supabase: ReturnType<typeof createClient>, post: SocialPost) {
  if (!post.connected_account_id) throw new Error('SOCIAL_CONNECTION_NOT_AVAILABLE');
  const { data: secret, error } = await supabase
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('connected_account_id', post.connected_account_id)
    .eq('organization_id', post.organization_id)
    .maybeSingle();
  if (error || !secret) throw error ?? new Error('SOCIAL_CREDENTIAL_NOT_FOUND');
  const credential = await decryptCredential<MetaCredential>(secret.encrypted_payload);
  const mediaId = (post.media_object_file_ids ?? [])[0];
  const mediaUrl = mediaId
    ? await signedMediaUrl(supabase, post.organization_id, mediaId)
    : undefined;
  return post.platform === 'INSTAGRAM'
    ? publishInstagram(credential, post, mediaUrl)
    : publishFacebook(credential, post, mediaUrl);
}

export const socialPostPublish = schedules.task({
  id: 'social-post-publish',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: released } = await supabase.rpc('release_stalled_social_posts', {
      target_stale_minutes: 20,
    });
    const { data, error } = await supabase.rpc<SocialPost[]>('claim_due_social_posts', {
      target_worker_id: `trigger:social-post-publish:${crypto.randomUUID()}`,
      target_batch_size: 5,
    });
    if (error) throw error;
    let published = 0;
    let retried = 0;
    for (const post of data ?? []) {
      try {
        const providerPostId = await publish(supabase, post);
        const { error: completeError } = await supabase.rpc('complete_social_post', {
          target_post_id: post.id,
          target_lease_token: post.lease_token,
          target_provider_post_id: providerPostId,
        });
        if (completeError) throw completeError;
        published += 1;
      } catch (error) {
        const safeCode =
          error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)
            ? error.message
            : 'SOCIAL_PUBLISH_RETRY';
        const { error: retryError } = await supabase.rpc('retry_social_post', {
          target_post_id: post.id,
          target_lease_token: post.lease_token,
          target_safe_error_code: safeCode,
        });
        if (retryError) throw retryError;
        retried += 1;
      }
    }
    return { released: released ?? 0, claimed: data?.length ?? 0, published, retried };
  },
});
