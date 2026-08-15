import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';
import { normalizeGoogleLead } from '../src/lib/providers/google-lead-form-adapter';
import { normalizeMetaLead } from '../src/lib/providers/meta-lead-adapter';
import {
  InvalidProviderReceiptError,
  providerEventRetryDelaySeconds,
  readGoogleLeadReceipt,
  readMetaLeadReceipt,
  readWhatsAppInboundReceipt,
  readWhatsAppStatusReceipt,
} from '../src/lib/providers/provider-event-receipts';

type ProviderEvent = {
  id: string;
  organization_id: string;
  connected_account_id: string;
  provider_event_id: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
};

type ConnectedAccount = {
  id: string;
  organization_id: string;
  provider_key: string;
  status: string;
  scope_mode: string;
  default_team_id: string | null;
};

type StoredOAuthCredential = {
  access_token: string;
  asset_access_tokens?: Record<string, string>;
};

type WhatsAppCredential = {
  access_token: string;
  phone_number_id: string;
  whatsapp_business_account_id: string;
};

type TerminalStatus = 'PROCESSED' | 'UNMAPPED';

type DispatchResult = {
  status: TerminalStatus;
  safeErrorCode?: string;
  payloadPatch?: Record<string, unknown>;
};

class ProviderDispatchError extends Error {
  constructor(
    readonly safeCode: string,
    readonly permanent: boolean,
    readonly delaySeconds?: number,
  ) {
    super(safeCode);
    this.name = 'ProviderDispatchError';
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new ProviderDispatchError(`${name}_MISSING`, false);
  return value;
}

function configuredBatchSize() {
  const value = Number(process.env.PROVIDER_EVENT_BATCH_SIZE ?? 25);
  if (!Number.isSafeInteger(value) || value < 1 || value > 50)
    throw new ProviderDispatchError('PROVIDER_EVENT_BATCH_SIZE_INVALID', true);
  return value;
}

function configuredConcurrency() {
  const value = Number(process.env.PROVIDER_EVENT_CONCURRENCY ?? 5);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10)
    throw new ProviderDispatchError('PROVIDER_EVENT_CONCURRENCY_INVALID', true);
  return value;
}

function fromBase64Url(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

function parseBytea(value: string) {
  if (value.startsWith('\\x')) return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
  return fromBase64Url(value);
}

async function decryptCredential<T>(value: unknown): Promise<T> {
  if (typeof value !== 'string')
    throw new ProviderDispatchError('INTEGRATION_CREDENTIAL_INVALID', true);
  try {
    const envelope = JSON.parse(new TextDecoder().decode(parseBytea(value))) as {
      version: string;
      iv: string;
      ciphertext: string;
    };
    if (envelope.version !== 'AES-256-GCM-v1')
      throw new ProviderDispatchError('INTEGRATION_CREDENTIAL_VERSION_UNSUPPORTED', true);
    const rawKey = fromBase64Url(requiredEnvironment('INTEGRATION_ENCRYPTION_KEY'));
    if (rawKey.byteLength !== 32)
      throw new ProviderDispatchError('INTEGRATION_ENCRYPTION_KEY_INVALID', false);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
      key,
      fromBase64Url(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    if (error instanceof ProviderDispatchError) throw error;
    throw new ProviderDispatchError('INTEGRATION_CREDENTIAL_DECRYPT_FAILED', false);
  }
}

function errorMessage(error: unknown) {
  return error !== null && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : '';
}

function permanentDatabaseError(error: unknown) {
  const message = errorMessage(error);
  return [
    'INVALID_PROVIDER_SOURCE',
    'INVALID_PROVIDER_LEAD_IDENTITY',
    'EXTERNAL_LEAD_ID_REQUIRED',
    'EXTERNAL_LEAD_ID_TOO_LONG',
    'INVALID_WHATSAPP_INBOUND_MESSAGE',
    'INVALID_WHATSAPP_MESSAGE_STATUS',
    'WHATSAPP_PROVIDER_MESSAGE_AMBIGUOUS',
    'WHATSAPP_PROVIDER_MESSAGE_CONFLICT',
  ].some((code) => message.includes(code));
}

function retryAfterSeconds(response: Response) {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric)
    ? Math.ceil(numeric)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(5, Math.min(86_400, seconds)) : undefined;
}

function providerHttpFailure(provider: 'META', response: Response): ProviderDispatchError {
  if ([408, 409, 425, 429].includes(response.status) || response.status >= 500)
    return new ProviderDispatchError(
      `${provider}_PROVIDER_TEMPORARILY_UNAVAILABLE`,
      false,
      retryAfterSeconds(response),
    );
  if ([401, 403].includes(response.status))
    return new ProviderDispatchError(`${provider}_RECONNECT_REQUIRED`, true);
  if (response.status === 404)
    return new ProviderDispatchError(`${provider}_RESOURCE_NOT_FOUND`, true);
  return new ProviderDispatchError(`${provider}_PROVIDER_REQUEST_REJECTED`, true);
}

async function readBoundedJson(response: Response, maximumBytes: number) {
  const declaredBytes = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes)
    throw new ProviderDispatchError('PROVIDER_RESPONSE_TOO_LARGE', true);
  if (!response.body) throw new ProviderDispatchError('PROVIDER_RESPONSE_EMPTY', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ProviderDispatchError('PROVIDER_RESPONSE_TOO_LARGE', true);
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
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new ProviderDispatchError('PROVIDER_RESPONSE_INVALID', false);
  }
}

