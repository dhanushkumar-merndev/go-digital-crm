import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { idempotencyKeys, task, tasks } from '@trigger.dev/sdk';

type Payload = {
  organizationId: string;
  branchId: string;
  callId: string;
  recordingId: string;
  providerRecordingUrl?: string;
  providerRecordingFile?: string;
  mimeType: string;
  expectedBytes?: number;
  connectionId?: string;
  provider?: 'telecmi';
};

type TelecmiCredential = { app_id: number; app_secret: string };

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function allowedRecordingHosts() {
  const entries = requiredEnvironment('IVR_RECORDING_ALLOWED_HOSTS')
    .split(',')
    .map((entry) => entry.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('IVR_RECORDING_ALLOWED_HOSTS_EMPTY');
  return entries;
}

function validatedProviderUrl(rawUrl: string, allowedHosts: string[]) {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLocaleLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isIP(hostname) !== 0
  )
    throw new Error('PROVIDER_RECORDING_URL_REJECTED');
  const allowed = allowedHosts.some((entry) =>
    entry.startsWith('*.')
      ? hostname.endsWith(entry.slice(1)) && hostname !== entry.slice(2)
      : hostname === entry,
  );
  if (!allowed) throw new Error('PROVIDER_RECORDING_HOST_NOT_ALLOWED');
  return url;
}

async function fetchRecording(
  initialUrl: string,
  allowedHosts: string[],
  signal: AbortSignal,
  headers: Record<string, string> = {},
) {
  let url = validatedProviderUrl(initialUrl, allowedHosts);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, { redirect: 'manual', signal, headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('PROVIDER_RECORDING_REDIRECT_INVALID');
    url = validatedProviderUrl(new URL(location, url).toString(), allowedHosts);
  }
  throw new Error('PROVIDER_RECORDING_TOO_MANY_REDIRECTS');
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

function maximumRecordingBytes() {
  const configured = Number(process.env.MAX_RECORDING_BYTES ?? 104_857_600);
  if (!Number.isSafeInteger(configured) || configured < 1_048_576 || configured > 1_073_741_824)
    throw new Error('MAX_RECORDING_BYTES_INVALID');
  return configured;
}

function acceptedMimeType(value: string) {
  const normalized = value.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? '';
  const allowed = new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/webm',
  ]);
  if (!allowed.has(normalized)) throw new Error('PROVIDER_RECORDING_MIME_REJECTED');
  return normalized;
}

const INGEST_MAX_ATTEMPTS = 7;

// Only codes the task raises itself reach the database; anything else (an AWS
// SDK or PostgREST error) is reported by family, never by its raw message.
function safeIngestErrorCode(error: unknown) {
  if (error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)) return error.message;
  if (error && typeof error === 'object' && '$metadata' in error) return 'TIGRIS_UPLOAD_FAILED';
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code).replace(/[^A-Z0-9]/gi, '');
    if (code) return `DATABASE_${code.toUpperCase()}`.slice(0, 100);
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'PROVIDER_RECORDING_TIMEOUT';
  return 'PROVIDER_RECORDING_INGEST_FAILED';
}

function recordingFileName(callId: string, mimeType: string) {
  const extension =
    mimeType === 'audio/mpeg'
      ? 'mp3'
      : mimeType === 'audio/wav' || mimeType === 'audio/x-wav'
        ? 'wav'
        : (mimeType.split('/')[1] ?? 'audio');
  const day = new Date().toISOString().slice(0, 10);
  return `call-recording-${day}-${callId.slice(0, 8)}.${extension}`;
}

