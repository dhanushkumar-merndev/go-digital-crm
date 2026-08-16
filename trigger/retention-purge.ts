import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

type ClaimedPurge = {
  job_id: string;
  deletion_request_id: string;
  organization_id: string;
  manifest_id: string;
  lease_token: string;
  attempt_number: number;
};

type ManifestObject = {
  id: string;
  bucket: string;
  object_key: string;
};

type ManifestAuthIdentity = {
  id: string;
  user_id: string;
};

type PurgePhase = 'STORAGE' | 'AUTH' | 'DATA' | 'FINALIZE';

class ControlledPurgeError extends Error {
  constructor(
    readonly safeCode: string,
    readonly phase: PurgePhase,
    readonly itemId?: string,
    options?: ErrorOptions,
  ) {
    super(safeCode, options);
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function safeFailure(error: unknown, fallbackPhase: PurgePhase) {
  if (error instanceof ControlledPurgeError) return error;
  return new ControlledPurgeError('PURGE_UNEXPECTED_FAILURE', fallbackPhase, undefined, {
    cause: error,
  });
}

const workerIds = new Map<string, string>();

function claimWorkerId(claim: ClaimedPurge) {
  const workerId = workerIds.get(claim.job_id);
  if (!workerId) throw new Error('PURGE_WORKER_CONTEXT_MISSING');
  return workerId;
}

async function renewLease(supabase: SupabaseClient, claim: ClaimedPurge, phase: PurgePhase) {
  const { data, error } = await supabase.rpc('renew_controlled_purge_lease', {
    target_job_id: claim.job_id,
    target_worker_id: claimWorkerId(claim),
    target_lease_token: claim.lease_token,
  });
  if (error || data !== true)
    throw new ControlledPurgeError('PURGE_LEASE_RENEWAL_FAILED', phase, undefined, {
      cause: error,
    });
}

async function purgeStorage(
  supabase: SupabaseClient,
  storage: S3Client,
  configuredBucket: string,
  claim: ClaimedPurge,
) {
  while (true) {
    const { data, error } = await supabase
      .from('purge_manifest_objects')
      .select('id,bucket,object_key')
      .eq('manifest_id', claim.manifest_id)
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true })
      .limit(200);
    if (error)
      throw new ControlledPurgeError('PURGE_OBJECT_INVENTORY_READ_FAILED', 'STORAGE', undefined, {
        cause: error,
      });
    const objects = (data ?? []) as ManifestObject[];
    if (objects.length === 0) return;
    for (const object of objects) {
      // Revalidating the lease and legal-hold state before every irreversible
      // provider-side operation keeps a newly applied hold fail-closed.
      await renewLease(supabase, claim, 'STORAGE');
      if (object.bucket !== configuredBucket)
        throw new ControlledPurgeError('PURGE_OBJECT_BUCKET_NOT_ALLOWED', 'STORAGE', object.id);
      try {
        // S3 DeleteObject is idempotent. If the task crashes after this succeeds,
        // retrying the same locator is safe before the database item is marked.
        await storage.send(
          new DeleteObjectCommand({ Bucket: object.bucket, Key: object.object_key }),
        );
      } catch (error) {
        throw new ControlledPurgeError('PURGE_OBJECT_DELETE_FAILED', 'STORAGE', object.id, {
          cause: error,
        });
      }
      const { data: marked, error: markError } = await supabase.rpc('mark_purge_object_deleted', {
        target_job_id: claim.job_id,
        target_worker_id: claimWorkerId(claim),
        target_lease_token: claim.lease_token,
        target_manifest_object_id: object.id,
      });
      if (markError || marked !== true)
        throw new ControlledPurgeError('PURGE_OBJECT_MARK_FAILED', 'STORAGE', object.id, {
          cause: markError,
        });
    }
    await renewLease(supabase, claim, 'STORAGE');
  }
}

async function purgeAuthIdentities(supabase: SupabaseClient, claim: ClaimedPurge) {
  while (true) {
    const { data, error } = await supabase
      .from('purge_manifest_auth_identities')
      .select('id,user_id')
      .eq('manifest_id', claim.manifest_id)
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true })
      .limit(100);
    if (error)
      throw new ControlledPurgeError('PURGE_AUTH_INVENTORY_READ_FAILED', 'AUTH', undefined, {
        cause: error,
      });
    const identities = (data ?? []) as ManifestAuthIdentity[];
    if (identities.length === 0) return;
    for (const identity of identities) {
      await renewLease(supabase, claim, 'AUTH');
      // Supabase Auth soft deletion is irreversible and keeps only a hashed user
      // identifier. It also preserves the auth.users row needed by the profile FK.
      const { error: lookupError } = await supabase.auth.admin.getUserById(identity.user_id);
      const notFound = lookupError?.status === 404;
      if (lookupError && !notFound)
        throw new ControlledPurgeError('PURGE_AUTH_LOOKUP_FAILED', 'AUTH', identity.id, {
          cause: lookupError,
        });
      if (!notFound) {
        const { error: deleteError } = await supabase.auth.admin.deleteUser(identity.user_id, true);
        if (deleteError)
          throw new ControlledPurgeError('PURGE_AUTH_SOFT_DELETE_FAILED', 'AUTH', identity.id, {
            cause: deleteError,
          });
      }
      const { data: marked, error: markError } = await supabase.rpc(
        'mark_purge_auth_identity_deleted',
        {
          target_job_id: claim.job_id,
          target_worker_id: claimWorkerId(claim),
          target_lease_token: claim.lease_token,
          target_manifest_auth_id: identity.id,
          target_status: notFound ? 'NOT_FOUND' : 'SOFT_DELETED',
        },
      );
      if (markError || marked !== true)
        throw new ControlledPurgeError('PURGE_AUTH_MARK_FAILED', 'AUTH', identity.id, {
          cause: markError,
        });
    }
    await renewLease(supabase, claim, 'AUTH');
  }
}

