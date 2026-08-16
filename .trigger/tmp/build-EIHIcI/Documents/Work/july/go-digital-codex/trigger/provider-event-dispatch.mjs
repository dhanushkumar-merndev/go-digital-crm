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

// trigger/provider-event-dispatch.ts
init_esm();

// src/lib/providers/google-lead-form-adapter.ts
init_esm();
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
__name(record, "record");
function text(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return void 0;
}
__name(text, "text");
function normalizeProviderPhone(phone) {
  const normalized = phone.replace(/[^\d+]/g, "");
  return normalized.startsWith("+") ? normalized : `+91${normalized.replace(/^0+/, "")}`;
}
__name(normalizeProviderPhone, "normalizeProviderPhone");
function parseGoogleLeadEnvelope(payload) {
  const root = record(payload);
  const leadId = text(root?.lead_id);
  const googleKey = text(root?.google_key);
  if (!root || !leadId || !googleKey || !Array.isArray(root.user_column_data))
    throw new Error("GOOGLE_LEAD_ENVELOPE_INVALID");
  return {
    leadId,
    googleKey,
    formId: text(root.form_id),
    campaignId: text(root.campaign_id),
    isTest: root.is_test === true,
    raw: root
  };
}
__name(parseGoogleLeadEnvelope, "parseGoogleLeadEnvelope");
function normalizeGoogleLead(envelope) {
  const fields = /* @__PURE__ */ new Map();
  for (const rawColumn of envelope.raw.user_column_data) {
    const value = text(rawColumn.string_value);
    const columnId = text(rawColumn.column_id)?.toLocaleUpperCase();
    const columnName = text(rawColumn.column_name)?.toLocaleLowerCase();
    if (!value) continue;
    if (columnId) fields.set(columnId, value);
    if (columnName) fields.set(columnName, value);
  }
  const customerName = fields.get("FULL_NAME") ?? fields.get("full name") ?? [fields.get("FIRST_NAME"), fields.get("LAST_NAME")].filter(Boolean).join(" ").trim();
  const phone = fields.get("PHONE_NUMBER") ?? fields.get("phone number") ?? fields.get("user phone");
  if (!customerName || !phone) throw new Error("GOOGLE_LEAD_MINIMUM_FIELDS_MISSING");
  return {
    source: "Google Ads",
    customerName,
    phone: normalizeProviderPhone(phone),
    email: fields.get("EMAIL") ?? fields.get("user email"),
    location: fields.get("CITY") ?? fields.get("city") ?? fields.get("POSTAL_CODE") ?? fields.get("postal code"),
    campaign: envelope.campaignId,
    interestedModel: fields.get("INTERESTED_MODEL") ?? fields.get("preferred model") ?? fields.get("what is your preferred model?"),
    sourceDetail: envelope.formId ? `Google Lead Form ${envelope.formId}` : "Google Lead Form",
    externalLeadId: envelope.leadId
  };
}
__name(normalizeGoogleLead, "normalizeGoogleLead");

// src/lib/providers/meta-lead-adapter.ts
init_esm();
function record2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
__name(record2, "record");
function text2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
__name(text2, "text");
function normalizeProviderPhone2(phone) {
  const normalized = phone.replace(/[^\d+]/g, "");
  return normalized.startsWith("+") ? normalized : `+91${normalized.replace(/^0+/, "")}`;
}
__name(normalizeProviderPhone2, "normalizeProviderPhone");
function normalizeMetaLead(payload, input) {
  const lead = record2(payload);
  if (!lead || !Array.isArray(lead.field_data)) throw new Error("META_LEAD_FIELDS_MISSING");
  const fields = /* @__PURE__ */ new Map();
  for (const rawField of lead.field_data) {
    const name = text2(rawField.name)?.toLocaleLowerCase();
    const value = Array.isArray(rawField.values) ? text2(rawField.values[0]) : void 0;
    if (name && value) fields.set(name, value);
  }
  const firstName = fields.get("first_name");
  const lastName = fields.get("last_name");
  const customerName = fields.get("full_name") ?? fields.get("name") ?? [firstName, lastName].filter(Boolean).join(" ").trim();
  const phone = fields.get("phone_number") ?? fields.get("phone") ?? fields.get("mobile_number") ?? fields.get("mobile");
  if (!customerName || !phone) throw new Error("META_LEAD_MINIMUM_FIELDS_MISSING");
  const city = fields.get("city");
  const state = fields.get("state");
  const campaign = text2(lead.campaign_name) ?? fields.get("campaign");
  const platform = text2(lead.platform)?.toLocaleLowerCase();
  return {
    source: platform === "instagram" ? "Instagram" : "Facebook",
    customerName,
    phone: normalizeProviderPhone2(phone),
    email: fields.get("email"),
    location: fields.get("location") ?? ([city, state].filter(Boolean).join(", ") || void 0),
    campaign,
    interestedModel: fields.get("interested_model") ?? fields.get("car_model") ?? fields.get("model"),
    sourceDetail: input.sourceDetail ?? "Meta Lead Ads",
    externalLeadId: input.externalLeadId
  };
}
__name(normalizeMetaLead, "normalizeMetaLead");

