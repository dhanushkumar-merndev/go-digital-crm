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

// trigger/report-export.ts
init_esm();
var import_client_s3 = __toESM(require_dist_cjs());
import { createHash } from "node:crypto";
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
__name(escapeCsv, "escapeCsv");
function renderCsv(payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const metadata = [
    ["Report", payload.report_key],
    ["Branch ID", payload.branch_id ?? "All authorized branches"],
    ["Generated at", payload.generated_at],
    []
  ];
  const lines = metadata.map((row) => row.map(escapeCsv).join(","));
  if (columns.length === 0) return `${lines.join("\r\n")}\r
No aggregate rows\r
`;
  lines.push(columns.map(escapeCsv).join(","));
  for (const row of rows) lines.push(columns.map((column) => escapeCsv(row[column])).join(","));
  return `${lines.join("\r\n")}\r
`;
}
__name(renderCsv, "renderCsv");
function storageClient() {
  return new import_client_s3.S3Client({
    endpoint: requiredEnvironment("TIGRIS_ENDPOINT"),
    region: process.env.TIGRIS_REGION?.trim() || "auto",
    credentials: {
      accessKeyId: requiredEnvironment("TIGRIS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("TIGRIS_SECRET_ACCESS_KEY")
    }
  });
}
__name(storageClient, "storageClient");
async function processExport(supabase, storage, item) {
  const { data: rawPayload, error: payloadError } = await supabase.rpc(
    "get_report_export_payload",
    {
      target_export_id: item.id
    }
  );
  if (payloadError) throw payloadError;
  const payload = rawPayload;
  const csv = renderCsv(payload);
  const body = Buffer.from(csv, "utf8");
  if (body.byteLength > 5 * 1024 * 1024) throw new Error("REPORT_EXPORT_SIZE_LIMIT");
  const checksum = createHash("sha256").update(body).digest("hex");
  const bucket = requiredEnvironment("TIGRIS_BUCKET");
  const objectKey = `${item.organization_id}/report_export/${item.id}/${item.report_key.toLowerCase()}-aggregate.csv`;
  await storage.send(
    new import_client_s3.PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: "text/csv; charset=utf-8",
      ContentLength: body.byteLength,
      ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64")
    })
  );
  const { data: objectFile, error: objectError } = await supabase.from("object_files").upsert(
    {
      organization_id: item.organization_id,
      branch_id: item.branch_id,
      resource_type: "report_export",
      resource_id: item.id,
      bucket,
      object_key: objectKey,
      original_file_name: `${item.report_key.toLowerCase()}-aggregate-report.csv`,
      mime_type: "text/csv",
      size_bytes: body.byteLength,
      checksum,
      uploaded_by: item.requested_by
    },
    { onConflict: "bucket,object_key" }
  ).select("id").single();
  if (objectError || !objectFile)
    throw objectError ?? new Error("REPORT_OBJECT_FILE_CREATE_FAILED");
  const { data: completed, error: completeError } = await supabase.rpc("complete_report_export", {
    target_export_id: item.id,
    target_lease_token: item.lease_token,
    target_object_file_id: objectFile.id
  });
  if (completeError) throw completeError;
  if (!completed) throw new Error("REPORT_EXPORT_LEASE_LOST");
}
__name(processExport, "processExport");
var reportExport = schedules_exports.task({
  id: "report-export",
  // Five minute batches keep free-tier polling low while a user-visible query polls only pending jobs.
  cron: { pattern: "*/5 * * * *", timezone: "UTC" },
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1e3, maxTimeoutInMs: 3e4 },
  run: /* @__PURE__ */ __name(async () => {
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const database = supabase;
    const workerId = `trigger:report-export:${crypto.randomUUID()}`;
    const { data, error } = await database.rpc("claim_report_exports", {
      target_worker_id: workerId,
      target_batch_size: 5
    });
    if (error) throw error;
    const storage = storageClient();
    let completed = 0;
    let retried = 0;
    for (const item of data ?? []) {
      try {
        await processExport(database, storage, item);
        completed += 1;
      } catch (error2) {
        const safeCode = error2 instanceof Error && error2.message === "REPORT_EXPORT_SIZE_LIMIT" ? "REPORT_EXPORT_SIZE_LIMIT" : "REPORT_EXPORT_RETRY";
        const { error: retryError } = await database.rpc("retry_report_export", {
          target_export_id: item.id,
          target_lease_token: item.lease_token,
          target_safe_error_code: safeCode
        });
        if (retryError) throw retryError;
        retried += 1;
      }
    }
    return { claimed: data?.length ?? 0, completed, retried };
  }, "run")
});
export {
  reportExport
};
//# sourceMappingURL=report-export.mjs.map
