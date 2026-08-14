import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { task } from '@trigger.dev/sdk';

type Payload = {
  organizationId: string;
  branchId: string;
  callId: string;
  providerRecordingUrl: string;
  mimeType: string;
  expectedBytes?: number;
};

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
    const response = await fetch(payload.providerRecordingUrl);
    if (!response.ok || !response.body)
      throw new Error(`PROVIDER_RECORDING_DOWNLOAD_${response.status}`);
    const required = [
      'TIGRIS_ENDPOINT',
      'TIGRIS_BUCKET',
      'TIGRIS_ACCESS_KEY_ID',
      'TIGRIS_SECRET_ACCESS_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ] as const;
    for (const key of required) if (!process.env[key]) throw new Error(`${key}_MISSING`);
    const objectKey = `${payload.organizationId}/call-recordings/${payload.callId}/${crypto.randomUUID()}`;
    const storage = new S3Client({
      endpoint: process.env.TIGRIS_ENDPOINT,
      region: process.env.TIGRIS_REGION ?? 'auto',
      credentials: {
        accessKeyId: process.env.TIGRIS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TIGRIS_SECRET_ACCESS_KEY!,
      },
    });
    await storage.send(
      new PutObjectCommand({
        Bucket: process.env.TIGRIS_BUCKET!,
        Key: objectKey,
        Body: response.body,
        ContentType: payload.mimeType,
        ContentLength: payload.expectedBytes,
      }),
    );
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data: file, error: fileError } = await supabase
      .from('object_files')
      .insert({
        organization_id: payload.organizationId,
        branch_id: payload.branchId,
        resource_type: 'call',
        resource_id: payload.callId,
        bucket: process.env.TIGRIS_BUCKET!,
        object_key: objectKey,
        mime_type: payload.mimeType,
        size_bytes: payload.expectedBytes ?? 0,
        checksum: 'provider-streamed',
        uploaded_by: null,
      })
      .select('id')
      .single();
    if (fileError) throw fileError;
    const { error: recordingError } = await supabase
      .from('call_recordings')
      .update({ object_file_id: file.id, status: 'READY' })
      .eq('call_id', payload.callId);
    if (recordingError) throw recordingError;
    return { objectFileId: file.id };
  },
});
