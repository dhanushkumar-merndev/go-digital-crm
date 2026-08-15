import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createClient } from '@supabase/supabase-js';
import { task } from '@trigger.dev/sdk';

type Payload = {
  organizationId: string;
  branchId: string;
  callId: string;
  recordingId: string;
  providerRecordingUrl: string;
  mimeType: string;
  expectedBytes?: number;
};

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

async function fetchRecording(initialUrl: string, allowedHosts: string[], signal: AbortSignal) {
  let url = validatedProviderUrl(initialUrl, allowedHosts);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('PROVIDER_RECORDING_REDIRECT_INVALID');
    url = validatedProviderUrl(new URL(location, url).toString(), allowedHosts);
  }
  throw new Error('PROVIDER_RECORDING_TOO_MANY_REDIRECTS');
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

export const providerRecordingIngest = task({
  id: 'provider-recording-ingest',
  retry: {
    maxAttempts: 7,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (payload: Payload) => {
    const required = [
      'TIGRIS_ENDPOINT',
      'TIGRIS_BUCKET',
      'TIGRIS_ACCESS_KEY_ID',
      'TIGRIS_SECRET_ACCESS_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
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
    const response = await fetchRecording(
      payload.providerRecordingUrl,
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
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
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
          uploaded_by: null,
        },
        { onConflict: 'bucket,object_key' },
      )
      .select('id')
      .single();
    if (fileError) throw fileError;
    const { data: recording, error: recordingError } = await supabase
      .from('call_recordings')
      .update({ object_file_id: file.id, status: 'READY', checksum })
      .eq('id', payload.recordingId)
      .eq('organization_id', payload.organizationId)
      .eq('call_id', payload.callId)
      .select('id')
      .maybeSingle();
    if (recordingError || !recording) throw recordingError ?? new Error('CALL_RECORDING_NOT_FOUND');
    return { objectFileId: file.id, sizeBytes: actualBytes, checksum };
  },
});