// src/lib/providers/provider-event-receipts.ts
init_esm();

// src/lib/providers/whatsapp-cloud-adapter.ts
init_esm();
function record3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
__name(record3, "record");
function text3(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return void 0;
}
__name(text3, "text");
function timestamp(value) {
  const seconds = Number(text3(value));
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1e3).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
}
__name(timestamp, "timestamp");
function inboundBody(message) {
  const type = text3(message.type);
  if (type === "text") return text3(record3(message.text)?.body);
  if (type === "button") return text3(record3(message.button)?.text);
  if (type === "interactive") {
    const interactive = record3(message.interactive);
    return text3(record3(interactive?.button_reply)?.title) ?? text3(record3(interactive?.list_reply)?.title);
  }
  return void 0;
}
__name(inboundBody, "inboundBody");
function extractWhatsAppEvents(payload) {
  const root = record3(payload);
  const messages = [];
  const statuses = [];
  if (!root || root.object !== "whatsapp_business_account" || !Array.isArray(root.entry))
    return { messages, statuses };
  for (const rawEntry of root.entry) {
    const entry = record3(rawEntry);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const rawChange of entry.changes) {
      const change = record3(rawChange);
      const value = record3(change?.value);
      const metadata = record3(value?.metadata);
      const phoneNumberId = text3(metadata?.phone_number_id);
      if (change?.field !== "messages" || !value || !phoneNumberId) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const names = /* @__PURE__ */ new Map();
      for (const rawContact of contacts) {
        const contact = record3(rawContact);
        const waId = text3(contact?.wa_id);
        const name = text3(record3(contact?.profile)?.name);
        if (waId && name) names.set(waId, name);
      }
      if (Array.isArray(value.messages)) {
        for (const rawMessage of value.messages) {
          const message = record3(rawMessage);
          const id = text3(message?.id);
          const sender = text3(message?.from);
          if (!message || !id || !sender) continue;
          messages.push({
            eventId: `whatsapp-message:${id}`,
            phoneNumberId,
            sender,
            senderName: names.get(sender),
            sentAt: timestamp(message.timestamp),
            messageType: text3(message.type) ?? "unknown",
            body: inboundBody(message),
            providerPayload: message
          });
        }
      }
      if (Array.isArray(value.statuses)) {
        for (const rawStatus of value.statuses) {
          const status = record3(rawStatus);
          const id = text3(status?.id);
          const recipient = text3(status?.recipient_id);
          const state = text3(status?.status);
          if (!status || !id || !recipient || !state) continue;
          statuses.push({
            eventId: `whatsapp-status:${id}:${state}`,
            phoneNumberId,
            providerMessageId: id,
            applicationMessageId: text3(status.biz_opaque_callback_data),
            recipient,
            status: state.toLocaleUpperCase(),
            occurredAt: timestamp(status.timestamp),
            providerPayload: status
          });
        }
      }
    }
  }
  return { messages, statuses };
}
__name(extractWhatsAppEvents, "extractWhatsAppEvents");

