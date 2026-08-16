import {
  require_dist_cjs
} from "../../../../../chunk-CJ3ZKOD2.mjs";
import "../../../../../chunk-F3IKMDDZ.mjs";
import {
  createClient,
  dist_exports
} from "../../../../../chunk-YD4LEPU7.mjs";
import {
  schedules_exports
} from "../../../../../chunk-JF2PC2IM.mjs";
import {
  __name,
  __toESM,
  init_esm
} from "../../../../../chunk-265QJBBL.mjs";

// trigger/retention-purge.ts
init_esm();
var import_client_s3 = __toESM(require_dist_cjs());
var ControlledPurgeError = class extends Error {
  constructor(safeCode, phase, itemId, options) {
    super(safeCode, options);
    this.safeCode = safeCode;
    this.phase = phase;
    this.itemId = itemId;
  }
  static {
    __name(this, "ControlledPurgeError");
  }
};
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
function safeFailure(error, fallbackPhase) {
  if (error instanceof ControlledPurgeError) return error;
  return new ControlledPurgeError("PURGE_UNEXPECTED_FAILURE", fallbackPhase, void 0, {
    cause: error
  });
}
__name(safeFailure, "safeFailure");
var workerIds = /* @__PURE__ */ new Map();
function claimWorkerId(claim) {
  const workerId = workerIds.get(claim.job_id);
  if (!workerId) throw new Error("PURGE_WORKER_CONTEXT_MISSING");
  return workerId;
}
__name(claimWorkerId, "claimWorkerId");
async function renewLease(supabase, claim, phase) {
  const { data, error } = await supabase.rpc("renew_controlled_purge_lease", {
    target_job_id: claim.job_id,
    target_worker_id: claimWorkerId(claim),
    target_lease_token: claim.lease_token
  });
  if (error || data !== true)
    throw new ControlledPurgeError("PURGE_LEASE_RENEWAL_FAILED", phase, void 0, {
      cause: error
    });
}
__name(renewLease, "renewLease");
async function purgeStorage(supabase, storage, configuredBucket, claim) {
  while (true) {
    const { data, error } = await supabase.from("purge_manifest_objects").select("id,bucket,object_key").eq("manifest_id", claim.manifest_id).eq("status", "PENDING").order("created_at", { ascending: true }).limit(200);
    if (error)
      throw new ControlledPurgeError("PURGE_OBJECT_INVENTORY_READ_FAILED", "STORAGE", void 0, {
        cause: error
      });
    const objects = data ?? [];
    if (objects.length === 0) return;
    for (const object of objects) {
      await renewLease(supabase, claim, "STORAGE");
      if (object.bucket !== configuredBucket)
        throw new ControlledPurgeError("PURGE_OBJECT_BUCKET_NOT_ALLOWED", "STORAGE", object.id);
      try {
        await storage.send(
          new import_client_s3.DeleteObjectCommand({ Bucket: object.bucket, Key: object.object_key })
        );
      } catch (error2) {
        throw new ControlledPurgeError("PURGE_OBJECT_DELETE_FAILED", "STORAGE", object.id, {
          cause: error2
        });
      }
      const { data: marked, error: markError } = await supabase.rpc("mark_purge_object_deleted", {
        target_job_id: claim.job_id,
        target_worker_id: claimWorkerId(claim),
        target_lease_token: claim.lease_token,
        target_manifest_object_id: object.id
      });
      if (markError || marked !== true)
        throw new ControlledPurgeError("PURGE_OBJECT_MARK_FAILED", "STORAGE", object.id, {
          cause: markError
        });
    }
    await renewLease(supabase, claim, "STORAGE");
  }
}
__name(purgeStorage, "purgeStorage");
async function purgeAuthIdentities(supabase, claim) {
  while (true) {
    const { data, error } = await supabase.from("purge_manifest_auth_identities").select("id,user_id").eq("manifest_id", claim.manifest_id).eq("status", "PENDING").order("created_at", { ascending: true }).limit(100);
    if (error)
      throw new ControlledPurgeError("PURGE_AUTH_INVENTORY_READ_FAILED", "AUTH", void 0, {
        cause: error
      });
    const identities = data ?? [];
    if (identities.length === 0) return;
    for (const identity of identities) {
      await renewLease(supabase, claim, "AUTH");
      const { error: lookupError } = await supabase.auth.admin.getUserById(identity.user_id);
      const notFound = lookupError?.status === 404;
      if (lookupError && !notFound)
        throw new ControlledPurgeError("PURGE_AUTH_LOOKUP_FAILED", "AUTH", identity.id, {
          cause: lookupError
        });
      if (!notFound) {
        const { error: deleteError } = await supabase.auth.admin.deleteUser(identity.user_id, true);
        if (deleteError)
          throw new ControlledPurgeError("PURGE_AUTH_SOFT_DELETE_FAILED", "AUTH", identity.id, {
            cause: deleteError
          });
      }
      const { data: marked, error: markError } = await supabase.rpc(
        "mark_purge_auth_identity_deleted",
        {
          target_job_id: claim.job_id,
          target_worker_id: claimWorkerId(claim),
          target_lease_token: claim.lease_token,
          target_manifest_auth_id: identity.id,
          target_status: notFound ? "NOT_FOUND" : "SOFT_DELETED"
        }
      );
      if (markError || marked !== true)
        throw new ControlledPurgeError("PURGE_AUTH_MARK_FAILED", "AUTH", identity.id, {
          cause: markError
        });
    }
    await renewLease(supabase, claim, "AUTH");
  }
}
__name(purgeAuthIdentities, "purgeAuthIdentities");
async function purgeTenantData(supabase, claim) {
  for (let batch = 0; batch < 1e4; batch += 1) {
    const { data, error } = await supabase.rpc("purge_tenant_data_batch", {
      target_job_id: claim.job_id,
      target_worker_id: claimWorkerId(claim),
      target_lease_token: claim.lease_token,
      target_batch_size: 5e3
    });
    if (error)
      throw new ControlledPurgeError("PURGE_DATA_BATCH_FAILED", "DATA", void 0, {
        cause: error
      });
    const result = data;
    if (result?.done === true) return;
  }
  throw new ControlledPurgeError("PURGE_DATA_SLICE_LIMIT_REACHED", "DATA");
}
__name(purgeTenantData, "purgeTenantData");
async function finalizePurge(supabase, claim) {
  const { data, error } = await supabase.rpc("finalize_controlled_tenant_purge", {
    target_job_id: claim.job_id,
    target_worker_id: claimWorkerId(claim),
    target_lease_token: claim.lease_token
  });
  if (error || !data?.completed)
    throw new ControlledPurgeError("PURGE_FINALIZATION_FAILED", "FINALIZE", void 0, {
      cause: error
    });
}
__name(finalizePurge, "finalizePurge");
async function recordRetry(supabase, claim, failure) {
  const delaySeconds = Math.min(86400, 300 * 2 ** Math.min(claim.attempt_number - 1, 8));
  const { data, error } = await supabase.rpc("retry_controlled_purge", {
    target_job_id: claim.job_id,
    target_worker_id: claimWorkerId(claim),
    target_lease_token: claim.lease_token,
    target_safe_error_code: failure.safeCode,
    target_phase: failure.phase,
    target_item_id: failure.itemId ?? null,
    target_delay_seconds: delaySeconds
  });
  if (error || data !== true) throw error ?? new Error("PURGE_RETRY_RECORD_FAILED");
}
__name(recordRetry, "recordRetry");
var retentionPurge = schedules_exports.task({
  id: "retention-purge",
  // This hourly schedule is timezone-independent; UTC avoids relying on a
  // provider-specific alias for India Standard Time.
  cron: { pattern: "17 * * * *", timezone: "UTC" },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1e3,
    maxTimeoutInMs: 3e4,
    randomize: true
  },
  run: /* @__PURE__ */ __name(async () => {
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const configuredBucket = requiredEnvironment("TIGRIS_BUCKET");
    const storage = new import_client_s3.S3Client({
      endpoint: requiredEnvironment("TIGRIS_ENDPOINT"),
      region: process.env.TIGRIS_REGION ?? "auto",
      credentials: {
        accessKeyId: requiredEnvironment("TIGRIS_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnvironment("TIGRIS_SECRET_ACCESS_KEY")
      }
    });
    const workerId = `retention:${crypto.randomUUID()}`;
    let claimed = 0;
    let completed = 0;
    let scheduledForRetry = 0;
    for (let slot = 0; slot < 5; slot += 1) {
      const { data, error } = await supabase.rpc("claim_controlled_purges", {
        target_worker_id: workerId,
        target_batch_size: 1
      });
      if (error) throw error;
      const claim = (data ?? [])[0];
      if (!claim) break;
      claimed += 1;
      workerIds.set(claim.job_id, workerId);
      try {
        await purgeStorage(supabase, storage, configuredBucket, claim);
        await purgeAuthIdentities(supabase, claim);
        await purgeTenantData(supabase, claim);
        await finalizePurge(supabase, claim);
        completed += 1;
      } catch (error2) {
        const failure = safeFailure(error2, "FINALIZE");
        await recordRetry(supabase, claim, failure);
        scheduledForRetry += 1;
      } finally {
        workerIds.delete(claim.job_id);
      }
    }
    return { claimed, completed, scheduled_for_retry: scheduledForRetry };
  }, "run")
});
export {
  retentionPurge
};
//# sourceMappingURL=retention-purge.mjs.map
