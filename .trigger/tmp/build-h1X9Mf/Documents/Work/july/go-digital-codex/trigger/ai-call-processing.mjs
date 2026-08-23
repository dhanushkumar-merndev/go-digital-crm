import {
  init_protocols,
  init_util,
  protocols_exports,
  require_dist_cjs,
  require_dist_cjs2,
  util_exports
} from "../../../../../chunk-2A6DBGFE.mjs";
import {
  endpoints_exports,
  init_endpoints
} from "../../../../../chunk-5DJZLG44.mjs";
import {
  createClient,
  dist_exports
} from "../../../../../chunk-BPAS2SOV.mjs";
import {
  schedules_exports
} from "../../../../../chunk-VFKMLZTG.mjs";
import {
  __commonJS,
  __name,
  __toCommonJS,
  __toESM,
  init_esm
} from "../../../../../chunk-F3RMVOPE.mjs";

// node_modules/.pnpm/@aws-sdk+s3-request-presigner@3.1110.0/node_modules/@aws-sdk/s3-request-presigner/dist-cjs/index.js
var require_dist_cjs3 = __commonJS({
  "node_modules/.pnpm/@aws-sdk+s3-request-presigner@3.1110.0/node_modules/@aws-sdk/s3-request-presigner/dist-cjs/index.js"(exports) {
    init_esm();
    var { formatUrl } = (init_util(), __toCommonJS(util_exports));
    var { getEndpointFromInstructions } = (init_endpoints(), __toCommonJS(endpoints_exports));
    var { HttpRequest } = (init_protocols(), __toCommonJS(protocols_exports));
    var { SignatureV4MultiRegion } = require_dist_cjs();
    var UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
    var SHA256_HEADER = "X-Amz-Content-Sha256";
    var S3RequestPresigner = class {
      static {
        __name(this, "S3RequestPresigner");
      }
      signer;
      constructor(options) {
        const resolvedOptions = {
          service: options.signingName || options.service || "s3",
          uriEscapePath: options.uriEscapePath || false,
          applyChecksum: options.applyChecksum || false,
          ...options
        };
        this.signer = new SignatureV4MultiRegion(resolvedOptions);
      }
      presign(requestToSign, { unsignableHeaders = /* @__PURE__ */ new Set(), hoistableHeaders = /* @__PURE__ */ new Set(), unhoistableHeaders = /* @__PURE__ */ new Set(), ...options } = {}) {
        this.prepareRequest(requestToSign, {
          unsignableHeaders,
          unhoistableHeaders,
          hoistableHeaders
        });
        return this.signer.presign(requestToSign, {
          expiresIn: 900,
          unsignableHeaders,
          unhoistableHeaders,
          ...options
        });
      }
      presignWithCredentials(requestToSign, credentials, { unsignableHeaders = /* @__PURE__ */ new Set(), hoistableHeaders = /* @__PURE__ */ new Set(), unhoistableHeaders = /* @__PURE__ */ new Set(), ...options } = {}) {
        this.prepareRequest(requestToSign, {
          unsignableHeaders,
          unhoistableHeaders,
          hoistableHeaders
        });
        return this.signer.presignWithCredentials(requestToSign, credentials, {
          expiresIn: 900,
          unsignableHeaders,
          unhoistableHeaders,
          ...options
        });
      }
      prepareRequest(requestToSign, { unsignableHeaders = /* @__PURE__ */ new Set(), unhoistableHeaders = /* @__PURE__ */ new Set(), hoistableHeaders = /* @__PURE__ */ new Set() } = {}) {
        unsignableHeaders.add("content-type");
        Object.keys(requestToSign.headers).map((header) => header.toLowerCase()).filter((header) => header.startsWith("x-amz-server-side-encryption")).forEach((header) => {
          if (!hoistableHeaders.has(header)) {
            unhoistableHeaders.add(header);
          }
        });
        requestToSign.headers[SHA256_HEADER] = UNSIGNED_PAYLOAD;
        const currentHostHeader = requestToSign.headers.host;
        const port = requestToSign.port;
        const expectedHostHeader = `${requestToSign.hostname}${requestToSign.port != null ? ":" + port : ""}`;
        if (!currentHostHeader || currentHostHeader === requestToSign.hostname && requestToSign.port != null) {
          requestToSign.headers.host = expectedHostHeader;
        }
      }
    };
    var getSignedUrl2 = /* @__PURE__ */ __name(async (client, command, options = {}) => {
      let s3Presigner;
      let region;
      if (typeof client.config.endpointProvider === "function") {
        const endpointV2 = await getEndpointFromInstructions(command.input, command.constructor, client.config);
        const authScheme = endpointV2.properties?.authSchemes?.[0];
        if (authScheme?.name === "sigv4a") {
          region = authScheme?.signingRegionSet?.join(",");
        } else {
          region = authScheme?.signingRegion;
        }
        s3Presigner = new S3RequestPresigner({
          ...client.config,
          signingName: authScheme?.signingName,
          region: /* @__PURE__ */ __name(async () => region, "region")
        });
      } else {
        s3Presigner = new S3RequestPresigner(client.config);
      }
      const presignInterceptMiddleware = /* @__PURE__ */ __name((next, context) => async (args) => {
        const { request } = args;
        if (!HttpRequest.isInstance(request)) {
          throw new Error("Request to be presigned is not an valid HTTP request.");
        }
        delete request.headers["amz-sdk-invocation-id"];
        delete request.headers["amz-sdk-request"];
        delete request.headers["x-amz-user-agent"];
        let presigned2;
        const presignerOptions = {
          ...options,
          signingRegion: options.signingRegion ?? context["signing_region"] ?? region,
          signingService: options.signingService ?? context["signing_service"]
        };
        if (context.s3ExpressIdentity) {
          presigned2 = await s3Presigner.presignWithCredentials(request, context.s3ExpressIdentity, presignerOptions);
        } else {
          presigned2 = await s3Presigner.presign(request, presignerOptions);
        }
        return {
          response: {},
          output: {
            $metadata: { httpStatusCode: 200 },
            presigned: presigned2
          }
        };
      }, "presignInterceptMiddleware");
      const middlewareName = "presignInterceptMiddleware";
      const clientStack = client.middlewareStack.clone();
      clientStack.addRelativeTo(presignInterceptMiddleware, {
        name: middlewareName,
        relation: "before",
        toMiddleware: "awsAuthMiddleware",
        override: true
      });
      const handler = command.resolveMiddleware(clientStack, client.config, {});
      const { output } = await handler({ input: command.input });
      const { presigned } = output;
      return formatUrl(presigned);
    }, "getSignedUrl");
    exports.S3RequestPresigner = S3RequestPresigner;
    exports.getSignedUrl = getSignedUrl2;
  }
});