// src/lib/providers/provider-event-receipts.ts
var encoder = new TextEncoder();
var InvalidProviderReceiptError = class extends Error {
  constructor(safeCode) {
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "InvalidProviderReceiptError";
  }
  static {
    __name(this, "InvalidProviderReceiptError");
  }
};
function invalid(safeCode) {
  throw new InvalidProviderReceiptError(safeCode);
}
__name(invalid, "invalid");
function record4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
__name(record4, "record");
function boundedText(value, maximumLength) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : void 0;
}
__name(boundedText, "boundedText");
function assertPayloadSize(payload, maximumBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    invalid("PROVIDER_EVENT_PAYLOAD_INVALID");
  }
  if (encoder.encode(serialized).byteLength > maximumBytes)
    invalid("PROVIDER_EVENT_PAYLOAD_TOO_LARGE");
}
__name(assertPayloadSize, "assertPayloadSize");
function assertProviderEventId(actual, expected) {
  if (actual !== expected) invalid("PROVIDER_EVENT_ID_MISMATCH");
}
__name(assertProviderEventId, "assertProviderEventId");
function readMetaLeadReceipt(payload, expectedProviderEventId) {
  assertPayloadSize(payload, 64e3);
  const event = record4(record4(payload)?.event);
  const leadId = boundedText(event?.leadId, 255);
  const pageId = boundedText(event?.pageId, 255);
  const eventId = boundedText(event?.eventId, 300);
  const formId = event?.formId === void 0 ? void 0 : boundedText(event.formId, 255);
  const occurredAt = event?.occurredAt === void 0 ? void 0 : boundedText(event.occurredAt, 64);
  if (!leadId || !pageId || !eventId || event?.formId !== void 0 && !formId)
    invalid("META_LEAD_RECEIPT_INVALID");
  if (occurredAt && !Number.isFinite(Date.parse(occurredAt))) invalid("META_LEAD_RECEIPT_INVALID");
  assertProviderEventId(eventId, expectedProviderEventId);
  assertProviderEventId(eventId, `leadgen:${leadId}`);
  return { eventId, leadId, pageId, formId, occurredAt };
}
__name(readMetaLeadReceipt, "readMetaLeadReceipt");
function readGoogleLeadReceipt(payload, expectedProviderEventId) {
  assertPayloadSize(payload, 256e3);
  const receipt = record4(payload);
  if (!receipt || !Array.isArray(receipt.user_column_data) || receipt.user_column_data.length > 100)
    invalid("GOOGLE_LEAD_RECEIPT_INVALID");
  const safePayload = { ...receipt };
  delete safePayload.google_key;
  let envelope;
  try {
    envelope = parseGoogleLeadEnvelope({
      ...safePayload,
      google_key: "verified-at-webhook-ingress"
    });
  } catch {
    invalid("GOOGLE_LEAD_RECEIPT_INVALID");
  }
  if (envelope.isTest) invalid("GOOGLE_TEST_EVENT_NOT_DISPATCHABLE");
  if (envelope.leadId.length > 255 || (envelope.formId?.length ?? 0) > 255 || (envelope.campaignId?.length ?? 0) > 255)
    invalid("GOOGLE_LEAD_RECEIPT_INVALID");
  assertProviderEventId(`google-lead:${envelope.leadId}`, expectedProviderEventId);
  return { envelope, safePayload };
}
__name(readGoogleLeadReceipt, "readGoogleLeadReceipt");
function whatsAppEnvelope(payload, phoneNumberId, kind) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phoneNumberId },
              ...kind === "message" ? { messages: [payload] } : { statuses: [payload] }
            }
          }
        ]
      }
    ]
  };
}
__name(whatsAppEnvelope, "whatsAppEnvelope");
function whatsappStoredPayload(payload, expectedPhoneNumberId) {
  const root = record4(payload);
  if (!root) invalid("WHATSAPP_RECEIPT_INVALID");
  if (!("provider_payload" in root)) return { providerPayload: root, senderName: void 0 };
  const phoneNumberId = boundedText(root.phone_number_id, 255);
  const providerPayload = record4(root.provider_payload);
  if (!phoneNumberId || phoneNumberId !== expectedPhoneNumberId || !providerPayload)
    invalid("WHATSAPP_RECEIPT_ROUTE_MISMATCH");
  const senderName = root.sender_name === void 0 ? void 0 : boundedText(root.sender_name, 200);
  if (root.sender_name !== void 0 && !senderName) invalid("WHATSAPP_INBOUND_RECEIPT_INVALID");
  return { providerPayload, senderName };
}
__name(whatsappStoredPayload, "whatsappStoredPayload");
function validProviderTimestamp(value) {
  const normalized = boundedText(value, 20);
  const seconds = Number(normalized);
  return Boolean(normalized && Number.isFinite(seconds) && seconds > 0);
}
__name(validProviderTimestamp, "validProviderTimestamp");
function readWhatsAppInboundReceipt(payload, phoneNumberId, expectedProviderEventId) {
  assertPayloadSize(payload, 262144);
  const stored = whatsappStoredPayload(payload, phoneNumberId);
  const receipt = stored.providerPayload;
  const sender = boundedText(receipt.from, 32);
  if (!boundedText(receipt.id, 512) || !sender || !/^[0-9]{7,20}$/.test(sender) || !boundedText(receipt.type, 64) || !validProviderTimestamp(receipt.timestamp))
    invalid("WHATSAPP_INBOUND_RECEIPT_INVALID");
  const events = extractWhatsAppEvents(whatsAppEnvelope(receipt, phoneNumberId, "message"));
  if (events.messages.length !== 1 || events.statuses.length !== 0)
    invalid("WHATSAPP_INBOUND_RECEIPT_INVALID");
  const message = events.messages[0];
  if ((message.body?.length ?? 0) > 65535) invalid("WHATSAPP_INBOUND_RECEIPT_INVALID");
  assertProviderEventId(message.eventId, expectedProviderEventId);
  return stored.senderName ? { ...message, senderName: stored.senderName } : message;
}
__name(readWhatsAppInboundReceipt, "readWhatsAppInboundReceipt");
var whatsappDeliveryStates = /* @__PURE__ */ new Set(["SENT", "DELIVERED", "READ", "FAILED"]);
function readWhatsAppStatusReceipt(payload, phoneNumberId, expectedProviderEventId) {
  assertPayloadSize(payload, 256e3);
  const receipt = whatsappStoredPayload(payload, phoneNumberId).providerPayload;
  const recipient = boundedText(receipt.recipient_id, 32);
  if (!boundedText(receipt.id, 512) || !recipient || !/^[0-9]{7,20}$/.test(recipient) || !boundedText(receipt.status, 32) || !validProviderTimestamp(receipt.timestamp))
    invalid("WHATSAPP_STATUS_RECEIPT_INVALID");
  const events = extractWhatsAppEvents(whatsAppEnvelope(receipt, phoneNumberId, "status"));
  if (events.statuses.length !== 1 || events.messages.length !== 0)
    invalid("WHATSAPP_STATUS_RECEIPT_INVALID");
  const status = events.statuses[0];
  if (!whatsappDeliveryStates.has(status.status)) invalid("WHATSAPP_STATUS_UNSUPPORTED");
  assertProviderEventId(status.eventId, expectedProviderEventId);
  return status;
}
__name(readWhatsAppStatusReceipt, "readWhatsAppStatusReceipt");
function providerEventRetryDelaySeconds(attemptCount, eventId) {
  const normalizedAttempt = Number.isSafeInteger(attemptCount) ? Math.max(1, Math.min(attemptCount, 8)) : 1;
  const base = Math.min(3600, 30 * 2 ** (normalizedAttempt - 1));
  let hash = 0;
  for (const character of eventId) hash = hash * 31 + character.charCodeAt(0) >>> 0;
  const jitter = hash % (Math.floor(base / 4) + 1);
  return Math.min(3600, base + jitter);
}
__name(providerEventRetryDelaySeconds, "providerEventRetryDelaySeconds");