async function ingestRecording(payload: Payload, supabase: SupabaseClient) {
  const required = [
    'TIGRIS_ENDPOINT',
    'TIGRIS_BUCKET',
    'TIGRIS_ACCESS_KEY_ID',
    'TIGRIS_SECRET_ACCESS_KEY',
  ] as const;
  for (const key of required) requiredEnvironment(key);
  const maximumBytes = maximumRecordingBytes();
  if (
    payload.expectedBytes !== undefined &&
    (!Number.isSafeInteger(payload.expectedBytes) ||
      payload.expectedBytes < 0 ||
      payload.expectedBytes > maximumBytes)
  )
    throw new Error('PROVIDER_RECORDING_EXPECTED_SIZE_INVALID');
  const requestedMimeType = acceptedMimeType(payload.mimeType);
  let providerRecordingUrl = payload.providerRecordingUrl;
  if (payload.provider === 'telecmi') {
    if (!payload.connectionId) throw new Error('TELECMI_CONNECTION_ID_REQUIRED');
    if (
      !payload.providerRecordingFile ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(payload.providerRecordingFile)
    )
      throw new Error('TELECMI_RECORDING_FILE_INVALID');
    const { data: credentialRow, error: credentialError } = await supabase
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', payload.organizationId)
      .eq('connected_account_id', payload.connectionId)
      .maybeSingle();
    if (credentialError || !credentialRow)
      throw credentialError ?? new Error('TELECMI_CREDENTIAL_NOT_FOUND');
    const credential = await decryptCredential<TelecmiCredential>(credentialRow.encrypted_payload);
    const recordingUrl = new URL('https://rest.telecmi.com/v2/play');
    recordingUrl.searchParams.set('appid', String(credential.app_id));
    recordingUrl.searchParams.set('secret', credential.app_secret);
    recordingUrl.searchParams.set('file', payload.providerRecordingFile);
    providerRecordingUrl = recordingUrl.toString();
  }
  if (!providerRecordingUrl) throw new Error('PROVIDER_RECORDING_URL_REQUIRED');
  const response = await fetchRecording(
    providerRecordingUrl,
    allowedRecordingHosts(),
    AbortSignal.timeout(5 * 60_000),
  );
  if (!response.ok || !response.body)
    throw new Error(`PROVIDER_RECORDING_DOWNLOAD_${response.status}`);
  const responseMimeType = acceptedMimeType(
    response.headers.get('content-type') ?? requestedMimeType,
  );
  if (responseMimeType !== requestedMimeType) throw new Error('PROVIDER_RECORDING_MIME_MISMATCH');
  const declaredBytes = Number(response.headers.get('content-length') ?? '0');
  if (declaredBytes > maximumBytes) throw new Error('PROVIDER_RECORDING_TOO_LARGE');

  let actualBytes = 0;
  const digest = createHash('sha256');
  const boundedStream = Readable.fromWeb(response.body as never).pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        actualBytes += chunk.byteLength;
        if (actualBytes > maximumBytes) {
          callback(new Error('PROVIDER_RECORDING_TOO_LARGE'));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    }),
  );
  const objectKey = `${payload.organizationId}/call-recordings/${payload.callId}/${payload.recordingId}`;
  const storage = new S3Client({
    endpoint: requiredEnvironment('TIGRIS_ENDPOINT'),
    region: process.env.TIGRIS_REGION ?? 'auto',
    credentials: {
      accessKeyId: requiredEnvironment('TIGRIS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('TIGRIS_SECRET_ACCESS_KEY'),
    },
  });
  await new Upload({
    client: storage,
    params: {
      Bucket: requiredEnvironment('TIGRIS_BUCKET'),
      Key: objectKey,
      Body: boundedStream,
      ContentType: responseMimeType,
    },
    leavePartsOnError: false,
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
  }).done();
  if (payload.expectedBytes !== undefined && actualBytes !== payload.expectedBytes) {
    await storage.send(
      new DeleteObjectCommand({ Bucket: requiredEnvironment('TIGRIS_BUCKET'), Key: objectKey }),
    );
    throw new Error('PROVIDER_RECORDING_SIZE_MISMATCH');
  }
  const checksum = digest.digest('hex');
  const { data: file, error: fileError } = await supabase
    .from('object_files')
    .upsert(
      {
        organization_id: payload.organizationId,
        branch_id: payload.branchId,
        resource_type: 'call',
        resource_id: payload.callId,
        bucket: requiredEnvironment('TIGRIS_BUCKET'),
        object_key: objectKey,
        mime_type: responseMimeType,
        size_bytes: actualBytes,
        checksum,
        original_file_name: recordingFileName(payload.callId, responseMimeType),
        uploaded_by: null,
      },
      { onConflict: 'bucket,object_key' },
    )
    .select('id')
    .single();
  if (fileError) throw fileError;
  const { data: recording, error: recordingError } = await supabase
    .from('call_recordings')
    .update({ object_file_id: file.id, status: 'READY', checksum, failure_code: null })
    .eq('id', payload.recordingId)
    .eq('organization_id', payload.organizationId)
    .eq('call_id', payload.callId)
    .select('id')
    .maybeSingle();
  if (recordingError || !recording) throw recordingError ?? new Error('CALL_RECORDING_NOT_FOUND');
  return { objectFileId: file.id, sizeBytes: actualBytes, checksum };
}

export const providerRecordingIngest = task({
  id: 'provider-recording-ingest',
  retry: {
    maxAttempts: INGEST_MAX_ATTEMPTS,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (payload: Payload, { ctx }) => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    try {
      return await ingestRecording(payload, supabase);
    } catch (error) {
      const finalAttempt = ctx.attempt.number >= INGEST_MAX_ATTEMPTS;
      // Best effort: the run still fails (and retries) if this write fails,
      // but a stuck recording now says why in the CRM, not only in Trigger.dev.
      await supabase
        .from('call_recordings')
        .update({
          failure_code: safeIngestErrorCode(error),
          ingest_attempts: ctx.attempt.number,
          last_ingest_attempt_at: new Date().toISOString(),
          ...(finalAttempt ? { status: 'FAILED' } : {}),
        })
        .eq('id', payload.recordingId)
        .eq('organization_id', payload.organizationId)
        .neq('status', 'READY');
      throw error;
    }
  },
});

/** One step of the per-minute pass: re-trigger TeleCMI recordings whose
 * ingest never finished. The claim RPC caps this at three sweeps per recording
 * and waits ten minutes after the last attempt, so a recording that keeps
 * failing settles instead of looping. */
export async function runStuckRecordingSweep(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('claim_stuck_call_recordings', { target_limit: 10 });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    recording_id: string;
    organization_id: string;
    branch_id: string;
    call_id: string;
    connection_id: string;
    provider_recording_id: string;
    sweep_count: number;
  }>;
  let triggered = 0;
  for (const row of rows) {
    const extension = row.provider_recording_id.split('.').pop()?.toLocaleLowerCase();
    const mimeType = extension === 'wav' ? 'audio/wav' : extension === 'mp3' ? 'audio/mpeg' : null;
    if (!mimeType) continue;
    const idempotencyKey = await idempotencyKeys.create(
      `telecmi-recording:${row.recording_id}:sweep:${row.sweep_count}`,
      { scope: 'global' },
    );
    await tasks.trigger<typeof providerRecordingIngest>(
      'provider-recording-ingest',
      {
        organizationId: row.organization_id,
        branchId: row.branch_id,
        callId: row.call_id,
        recordingId: row.recording_id,
        providerRecordingFile: row.provider_recording_id,
        mimeType,
        connectionId: row.connection_id,
        provider: 'telecmi',
      },
      { idempotencyKey },
    );
    triggered += 1;
  }
  return { claimed: rows.length, triggered };
}
