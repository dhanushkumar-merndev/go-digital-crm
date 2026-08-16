import {
  createClient,
  dist_exports
} from "../../../../../chunk-YD4LEPU7.mjs";
import {
  schedules_exports
} from "../../../../../chunk-JF2PC2IM.mjs";
import {
  __name,
  init_esm
} from "../../../../../chunk-265QJBBL.mjs";

// trigger/provider-outbox.ts
init_esm();
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(Buffer.from(padded, "base64"));
}
__name(fromBase64Url, "fromBase64Url");
function parseBytea(value) {
  if (value.startsWith("\\x")) return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  return fromBase64Url(value);
}
__name(parseBytea, "parseBytea");
async function decryptCredential(value) {
  const envelope = JSON.parse(new TextDecoder().decode(parseBytea(value)));
  if (envelope.version !== "AES-256-GCM-v1") throw new Error("UNSUPPORTED_CIPHER_VERSION");
  const rawKey = fromBase64Url(requiredEnvironment("INTEGRATION_ENCRYPTION_KEY"));
  if (rawKey.byteLength !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY_MUST_BE_32_BYTES");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
__name(decryptCredential, "decryptCredential");
async function retryEmail(supabase, event) {
  const { data: message, error } = await supabase.from("email_messages").select(
    "id,application_message_id,template_id,recipient,status,template_variables,requested_by"
  ).eq("id", event.aggregate_id).eq("organization_id", event.organization_id).single();
  if (error) throw error;
  if (["ACCEPTED", "DELIVERED", "FAILED"].includes(message.status)) return;
  if (!["RETRY", "PENDING"].includes(message.status)) throw new Error("EMAIL_NOT_RETRYABLE");
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": requiredEnvironment("BREVO_API_KEY"),
      "idempotency-key": message.application_message_id
    },
    body: JSON.stringify({
      to: [{ email: message.recipient }],
      templateId: Number(message.template_id),
      params: message.template_variables,
      tags: ["go-digital-crm"]
    })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.messageId) throw new Error("BREVO_RETRY_REJECTED");
  const { error: updateError } = await supabase.from("email_messages").update({
    status: "ACCEPTED",
    provider_message_id: result.messageId,
    accepted_at: (/* @__PURE__ */ new Date()).toISOString(),
    error_code: null,
    error_message: null
  }).eq("id", message.id);
  if (updateError) throw updateError;
  await supabase.from("audit_logs").insert({
    organization_id: event.organization_id,
    actor_id: message.requested_by,
    action: "email.retry_accepted",
    resource_type: "email_message",
    resource_id: message.id,
    metadata: { outbox_event_id: event.id }
  });
}
__name(retryEmail, "retryEmail");
async function enqueueMessageReconciliation(supabase, event, connectionId, applicationMessageId) {
  const { error } = await supabase.from("domain_outbox").insert({
    organization_id: event.organization_id,
    event_type: "message.status.reconcile",
    aggregate_type: "conversation_message",
    aggregate_id: event.aggregate_id,
    payload: { connection_id: connectionId, application_message_id: applicationMessageId },
    next_attempt_at: new Date(Date.now() + 2 * 6e4).toISOString()
  });
  if (error?.code !== "23505" && error) throw error;
}
__name(enqueueMessageReconciliation, "enqueueMessageReconciliation");
async function retryWhatsAppMessage(supabase, event) {
  const { data: message, error: messageError } = await supabase.from("conversation_messages").select(
    "id,conversation_id,application_message_id,body,status:delivery_status,metadata,attempt_count"
  ).eq("id", event.aggregate_id).eq("organization_id", event.organization_id).single();
  if (messageError) throw messageError;
  const { data: conversation, error: conversationError } = await supabase.from("conversations").select("id,connection_id,external_contact").eq("id", message.conversation_id).eq("organization_id", event.organization_id).single();
  if (conversationError) throw conversationError;
  if (["SENT", "DELIVERED", "READ", "FAILED"].includes(message.status)) return;
  if (message.status === "PENDING" || message.status === "PENDING_RECONCILIATION") {
    await enqueueMessageReconciliation(
      supabase,
      event,
      conversation.connection_id,
      message.application_message_id
    );
    return;
  }
  if (message.status !== "RETRY") throw new Error("WHATSAPP_MESSAGE_NOT_RETRYABLE");
  const { data: secret, error: secretError } = await supabase.from("integration_credentials").select("encrypted_payload").eq("connected_account_id", conversation.connection_id).eq("organization_id", event.organization_id).single();
  if (secretError) throw secretError;
  const credential = await decryptCredential(secret.encrypted_payload);
  const recipient = String(conversation.external_contact ?? "").replace(/\D/g, "");
  if (recipient.length < 7 || recipient.length > 20) throw new Error("WHATSAPP_RECIPIENT_INVALID");
  const metadata = message.metadata ?? {};
  const providerBody = metadata.message_type === "template" ? {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: {
      name: metadata.template_name,
      language: { code: metadata.language_code },
      components: metadata.components ?? []
    },
    biz_opaque_callback_data: message.application_message_id
  } : {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: { preview_url: false, body: message.body },
    biz_opaque_callback_data: message.application_message_id
  };
  const { error: pendingError } = await supabase.from("conversation_messages").update({
    delivery_status: "PENDING",
    attempt_count: (message.attempt_count ?? 0) + 1,
    last_attempt_at: (/* @__PURE__ */ new Date()).toISOString(),
    safe_error_code: null
  }).eq("id", message.id).eq("delivery_status", "RETRY");
  if (pendingError) throw pendingError;
  let response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${requiredEnvironment("META_GRAPH_API_VERSION")}/${encodeURIComponent(credential.phone_number_id)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.access_token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(providerBody)
      }
    );
  } catch (error) {
    await supabase.from("conversation_messages").update({ delivery_status: "PENDING_RECONCILIATION", safe_error_code: "SEND_RESULT_UNKNOWN" }).eq("id", message.id);
    await enqueueMessageReconciliation(
      supabase,
      event,
      conversation.connection_id,
      message.application_message_id
    );
    throw error;
  }
  const result = await response.json().catch(() => null);
  const providerMessageId = result?.messages?.[0]?.id;
  if (!response.ok || !providerMessageId) {
    const { error: retryError } = await supabase.from("conversation_messages").update({ delivery_status: "RETRY", safe_error_code: "WHATSAPP_PROVIDER_REJECTED" }).eq("id", message.id);
    if (retryError) throw retryError;
    throw new Error("WHATSAPP_RETRY_REJECTED");
  }
  const { error: sentError } = await supabase.from("conversation_messages").update({
    delivery_status: "SENT",
    provider_message_id: providerMessageId,
    safe_error_code: null
  }).eq("id", message.id);
  if (sentError) throw sentError;
}
__name(retryWhatsAppMessage, "retryWhatsAppMessage");
async function reconcileWhatsAppMessage(supabase, event) {
  const { data: message, error } = await supabase.from("conversation_messages").select("delivery_status,provider_message_id").eq("id", event.aggregate_id).eq("organization_id", event.organization_id).single();
  if (error) throw error;
  if (message.provider_message_id || ["SENT", "DELIVERED", "READ", "FAILED"].includes(message.delivery_status))
    return;
  throw new Error("WHATSAPP_STATUS_NOT_RECONCILED");
}
__name(reconcileWhatsAppMessage, "reconcileWhatsAppMessage");
async function dispatch(supabase, event) {
  if (event.event_type === "email.send.retry") return retryEmail(supabase, event);
  if (event.event_type === "message.send.retry") return retryWhatsAppMessage(supabase, event);
  if (event.event_type === "message.status.reconcile")
    return reconcileWhatsAppMessage(supabase, event);
  throw new Error("UNSUPPORTED_OUTBOX_EVENT");
}
__name(dispatch, "dispatch");
var providerOutbox = schedules_exports.task({
  id: "provider-outbox-dispatch",
  cron: { pattern: "* * * * *", timezone: "UTC" },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1e3, maxTimeoutInMs: 3e4 },
  run: /* @__PURE__ */ __name(async () => {
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const workerId = `trigger:${crypto.randomUUID()}`;
    const { data, error } = await supabase.rpc("claim_domain_outbox", {
      target_worker_id: workerId,
      target_batch_size: 50
    });
    if (error) throw error;
    let completed = 0;
    let retried = 0;
    for (const event of data ?? []) {
      try {
        await dispatch(supabase, event);
        const { error: completeError } = await supabase.rpc("complete_domain_outbox", {
          target_event_id: event.id,
          target_worker_id: workerId
        });
        if (completeError) throw completeError;
        completed += 1;
      } catch (dispatchError) {
        const safeCode = dispatchError instanceof Error && dispatchError.message === "UNSUPPORTED_OUTBOX_EVENT" ? "UNSUPPORTED_OUTBOX_EVENT" : "PROVIDER_OUTBOX_RETRY";
        const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(event.attempts, 7));
        const { error: retryError } = await supabase.rpc("retry_domain_outbox", {
          target_event_id: event.id,
          target_worker_id: workerId,
          target_safe_error_code: safeCode,
          target_delay_seconds: delaySeconds
        });
        if (retryError) throw retryError;
        retried += 1;
      }
    }
    return { claimed: data?.length ?? 0, completed, retried };
  }, "run")
});
export {
  providerOutbox
};
//# sourceMappingURL=provider-outbox.mjs.map