// trigger/provider-event-dispatch.ts
var ProviderDispatchError = class extends Error {
  constructor(safeCode, permanent, delaySeconds) {
    super(safeCode);
    this.safeCode = safeCode;
    this.permanent = permanent;
    this.delaySeconds = delaySeconds;
    this.name = "ProviderDispatchError";
  }
  static {
    __name(this, "ProviderDispatchError");
  }
};
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new ProviderDispatchError(`${name}_MISSING`, false);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
function configuredBatchSize() {
  const value = Number(process.env.PROVIDER_EVENT_BATCH_SIZE ?? 25);
  if (!Number.isSafeInteger(value) || value < 1 || value > 50)
    throw new ProviderDispatchError("PROVIDER_EVENT_BATCH_SIZE_INVALID", true);
  return value;
}
__name(configuredBatchSize, "configuredBatchSize");
function configuredConcurrency() {
  const value = Number(process.env.PROVIDER_EVENT_CONCURRENCY ?? 5);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10)
    throw new ProviderDispatchError("PROVIDER_EVENT_CONCURRENCY_INVALID", true);
  return value;
}
__name(configuredConcurrency, "configuredConcurrency");
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
  if (typeof value !== "string")
    throw new ProviderDispatchError("INTEGRATION_CREDENTIAL_INVALID", true);
  try {
    const envelope = JSON.parse(new TextDecoder().decode(parseBytea(value)));
    if (envelope.version !== "AES-256-GCM-v1")
      throw new ProviderDispatchError("INTEGRATION_CREDENTIAL_VERSION_UNSUPPORTED", true);
    const rawKey = fromBase64Url(requiredEnvironment("INTEGRATION_ENCRYPTION_KEY"));
    if (rawKey.byteLength !== 32)
      throw new ProviderDispatchError("INTEGRATION_ENCRYPTION_KEY_INVALID", false);
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
      key,
      fromBase64Url(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error instanceof ProviderDispatchError) throw error;
    throw new ProviderDispatchError("INTEGRATION_CREDENTIAL_DECRYPT_FAILED", false);
  }
}
__name(decryptCredential, "decryptCredential");
function errorMessage(error) {
  return error !== null && typeof error === "object" && "message" in error ? String(error.message) : "";
}
__name(errorMessage, "errorMessage");
function permanentDatabaseError(error) {
  const message = errorMessage(error);
  return [
    "INVALID_PROVIDER_SOURCE",
    "INVALID_PROVIDER_LEAD_IDENTITY",
    "EXTERNAL_LEAD_ID_REQUIRED",
    "EXTERNAL_LEAD_ID_TOO_LONG",
    "INVALID_WHATSAPP_INBOUND_MESSAGE",
    "INVALID_WHATSAPP_MESSAGE_STATUS",
    "WHATSAPP_PROVIDER_MESSAGE_AMBIGUOUS",
    "WHATSAPP_PROVIDER_MESSAGE_CONFLICT"
  ].some((code) => message.includes(code));
}
__name(permanentDatabaseError, "permanentDatabaseError");
function retryAfterSeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return void 0;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) ? Math.ceil(numeric) : Math.ceil((Date.parse(value) - Date.now()) / 1e3);
  return Number.isFinite(seconds) ? Math.max(5, Math.min(86400, seconds)) : void 0;
}
__name(retryAfterSeconds, "retryAfterSeconds");
function providerHttpFailure(provider, response) {
  if ([408, 409, 425, 429].includes(response.status) || response.status >= 500)
    return new ProviderDispatchError(
      `${provider}_PROVIDER_TEMPORARILY_UNAVAILABLE`,
      false,
      retryAfterSeconds(response)
    );
  if ([401, 403].includes(response.status))
    return new ProviderDispatchError(`${provider}_RECONNECT_REQUIRED`, true);
  if (response.status === 404)
    return new ProviderDispatchError(`${provider}_RESOURCE_NOT_FOUND`, true);
  return new ProviderDispatchError(`${provider}_PROVIDER_REQUEST_REJECTED`, true);
}
__name(providerHttpFailure, "providerHttpFailure");
async function readBoundedJson(response, maximumBytes) {
  const declaredBytes = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes)
    throw new ProviderDispatchError("PROVIDER_RESPONSE_TOO_LARGE", true);
  if (!response.body) throw new ProviderDispatchError("PROVIDER_RESPONSE_EMPTY", false);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ProviderDispatchError("PROVIDER_RESPONSE_TOO_LARGE", true);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ProviderDispatchError("PROVIDER_RESPONSE_INVALID", false);
  }
}
__name(readBoundedJson, "readBoundedJson");
async function activeConnection(supabase, event) {
  const { data, error } = await supabase.from("connected_accounts").select("id,organization_id,provider_key,status,scope_mode,default_team_id").eq("id", event.connected_account_id).eq("organization_id", event.organization_id).eq("status", "CONNECTED").is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!data) throw new ProviderDispatchError("CONNECTED_ACCOUNT_NOT_ACTIVE", true);
  return data;
}
__name(activeConnection, "activeConnection");
async function credentialFor(supabase, connection) {
  const { data, error } = await supabase.from("integration_credentials").select("encrypted_payload").eq("organization_id", connection.organization_id).eq("connected_account_id", connection.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ProviderDispatchError("INTEGRATION_CREDENTIAL_MISSING", false);
  return decryptCredential(data.encrypted_payload);
}
__name(credentialFor, "credentialFor");
async function exactMapping(supabase, event, resourceType, resourceId) {
  const { data, error } = await supabase.from("integration_branch_mappings").select("branch_id,team_id").eq("organization_id", event.organization_id).eq("connected_account_id", event.connected_account_id).eq("external_resource_type", resourceType).eq("external_resource_id", resourceId).is("deleted_at", null).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}
__name(exactMapping, "exactMapping");
async function connectionScopeMapping(supabase, event) {
  const { data, error } = await supabase.from("integration_branch_mappings").select("branch_id,team_id").eq("organization_id", event.organization_id).eq("connected_account_id", event.connected_account_id).eq("external_resource_type", "CONNECTION_SCOPE").is("deleted_at", null).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}
__name(connectionScopeMapping, "connectionScopeMapping");
async function ingestLead(supabase, event, mapping, connection, lead, rawPayload) {
  const { data, error } = await supabase.rpc("ingest_provider_lead", {
    target_organization_id: event.organization_id,
    target_connection_id: event.connected_account_id,
    target_branch_id: mapping.branch_id,
    target_team_id: mapping.team_id ?? connection.default_team_id,
    target_external_lead_id: lead.externalLeadId,
    target_source: lead.source,
    target_source_detail: lead.sourceDetail ?? null,
    target_campaign: lead.campaign ?? null,
    target_customer_name: lead.customerName,
    target_phone: lead.phone,
    target_normalized_phone: lead.phone,
    target_email: lead.email ?? null,
    target_interested_model: lead.interestedModel ?? null,
    target_raw_payload: rawPayload,
    target_request_id: event.id
  });
  if (error) {
    if (permanentDatabaseError(error))
      throw new ProviderDispatchError("PROVIDER_LEAD_REJECTED", true);
    throw error;
  }
  return data;
}
__name(ingestLead, "ingestLead");
async function dispatchMetaLead(supabase, event) {
  const receipt = readMetaLeadReceipt(event.payload, event.provider_event_id);
  const connection = await activeConnection(supabase, event);
  if (connection.provider_key !== "meta")
    throw new ProviderDispatchError("PROVIDER_EVENT_CONNECTION_MISMATCH", true);
  const mapping = await exactMapping(supabase, event, "META_PAGE", receipt.pageId);
  if (!mapping) return { status: "UNMAPPED", safeErrorCode: "META_PAGE_NOT_MAPPED" };
  const credential = await credentialFor(supabase, connection);
  const pageAccessToken = credential.asset_access_tokens?.[receipt.pageId];
  if (!pageAccessToken) throw new ProviderDispatchError("META_PAGE_RECONNECT_REQUIRED", true);
  const graphVersion = requiredEnvironment("META_GRAPH_API_VERSION");
  if (!/^v\d+\.\d+$/.test(graphVersion))
    throw new ProviderDispatchError("META_GRAPH_API_VERSION_INVALID", false);
  const leadUrl = new URL(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(receipt.leadId)}`
  );
  leadUrl.search = new URLSearchParams({
    fields: "id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,platform"
  }).toString();
  let response;
  try {
    response = await fetch(leadUrl, {
      headers: { authorization: `Bearer ${pageAccessToken}` },
      signal: AbortSignal.timeout(15e3)
    });
  } catch {
    throw new ProviderDispatchError("META_LEAD_FETCH_RETRY", false);
  }
  if (!response.ok) throw providerHttpFailure("META", response);
  const providerPayload = await readBoundedJson(response, 512e3);
  let normalized;
  try {
    normalized = normalizeMetaLead(providerPayload, {
      externalLeadId: receipt.leadId,
      sourceDetail: "Meta Lead Ads"
    });
  } catch {
    throw new ProviderDispatchError("META_LEAD_MINIMUM_FIELDS_MISSING", true);
  }
  const result = await ingestLead(
    supabase,
    event,
    mapping,
    connection,
    { ...normalized, externalLeadId: receipt.leadId },
    providerPayload
  );
  return {
    status: "PROCESSED",
    payloadPatch: {
      lead_id: result?.lead_id ?? null,
      duplicate: result?.duplicate ?? false
    }
  };
}
__name(dispatchMetaLead, "dispatchMetaLead");
async function googleMapping(supabase, event, connection, formId, campaignId) {
  const externalIds = [formId, campaignId].filter((value) => Boolean(value));
  if (externalIds.length > 0) {
    const { data, error } = await supabase.from("integration_branch_mappings").select("branch_id,team_id,external_resource_type,external_resource_id").eq("organization_id", event.organization_id).eq("connected_account_id", event.connected_account_id).is("deleted_at", null).in("external_resource_type", ["GOOGLE_ADS_LEAD_FORM", "GOOGLE_ADS_CAMPAIGN"]).in("external_resource_id", externalIds);
    if (error) throw error;
    const mappings = data ?? [];
    const selected = mappings.find(
      (candidate) => candidate.external_resource_type === "GOOGLE_ADS_LEAD_FORM" && candidate.external_resource_id === formId
    ) ?? mappings.find(
      (candidate) => candidate.external_resource_type === "GOOGLE_ADS_CAMPAIGN" && candidate.external_resource_id === campaignId
    );
    if (selected) return { branch_id: selected.branch_id, team_id: selected.team_id };
  }
  if (connection.scope_mode === "ONE_BRANCH") return connectionScopeMapping(supabase, event);
  return null;
}
__name(googleMapping, "googleMapping");
async function dispatchGoogleLead(supabase, event) {
  const { envelope, safePayload } = readGoogleLeadReceipt(event.payload, event.provider_event_id);
  const connection = await activeConnection(supabase, event);
  if (connection.provider_key !== "google_ads")
    throw new ProviderDispatchError("PROVIDER_EVENT_CONNECTION_MISMATCH", true);
  const mapping = await googleMapping(
    supabase,
    event,
    connection,
    envelope.formId,
    envelope.campaignId
  );
  if (!mapping)
    return {
      status: "UNMAPPED",
      safeErrorCode: "GOOGLE_FORM_OR_CAMPAIGN_NOT_MAPPED"
    };
  let normalized;
  try {
    normalized = normalizeGoogleLead(envelope);
  } catch {
    throw new ProviderDispatchError("GOOGLE_LEAD_MINIMUM_FIELDS_MISSING", true);
  }
  const result = await ingestLead(
    supabase,
    event,
    mapping,
    connection,
    { ...normalized, externalLeadId: envelope.leadId },
    safePayload
  );
  return {
    status: "PROCESSED",
    payloadPatch: {
      lead_id: result?.lead_id ?? null,
      duplicate: result?.duplicate ?? false
    }
  };
}
__name(dispatchGoogleLead, "dispatchGoogleLead");
function validApplicationMessageId(value) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
__name(validApplicationMessageId, "validApplicationMessageId");
async function whatsappContext(supabase, event) {
  const connection = await activeConnection(supabase, event);
  if (connection.provider_key !== "whatsapp_cloud")
    throw new ProviderDispatchError("PROVIDER_EVENT_CONNECTION_MISMATCH", true);
  const credential = await credentialFor(supabase, connection);
  if (!credential.phone_number_id || credential.phone_number_id.length > 255)
    throw new ProviderDispatchError("WHATSAPP_RECONNECT_REQUIRED", true);
  return { connection, credential };
}
__name(whatsappContext, "whatsappContext");
async function dispatchWhatsAppInbound(supabase, event) {
  const { credential } = await whatsappContext(supabase, event);
  const message = readWhatsAppInboundReceipt(
    event.payload,
    credential.phone_number_id,
    event.provider_event_id
  );
  const mapping = await exactMapping(
    supabase,
    event,
    "WHATSAPP_PHONE_NUMBER",
    credential.phone_number_id
  );
  if (!mapping) return { status: "UNMAPPED", safeErrorCode: "WHATSAPP_NUMBER_NOT_MAPPED" };
  const providerMessageId = message.eventId.replace(/^whatsapp-message:/, "");
  const { data, error } = await supabase.rpc("ingest_whatsapp_inbound_message", {
    target_organization_id: event.organization_id,
    target_connection_id: event.connected_account_id,
    target_branch_id: mapping.branch_id,
    target_phone_number_id: credential.phone_number_id,
    target_provider_message_id: providerMessageId,
    target_sender: message.sender,
    target_sender_name: message.senderName ?? null,
    target_sent_at: message.sentAt,
    target_message_type: message.messageType,
    target_body: message.body ?? null,
    target_provider_payload: message.providerPayload
  });
  if (error) {
    if (errorMessage(error).includes("WHATSAPP_NUMBER_NOT_MAPPED"))
      return { status: "UNMAPPED", safeErrorCode: "WHATSAPP_NUMBER_NOT_MAPPED" };
    if (permanentDatabaseError(error))
      throw new ProviderDispatchError("WHATSAPP_INBOUND_MESSAGE_REJECTED", true);
    throw error;
  }
  const result = data;
  return {
    status: "PROCESSED",
    payloadPatch: {
      conversation_id: result?.conversation_id ?? null,
      message_id: result?.message_id ?? null,
      duplicate: result?.duplicate ?? false
    }
  };
}
__name(dispatchWhatsAppInbound, "dispatchWhatsAppInbound");
async function dispatchWhatsAppStatus(supabase, event) {
  const { credential } = await whatsappContext(supabase, event);
  const status = readWhatsAppStatusReceipt(
    event.payload,
    credential.phone_number_id,
    event.provider_event_id
  );
  const { data, error } = await supabase.rpc("apply_whatsapp_message_status", {
    target_organization_id: event.organization_id,
    target_connection_id: event.connected_account_id,
    target_provider_message_id: status.providerMessageId,
    target_application_message_id: validApplicationMessageId(status.applicationMessageId),
    target_delivery_status: status.status,
    target_occurred_at: status.occurredAt
  });
  if (error) {
    if (permanentDatabaseError(error))
      throw new ProviderDispatchError("WHATSAPP_MESSAGE_STATUS_REJECTED", true);
    throw error;
  }
  const result = data;
  if (!result?.matched)
    throw new ProviderDispatchError("WHATSAPP_OUTBOUND_MESSAGE_NOT_FOUND", false);
  return {
    status: "PROCESSED",
    payloadPatch: {
      message_id: result.message_id ?? null,
      stale_status_ignored: result.updated === false
    }
  };
}
__name(dispatchWhatsAppStatus, "dispatchWhatsAppStatus");
async function dispatch(supabase, event) {
  if (event.event_type === "META_LEADGEN") return dispatchMetaLead(supabase, event);
  if (event.event_type === "GOOGLE_LEAD_FORM") return dispatchGoogleLead(supabase, event);
  if (event.event_type === "WHATSAPP_INBOUND_MESSAGE")
    return dispatchWhatsAppInbound(supabase, event);
  if (event.event_type === "WHATSAPP_MESSAGE_STATUS")
    return dispatchWhatsAppStatus(supabase, event);
  throw new ProviderDispatchError("PROVIDER_EVENT_TYPE_UNSUPPORTED", true);
}
__name(dispatch, "dispatch");
function classifiedError(error) {
  if (error instanceof ProviderDispatchError) return error;
  if (error instanceof InvalidProviderReceiptError)
    return new ProviderDispatchError(error.safeCode, true);
  if (permanentDatabaseError(error))
    return new ProviderDispatchError("PROVIDER_EVENT_PAYLOAD_REJECTED", true);
  return new ProviderDispatchError("PROVIDER_EVENT_PROCESSING_RETRY", false);
}
__name(classifiedError, "classifiedError");
async function processEvent(supabase, workerId, event) {
  try {
    const result = await dispatch(supabase, event);
    const { data, error } = await supabase.rpc("complete_provider_event", {
      target_event_id: event.id,
      target_worker_id: workerId,
      target_status: result.status,
      target_safe_error_code: result.safeErrorCode ?? null,
      target_payload_patch: result.payloadPatch ?? {}
    });
    if (error) throw error;
    return data === true ? "completed" : "lease_lost";
  } catch (error) {
    const classified = classifiedError(error);
    const delaySeconds = classified.delaySeconds ?? providerEventRetryDelaySeconds(event.attempt_count, event.provider_event_id);
    const { data, error: retryError } = await supabase.rpc("retry_provider_event", {
      target_event_id: event.id,
      target_worker_id: workerId,
      target_safe_error_code: classified.safeCode,
      target_delay_seconds: delaySeconds,
      target_permanent: classified.permanent
    });
    if (retryError) throw retryError;
    if (data !== true) return "lease_lost";
    return classified.permanent || event.attempt_count >= 8 ? "failed" : "retried";
  }
}
__name(processEvent, "processEvent");
var providerEventDispatch = schedules_exports.task({
  id: "provider-event-dispatch",
  cron: { pattern: "* * * * *", timezone: "UTC" },
  queue: { concurrencyLimit: 1 },
  ttl: "5m",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1e3, maxTimeoutInMs: 3e4 },
  run: /* @__PURE__ */ __name(async () => {
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const workerId = `trigger:${crypto.randomUUID()}`;
    const { data, error } = await supabase.rpc("claim_provider_events", {
      target_worker_id: workerId,
      target_batch_size: configuredBatchSize()
    });
    if (error) throw error;
    const claimed = data ?? [];
    const outcomes = [];
    const concurrency = configuredConcurrency();
    for (let offset = 0; offset < claimed.length; offset += concurrency) {
      outcomes.push(
        ...await Promise.all(
          claimed.slice(offset, offset + concurrency).map((event) => processEvent(supabase, workerId, event))
        )
      );
    }
    return {
      claimed: claimed.length,
      completed: outcomes.filter((outcome) => outcome === "completed").length,
      retried: outcomes.filter((outcome) => outcome === "retried").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
      lease_lost: outcomes.filter((outcome) => outcome === "lease_lost").length
    };
  }, "run")
});
export {
  providerEventDispatch
};
//# sourceMappingURL=provider-event-dispatch.mjs.map