// trigger/ai-call-processing.ts
init_esm();
var import_client_s3 = __toESM(require_dist_cjs2());
var import_s3_request_presigner = __toESM(require_dist_cjs3());
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
function configuredCredits(name) {
  const value = Number(process.env[name] ?? "1");
  if (!Number.isSafeInteger(value) || value < 1 || value > 1e4)
    throw new Error(`${name}_INVALID`);
  return value;
}
__name(configuredCredits, "configuredCredits");
function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(Buffer.from(padded, "base64"));
}
__name(fromBase64Url, "fromBase64Url");
async function decryptCredential(value) {
  if (typeof value !== "string") throw new Error("INTEGRATION_CREDENTIAL_INVALID");
  const bytes = value.startsWith("\\x") ? Uint8Array.from(Buffer.from(value.slice(2), "hex")) : fromBase64Url(value);
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (envelope.version !== "AES-256-GCM-v1")
    throw new Error("INTEGRATION_CREDENTIAL_VERSION_UNSUPPORTED");
  const keyBytes = fromBase64Url(requiredEnvironment("INTEGRATION_ENCRYPTION_KEY"));
  if (keyBytes.byteLength !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY_INVALID");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
__name(decryptCredential, "decryptCredential");
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
async function findTenantGroq(supabase, job) {
  const { data: connections, error } = await supabase.from("connected_accounts").select("id,scope_mode,connection_config").eq("organization_id", job.organization_id).eq("provider_key", "groq").eq("status", "CONNECTED").is("deleted_at", null).order("updated_at", { ascending: false });
  if (error) throw error;
  for (const connection of connections ?? []) {
    const config = connection.connection_config;
    if (!config?.capabilities?.includes("AUDIO_TRANSCRIPTION") || !config.capabilities.includes("AI_CALL_ANALYSIS") || !config.models?.transcription_model || !config.models?.analysis_model)
      continue;
    if (connection.scope_mode !== "ALL_BRANCHES") {
      const { data: mapping, error: mappingError } = await supabase.from("integration_branch_mappings").select("branch_id").eq("organization_id", job.organization_id).eq("connected_account_id", connection.id).eq("branch_id", job.branch_id).eq("external_resource_type", "CONNECTION_SCOPE").is("deleted_at", null).maybeSingle();
      if (mappingError) throw mappingError;
      if (!mapping) continue;
    }
    const { data: secret, error: secretError } = await supabase.from("integration_credentials").select("encrypted_payload").eq("organization_id", job.organization_id).eq("connected_account_id", connection.id).maybeSingle();
    if (secretError || !secret) throw secretError ?? new Error("GROQ_CREDENTIAL_NOT_CONFIGURED");
    return {
      apiKey: (await decryptCredential(secret.encrypted_payload)).api_key,
      transcriptionModel: config.models.transcription_model,
      analysisModel: config.models.analysis_model,
      billingMode: "TENANT_CONNECTION",
      credits: 0
    };
  }
  return null;
}
__name(findTenantGroq, "findTenantGroq");
async function platformGroq() {
  return {
    apiKey: requiredEnvironment("GROQ_API_KEY"),
    transcriptionModel: requiredEnvironment("GROQ_TRANSCRIPTION_MODEL"),
    analysisModel: requiredEnvironment("GROQ_ANALYSIS_MODEL"),
    billingMode: "PLATFORM_CREDITS",
    credits: configuredCredits("AI_CALL_TRANSCRIPTION_CREDITS") + configuredCredits("AI_CALL_ANALYSIS_CREDITS")
  };
}
__name(platformGroq, "platformGroq");
async function transcribe(input) {
  const form = new FormData();
  form.set("url", input.audioUrl);
  form.set("model", input.model);
  form.set("response_format", "verbose_json");
  form.set("timestamp_granularities[]", "segment");
  form.set("temperature", "0");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(4 * 6e4)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.text?.trim())
    throw new Error(
      response.status === 429 ? "GROQ_TRANSCRIPTION_RATE_LIMITED" : "GROQ_TRANSCRIPTION_FAILED"
    );
  return payload.text.trim();
}
__name(transcribe, "transcribe");
async function analyze(input) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You review automobile dealership call transcripts. Return JSON only with normalized_transcript, summary, and fields. Preserve uncertain wording rather than inventing details. fields may include customer_name, phone, email, interested_model, lifecycle_status, temperature, next_followup_at only when directly supported by the call. next_followup_at must be ISO 8601 or null."
        },
        { role: "user", content: input.transcript.slice(0, 1e5) }
      ]
    }),
    signal: AbortSignal.timeout(9e4)
  });
  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (!response.ok || !content)
    throw new Error(
      response.status === 429 ? "GROQ_ANALYSIS_RATE_LIMITED" : "GROQ_ANALYSIS_FAILED"
    );
  const parsed = JSON.parse(content);
  const normalizedTranscript = typeof parsed.normalized_transcript === "string" && parsed.normalized_transcript.trim() ? parsed.normalized_transcript.trim() : input.transcript;
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 12e3) : "";
  const fields = parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields) ? parsed.fields : {};
  return { normalizedTranscript, summary, fields };
}
__name(analyze, "analyze");
async function processJob(supabase, storage, job) {
  const tenantProvider = await findTenantGroq(supabase, job);
  const provider = tenantProvider ?? await platformGroq();
  if (provider.billingMode === "PLATFORM_CREDITS") {
    const { error } = await supabase.rpc("consume_platform_ai_credits", {
      target_organization_id: job.organization_id,
      target_amount: provider.credits,
      target_feature: "ai_call_processing",
      target_reference_id: `ai-call:${job.id}:${job.recording_id}:groq`
    });
    if (error)
      throw new Error(
        error.message.includes("INSUFFICIENT_CREDITS") ? "INSUFFICIENT_CREDITS" : "AI_CREDIT_RESERVATION_FAILED"
      );
  }
  const { data: existingTranscript, error: existingError } = await supabase.from("call_transcripts").select("id,raw_transcript_text,transcript_text").eq("organization_id", job.organization_id).eq("processing_job_id", job.id).maybeSingle();
  if (existingError) throw existingError;
  let rawTranscript = existingTranscript?.raw_transcript_text ?? existingTranscript?.transcript_text ?? null;
  if (!rawTranscript) {
    const audioUrl = await (0, import_s3_request_presigner.getSignedUrl)(
      storage,
      new import_client_s3.GetObjectCommand({ Bucket: job.object_bucket, Key: job.object_key }),
      { expiresIn: 600 }
    );
    rawTranscript = await transcribe({
      apiKey: provider.apiKey,
      model: provider.transcriptionModel,
      audioUrl
    });
  }
  const analysis = await analyze({
    apiKey: provider.apiKey,
    model: provider.analysisModel,
    transcript: rawTranscript
  });
  const { error: transcriptError } = await supabase.from("call_transcripts").upsert(
    {
      organization_id: job.organization_id,
      call_id: job.call_id,
      processing_job_id: job.id,
      raw_transcript_text: rawTranscript,
      transcript_text: analysis.normalizedTranscript,
      language: null,
      provider_reference: `groq:${provider.transcriptionModel}`,
      analysis_model_reference: provider.analysisModel,
      status: "COMPLETED",
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    },
    { onConflict: "organization_id,processing_job_id" }
  );
  if (transcriptError) throw transcriptError;
  if (analysis.summary) {
    const { error } = await supabase.from("ai_call_summaries").upsert(
      {
        organization_id: job.organization_id,
        call_id: job.call_id,
        processing_job_id: job.id,
        summary: analysis.summary,
        model_reference: provider.analysisModel
      },
      { onConflict: "organization_id,processing_job_id" }
    );
    if (error) throw error;
  }
  if (Object.keys(analysis.fields).length && job.lead_id) {
    const { error } = await supabase.from("ai_extraction_runs").upsert(
      {
        organization_id: job.organization_id,
        call_id: job.call_id,
        lead_id: job.lead_id,
        processing_job_id: job.id,
        status: "COMPLETED",
        suggestions: analysis.fields
      },
      { onConflict: "organization_id,processing_job_id" }
    );
    if (error) throw error;
  }
  const { data: completed, error: completeError } = await supabase.rpc(
    "complete_ai_call_processing_job",
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_billing_mode: provider.billingMode,
      target_credits_consumed: provider.credits
    }
  );
  if (completeError || !completed)
    throw completeError ?? new Error("AI_CALL_PROCESSING_LEASE_LOST");
}
__name(processJob, "processJob");
var aiCallProcessing = schedules_exports.task({
  id: "ai-call-processing",
  cron: { pattern: "* * * * *", timezone: "UTC" },
  queue: { concurrencyLimit: 2 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1e3, maxTimeoutInMs: 3e4 },
  run: /* @__PURE__ */ __name(async () => {
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await supabase.rpc("claim_ai_call_processing_jobs", {
      target_worker_id: `trigger:ai-call-processing:${crypto.randomUUID()}`,
      target_batch_size: 2
    });
    if (error) throw error;
    const storage = storageClient();
    let completed = 0;
    let retried = 0;
    for (const job of data ?? []) {
      try {
        await processJob(supabase, storage, job);
        completed += 1;
      } catch (error2) {
        const safeCode = error2 instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error2.message) ? error2.message : "AI_CALL_PROCESSING_RETRY";
        const { error: retryError } = await supabase.rpc("retry_ai_call_processing_job", {
          target_job_id: job.id,
          target_lease_token: job.lease_token,
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
  aiCallProcessing
};
//# sourceMappingURL=ai-call-processing.mjs.map