async function activeConnection(supabase: SupabaseClient, event: ProviderEvent) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id,organization_id,provider_key,status,scope_mode,default_team_id')
    .eq('id', event.connected_account_id)
    .eq('organization_id', event.organization_id)
    .eq('status', 'CONNECTED')
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ProviderDispatchError('CONNECTED_ACCOUNT_NOT_ACTIVE', true);
  return data as ConnectedAccount;
}

async function credentialFor<T>(supabase: SupabaseClient, connection: ConnectedAccount) {
  const { data, error } = await supabase
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', connection.organization_id)
    .eq('connected_account_id', connection.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ProviderDispatchError('INTEGRATION_CREDENTIAL_MISSING', false);
  return decryptCredential<T>(data.encrypted_payload);
}

async function exactMapping(
  supabase: SupabaseClient,
  event: ProviderEvent,
  resourceType: string,
  resourceId: string,
) {
  const { data, error } = await supabase
    .from('integration_branch_mappings')
    .select('branch_id,team_id')
    .eq('organization_id', event.organization_id)
    .eq('connected_account_id', event.connected_account_id)
    .eq('external_resource_type', resourceType)
    .eq('external_resource_id', resourceId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { branch_id: string; team_id: string | null } | null;
}

async function connectionScopeMapping(supabase: SupabaseClient, event: ProviderEvent) {
  const { data, error } = await supabase
    .from('integration_branch_mappings')
    .select('branch_id,team_id')
    .eq('organization_id', event.organization_id)
    .eq('connected_account_id', event.connected_account_id)
    .eq('external_resource_type', 'CONNECTION_SCOPE')
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { branch_id: string; team_id: string | null } | null;
}

async function ingestLead(
  supabase: SupabaseClient,
  event: ProviderEvent,
  mapping: { branch_id: string; team_id: string | null },
  connection: ConnectedAccount,
  lead: {
    externalLeadId: string;
    source: string;
    sourceDetail?: string;
    campaign?: string;
    customerName: string;
    phone: string;
    email?: string;
    interestedModel?: string;
  },
  rawPayload: unknown,
) {
  const { data, error } = await supabase.rpc('ingest_provider_lead', {
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
    target_request_id: event.id,
  });
  if (error) {
    if (permanentDatabaseError(error))
      throw new ProviderDispatchError('PROVIDER_LEAD_REJECTED', true);
    throw error;
  }
  return data as { lead_id?: string; duplicate?: boolean } | null;
}

async function dispatchMetaLead(
  supabase: SupabaseClient,
  event: ProviderEvent,
): Promise<DispatchResult> {
  const receipt = readMetaLeadReceipt(event.payload, event.provider_event_id);
  const connection = await activeConnection(supabase, event);
  if (connection.provider_key !== 'meta')
    throw new ProviderDispatchError('PROVIDER_EVENT_CONNECTION_MISMATCH', true);
  const mapping = await exactMapping(supabase, event, 'META_PAGE', receipt.pageId);
  if (!mapping) return { status: 'UNMAPPED', safeErrorCode: 'META_PAGE_NOT_MAPPED' };
  const credential = await credentialFor<StoredOAuthCredential>(supabase, connection);
  const pageAccessToken = credential.asset_access_tokens?.[receipt.pageId];
  if (!pageAccessToken) throw new ProviderDispatchError('META_PAGE_RECONNECT_REQUIRED', true);
  const graphVersion = requiredEnvironment('META_GRAPH_API_VERSION');
  if (!/^v\d+\.\d+$/.test(graphVersion))
    throw new ProviderDispatchError('META_GRAPH_API_VERSION_INVALID', false);
  const leadUrl = new URL(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(receipt.leadId)}`,
  );
  leadUrl.search = new URLSearchParams({
    fields: 'id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,platform',
  }).toString();
  let response: Response;
  try {
    response = await fetch(leadUrl, {
      headers: { authorization: `Bearer ${pageAccessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderDispatchError('META_LEAD_FETCH_RETRY', false);
  }
  if (!response.ok) throw providerHttpFailure('META', response);
  const providerPayload = await readBoundedJson(response, 512_000);
  let normalized: ReturnType<typeof normalizeMetaLead>;
  try {
    normalized = normalizeMetaLead(providerPayload, {
      externalLeadId: receipt.leadId,
      sourceDetail: 'Meta Lead Ads',
    });
  } catch {
    throw new ProviderDispatchError('META_LEAD_MINIMUM_FIELDS_MISSING', true);
  }
  const result = await ingestLead(
    supabase,
    event,
    mapping,
    connection,
    { ...normalized, externalLeadId: receipt.leadId },
    providerPayload,
  );
  return {
    status: 'PROCESSED',
    payloadPatch: {
      lead_id: result?.lead_id ?? null,
      duplicate: result?.duplicate ?? false,
    },
  };
}

async function googleMapping(
  supabase: SupabaseClient,
  event: ProviderEvent,
  connection: ConnectedAccount,
  formId?: string,
  campaignId?: string,
) {
  const externalIds = [formId, campaignId].filter((value): value is string => Boolean(value));
  if (externalIds.length > 0) {
    const { data, error } = await supabase
      .from('integration_branch_mappings')
      .select('branch_id,team_id,external_resource_type,external_resource_id')
      .eq('organization_id', event.organization_id)
      .eq('connected_account_id', event.connected_account_id)
      .is('deleted_at', null)
      .in('external_resource_type', ['GOOGLE_ADS_LEAD_FORM', 'GOOGLE_ADS_CAMPAIGN'])
      .in('external_resource_id', externalIds);
    if (error) throw error;
    const mappings = (data ?? []) as Array<{
      branch_id: string;
      team_id: string | null;
      external_resource_type: string;
      external_resource_id: string;
    }>;
    const selected =
      mappings.find(
        (candidate) =>
          candidate.external_resource_type === 'GOOGLE_ADS_LEAD_FORM' &&
          candidate.external_resource_id === formId,
      ) ??
      mappings.find(
        (candidate) =>
          candidate.external_resource_type === 'GOOGLE_ADS_CAMPAIGN' &&
          candidate.external_resource_id === campaignId,
      );
    if (selected) return { branch_id: selected.branch_id, team_id: selected.team_id };
  }
  if (connection.scope_mode === 'ONE_BRANCH') return connectionScopeMapping(supabase, event);
  return null;
}

async function dispatchGoogleLead(
  supabase: SupabaseClient,
  event: ProviderEvent,
): Promise<DispatchResult> {
  const { envelope, safePayload } = readGoogleLeadReceipt(event.payload, event.provider_event_id);
  const connection = await activeConnection(supabase, event);
  if (connection.provider_key !== 'google_ads')
    throw new ProviderDispatchError('PROVIDER_EVENT_CONNECTION_MISMATCH', true);
  const mapping = await googleMapping(
    supabase,
    event,
    connection,
    envelope.formId,
    envelope.campaignId,
  );
  if (!mapping)
    return {
      status: 'UNMAPPED',
      safeErrorCode: 'GOOGLE_FORM_OR_CAMPAIGN_NOT_MAPPED',
    };
  let normalized: ReturnType<typeof normalizeGoogleLead>;
  try {
    normalized = normalizeGoogleLead(envelope);
  } catch {
    throw new ProviderDispatchError('GOOGLE_LEAD_MINIMUM_FIELDS_MISSING', true);
  }
  const result = await ingestLead(
    supabase,
    event,
    mapping,
    connection,
    { ...normalized, externalLeadId: envelope.leadId },
    safePayload,
  );
  return {
    status: 'PROCESSED',
    payloadPatch: {
      lead_id: result?.lead_id ?? null,
      duplicate: result?.duplicate ?? false,
    },
  };
}

function validApplicationMessageId(value?: string) {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

async function whatsappContext(supabase: SupabaseClient, event: ProviderEvent) {
  const connection = await activeConnection(supabase, event);
  if (connection.provider_key !== 'whatsapp_cloud')
    throw new ProviderDispatchError('PROVIDER_EVENT_CONNECTION_MISMATCH', true);
  const credential = await credentialFor<WhatsAppCredential>(supabase, connection);
  if (!credential.phone_number_id || credential.phone_number_id.length > 255)
    throw new ProviderDispatchError('WHATSAPP_RECONNECT_REQUIRED', true);
  return { connection, credential };
}

async function dispatchWhatsAppInbound(
  supabase: SupabaseClient,
  event: ProviderEvent,
): Promise<DispatchResult> {
  const { credential } = await whatsappContext(supabase, event);
  const message = readWhatsAppInboundReceipt(
    event.payload,
    credential.phone_number_id,
    event.provider_event_id,
  );
  const mapping = await exactMapping(
    supabase,
    event,
    'WHATSAPP_PHONE_NUMBER',
    credential.phone_number_id,
  );
  if (!mapping) return { status: 'UNMAPPED', safeErrorCode: 'WHATSAPP_NUMBER_NOT_MAPPED' };
  const providerMessageId = message.eventId.replace(/^whatsapp-message:/, '');
  const { data, error } = await supabase.rpc('ingest_whatsapp_inbound_message', {
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
    target_provider_payload: message.providerPayload,
  });
  if (error) {
    if (errorMessage(error).includes('WHATSAPP_NUMBER_NOT_MAPPED'))
      return { status: 'UNMAPPED', safeErrorCode: 'WHATSAPP_NUMBER_NOT_MAPPED' };
    if (permanentDatabaseError(error))
      throw new ProviderDispatchError('WHATSAPP_INBOUND_MESSAGE_REJECTED', true);
    throw error;
  }
  const result = data as {
    conversation_id?: string;
    message_id?: string;
    duplicate?: boolean;
  } | null;
  return {
    status: 'PROCESSED',
    payloadPatch: {
      conversation_id: result?.conversation_id ?? null,
      message_id: result?.message_id ?? null,
      duplicate: result?.duplicate ?? false,
    },
  };
}

async function dispatchWhatsAppStatus(
  supabase: SupabaseClient,
  event: ProviderEvent,
): Promise<DispatchResult> {
  const { credential } = await whatsappContext(supabase, event);
  const status = readWhatsAppStatusReceipt(
    event.payload,
    credential.phone_number_id,
    event.provider_event_id,
  );
  const { data, error } = await supabase.rpc('apply_whatsapp_message_status', {
    target_organization_id: event.organization_id,
    target_connection_id: event.connected_account_id,
    target_provider_message_id: status.providerMessageId,
    target_application_message_id: validApplicationMessageId(status.applicationMessageId),
    target_delivery_status: status.status,
    target_occurred_at: status.occurredAt,
  });
  if (error) {
    if (permanentDatabaseError(error))
      throw new ProviderDispatchError('WHATSAPP_MESSAGE_STATUS_REJECTED', true);
    throw error;
  }
  const result = data as { matched?: boolean; updated?: boolean; message_id?: string } | null;
  if (!result?.matched)
    throw new ProviderDispatchError('WHATSAPP_OUTBOUND_MESSAGE_NOT_FOUND', false);
  return {
    status: 'PROCESSED',
    payloadPatch: {
      message_id: result.message_id ?? null,
      stale_status_ignored: result.updated === false,
    },
  };
}

async function dispatch(supabase: SupabaseClient, event: ProviderEvent) {
  if (event.event_type === 'META_LEADGEN') return dispatchMetaLead(supabase, event);
  if (event.event_type === 'GOOGLE_LEAD_FORM') return dispatchGoogleLead(supabase, event);
  if (event.event_type === 'WHATSAPP_INBOUND_MESSAGE')
    return dispatchWhatsAppInbound(supabase, event);
  if (event.event_type === 'WHATSAPP_MESSAGE_STATUS')
    return dispatchWhatsAppStatus(supabase, event);
  throw new ProviderDispatchError('PROVIDER_EVENT_TYPE_UNSUPPORTED', true);
}

function classifiedError(error: unknown) {
  if (error instanceof ProviderDispatchError) return error;
  if (error instanceof InvalidProviderReceiptError)
    return new ProviderDispatchError(error.safeCode, true);
  if (permanentDatabaseError(error))
    return new ProviderDispatchError('PROVIDER_EVENT_PAYLOAD_REJECTED', true);
  return new ProviderDispatchError('PROVIDER_EVENT_PROCESSING_RETRY', false);
}

type ProcessingResult = 'completed' | 'retried' | 'failed' | 'lease_lost';

async function processEvent(
  supabase: SupabaseClient,
  workerId: string,
  event: ProviderEvent,
): Promise<ProcessingResult> {
  try {
    const result = await dispatch(supabase, event);
    const { data, error } = await supabase.rpc('complete_provider_event', {
      target_event_id: event.id,
      target_worker_id: workerId,
      target_status: result.status,
      target_safe_error_code: result.safeErrorCode ?? null,
      target_payload_patch: result.payloadPatch ?? {},
    });
    if (error) throw error;
    return data === true ? 'completed' : 'lease_lost';
  } catch (error) {
    const classified = classifiedError(error);
    const delaySeconds =
      classified.delaySeconds ??
      providerEventRetryDelaySeconds(event.attempt_count, event.provider_event_id);
    const { data, error: retryError } = await supabase.rpc('retry_provider_event', {
      target_event_id: event.id,
      target_worker_id: workerId,
      target_safe_error_code: classified.safeCode,
      target_delay_seconds: delaySeconds,
      target_permanent: classified.permanent,
    });
    if (retryError) throw retryError;
    if (data !== true) return 'lease_lost';
    return classified.permanent || event.attempt_count >= 8 ? 'failed' : 'retried';
  }
}

export const providerEventDispatch = schedules.task({
  id: 'provider-event-dispatch',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  ttl: '5m',
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const workerId = `trigger:${crypto.randomUUID()}`;
    const { data, error } = await supabase.rpc('claim_provider_events', {
      target_worker_id: workerId,
      target_batch_size: configuredBatchSize(),
    });
    if (error) throw error;
    const claimed = (data ?? []) as ProviderEvent[];
    const outcomes: ProcessingResult[] = [];
    const concurrency = configuredConcurrency();
    for (let offset = 0; offset < claimed.length; offset += concurrency) {
      outcomes.push(
        ...(await Promise.all(
          claimed
            .slice(offset, offset + concurrency)
            .map((event) => processEvent(supabase, workerId, event)),
        )),
      );
    }
    return {
      claimed: claimed.length,
      completed: outcomes.filter((outcome) => outcome === 'completed').length,
      retried: outcomes.filter((outcome) => outcome === 'retried').length,
      failed: outcomes.filter((outcome) => outcome === 'failed').length,
      lease_lost: outcomes.filter((outcome) => outcome === 'lease_lost').length,
    };
  },
});