async function purgeTenantData(supabase: SupabaseClient, claim: ClaimedPurge) {
  // Each RPC removes at most 5,000 rows from one explicitly allowlisted table.
  // This avoids an unbounded request while preserving FK-aware table ordering.
  for (let batch = 0; batch < 10_000; batch += 1) {
    const { data, error } = await supabase.rpc('purge_tenant_data_batch', {
      target_job_id: claim.job_id,
      target_worker_id: claimWorkerId(claim),
      target_lease_token: claim.lease_token,
      target_batch_size: 5_000,
    });
    if (error)
      throw new ControlledPurgeError('PURGE_DATA_BATCH_FAILED', 'DATA', undefined, {
        cause: error,
      });
    const result = data as { done?: boolean } | null;
    if (result?.done === true) return;
  }
  throw new ControlledPurgeError('PURGE_DATA_SLICE_LIMIT_REACHED', 'DATA');
}

async function finalizePurge(supabase: SupabaseClient, claim: ClaimedPurge) {
  const { data, error } = await supabase.rpc('finalize_controlled_tenant_purge', {
    target_job_id: claim.job_id,
    target_worker_id: claimWorkerId(claim),
    target_lease_token: claim.lease_token,
  });
  if (error || !(data as { completed?: boolean } | null)?.completed)
    throw new ControlledPurgeError('PURGE_FINALIZATION_FAILED', 'FINALIZE', undefined, {
      cause: error,
    });
}

async function recordRetry(
  supabase: SupabaseClient,
  claim: ClaimedPurge,
  failure: ControlledPurgeError,
) {
  const delaySeconds = Math.min(86_400, 300 * 2 ** Math.min(claim.attempt_number - 1, 8));
  const { data, error } = await supabase.rpc('retry_controlled_purge', {
    target_job_id: claim.job_id,
    target_worker_id: claimWorkerId(claim),
    target_lease_token: claim.lease_token,
    target_safe_error_code: failure.safeCode,
    target_phase: failure.phase,
    target_item_id: failure.itemId ?? null,
    target_delay_seconds: delaySeconds,
  });
  if (error || data !== true) throw error ?? new Error('PURGE_RETRY_RECORD_FAILED');
}

export const retentionPurge = schedules.task({
  id: 'retention-purge',
  // This hourly schedule is timezone-independent; UTC avoids relying on a
  // provider-specific alias for India Standard Time.
  cron: { pattern: '17 * * * *', timezone: 'UTC' },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const configuredBucket = requiredEnvironment('TIGRIS_BUCKET');
    const storage = new S3Client({
      endpoint: requiredEnvironment('TIGRIS_ENDPOINT'),
      region: process.env.TIGRIS_REGION ?? 'auto',
      credentials: {
        accessKeyId: requiredEnvironment('TIGRIS_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironment('TIGRIS_SECRET_ACCESS_KEY'),
      },
    });
    const workerId = `retention:${crypto.randomUUID()}`;
    let claimed = 0;
    let completed = 0;
    let scheduledForRetry = 0;
    // Claim immediately before processing so a later tenant never spends its
    // ten-minute lease waiting behind an earlier tenant in this same run.
    for (let slot = 0; slot < 5; slot += 1) {
      const { data, error } = await supabase.rpc('claim_controlled_purges', {
        target_worker_id: workerId,
        target_batch_size: 1,
      });
      if (error) throw error;
      const claim = ((data ?? []) as ClaimedPurge[])[0];
      if (!claim) break;
      claimed += 1;
      workerIds.set(claim.job_id, workerId);
      try {
        await purgeStorage(supabase, storage, configuredBucket, claim);
        await purgeAuthIdentities(supabase, claim);
        await purgeTenantData(supabase, claim);
        await finalizePurge(supabase, claim);
        completed += 1;
      } catch (error) {
        const failure = safeFailure(error, 'FINALIZE');
        await recordRetry(supabase, claim, failure);
        scheduledForRetry += 1;
      } finally {
        workerIds.delete(claim.job_id);
      }
    }
    return { claimed, completed, scheduled_for_retry: scheduledForRetry };
  },
});
