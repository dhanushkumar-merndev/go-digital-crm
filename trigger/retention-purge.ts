import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

export const retentionPurge = schedules.task({
  id: 'retention-purge',
  cron: { pattern: '30 2 * * *', timezone: 'Asia/Kolkata' },
  run: async () => {
    if (
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !process.env.TIGRIS_ENDPOINT ||
      !process.env.TIGRIS_BUCKET ||
      !process.env.TIGRIS_ACCESS_KEY_ID ||
      !process.env.TIGRIS_SECRET_ACCESS_KEY
    )
      throw new Error('PURGE_CONFIGURATION_MISSING');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const storage = new S3Client({
      endpoint: process.env.TIGRIS_ENDPOINT,
      region: process.env.TIGRIS_REGION ?? 'auto',
      credentials: {
        accessKeyId: process.env.TIGRIS_ACCESS_KEY_ID,
        secretAccessKey: process.env.TIGRIS_SECRET_ACCESS_KEY,
      },
    });
    const { data: requests, error } = await supabase
      .from('deletion_requests')
      .select('id,organization_id,resource_type,resource_id')
      .eq('status', 'APPROVED')
      .lte('purge_after', new Date().toISOString())
      .limit(100);
    if (error) throw error;
    for (const request of requests ?? []) {
      const { data: files, error: filesError } = await supabase
        .from('object_files')
        .select('id,object_key')
        .eq('organization_id', request.organization_id)
        .eq('resource_type', request.resource_type)
        .eq('resource_id', request.resource_id)
        .is('deleted_at', null);
      if (filesError) throw filesError;
      for (const file of files ?? []) {
        await storage.send(
          new DeleteObjectCommand({ Bucket: process.env.TIGRIS_BUCKET, Key: file.object_key }),
        );
        await supabase
          .from('object_files')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', file.id);
      }
      const { error: rpcError } = await supabase.rpc('complete_controlled_purge', {
        target_deletion_request_id: request.id,
      });
      if (rpcError) throw rpcError;
    }
    return { processed: requests?.length ?? 0 };
  },
});
