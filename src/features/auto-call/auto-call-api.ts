import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { aiCallLanguageSchema, type AiCallScript } from './ai-call-script-definition';
import { autoIvrDefinitionSchema, type AutoIvrDefinition } from './auto-ivr-definition';

const nullableString = z.string().nullable();

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

// ------------------------------------------------------------ Client Admin

export const autoCallModeSchema = z.enum(['KEYPAD_IVR', 'AI_AGENT']);
export type AutoCallMode = z.infer<typeof autoCallModeSchema>;

const adminWorkspaceSchema = z.object({
  organization_id: z.uuid(),
  ai_credit_balance: z.coerce.number(),
  settings: z.object({
    enabled: z.boolean(),
    mode: autoCallModeSchema,
    // Parsed loosely here: the editor validates it with aiCallScriptSchema.
    ai_script: z.record(z.string(), z.unknown()).nullable(),
    ai_credit_cost: z.coerce.number().int(),
    default_flow_id: z.uuid().nullable(),
    calling_window_start: z.string(),
    calling_window_end: z.string(),
    max_attempts_per_lead: z.coerce.number().int(),
    retry_after_minutes: z.coerce.number().int(),
    ring_timeout_sec: z.coerce.number().int(),
    max_duration_sec: z.coerce.number().int(),
    version: z.coerce.number().int().nullable(),
  }),
  flows: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
      version: z.coerce.number().int(),
      published_version_no: z.coerce.number().int().nullable(),
      published_at: nullableString,
      question_count: z.coerce.number().int(),
      updated_at: z.string(),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.uuid(),
      display_name: z.string(),
      status: z.string(),
      scope_mode: z.string(),
      caller_id_label: nullableString,
      agent_id: nullableString,
      last_error_code: nullableString,
      updated_at: z.string(),
    }),
  ),
  telecallers: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: z.string(),
      enabled: z.boolean(),
      paused_reason: nullableString,
      calls_today: z.coerce.number().int(),
    }),
  ),
});

export type AutoCallAdminWorkspace = z.infer<typeof adminWorkspaceSchema>;
export type AutoCallSettings = AutoCallAdminWorkspace['settings'];

export const autoCallAdminKey = ['auto-call-admin'] as const;

export async function fetchAutoCallAdminWorkspace(signal?: AbortSignal) {
  const request = createClient().rpc('get_auto_call_admin_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return adminWorkspaceSchema.parse(data);
}

export async function saveAutoCallSettings(input: {
  enabled: boolean;
  defaultFlowId: string | null;
  windowStart: string;
  windowEnd: string;
  maxAttempts: number;
  retryAfterMinutes: number;
  ringTimeoutSec: number;
  maxDurationSec: number;
  expectedVersion: number | null;
}) {
  const { data, error } = await createClient().rpc('save_auto_call_settings', {
    target_enabled: input.enabled,
    target_default_flow_id: input.defaultFlowId,
    target_calling_window_start: input.windowStart,
    target_calling_window_end: input.windowEnd,
    target_max_attempts_per_lead: input.maxAttempts,
    target_retry_after_minutes: input.retryAfterMinutes,
    target_ring_timeout_sec: input.ringTimeoutSec,
    target_max_duration_sec: input.maxDurationSec,
    expected_version: input.expectedVersion,
  });
  if (error) throw error;
  return z.object({ version: z.coerce.number().int() }).parse(data);
}

export async function saveAutoCallAiSettings(input: {
  mode: AutoCallMode;
  script: AiCallScript | null;
  creditCost: number;
  expectedVersion: number | null;
}) {
  const { data, error } = await createClient().rpc('save_auto_call_ai_settings', {
    target_mode: input.mode,
    target_ai_script: input.script,
    target_ai_credit_cost: input.creditCost,
    expected_version: input.expectedVersion,
  });
  if (error) throw error;
  return z.object({ version: z.coerce.number().int() }).parse(data);
}

export async function savePiopiyConnection(input: {
  organizationId: string;
  connectionId?: string;
  displayName: string;
  appId: string;
  token: string;
  callerId: string;
  defaultLanguage: string;
  defaultVoiceId: string;
  agentId: string;
}) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{ connection_id: string; status_webhook_url: string }>
  >('integration-connect-piopiy', {
    body: {
      organization_id: input.organizationId,
      connection_id: input.connectionId,
      display_name: input.displayName,
      scope_mode: 'ALL_BRANCHES',
      branch_ids: [],
      app_id: input.appId,
      token: input.token,
      caller_id: input.callerId,
      default_language: input.defaultLanguage,
      default_voice_id: input.defaultVoiceId,
      agent_id: input.agentId,
    },
  });
  if (error || !data?.ok || !data.data)
    throw new Error(data?.error?.message ?? 'The PIOPIY connection could not be saved.');
  return data.data;
}

// ------------------------------------------------------------ flows

const flowSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  version: z.coerce.number().int(),
  draft_definition: z.unknown(),
  published_version_no: z.coerce.number().int().nullable(),
  published_at: nullableString,
  has_unpublished_changes: z.boolean(),
  validation_error: nullableString,
  updated_at: z.string(),
});

export type AutoIvrFlowRecord = Omit<z.infer<typeof flowSchema>, 'draft_definition'> & {
  draft_definition: AutoIvrDefinition;
};

export const autoIvrFlowKey = (flowId: string) => ['auto-ivr-flow', flowId] as const;

export async function fetchAutoIvrFlow(flowId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_auto_ivr_flow', { target_flow_id: flowId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  const parsed = flowSchema.parse(data);
  return {
    ...parsed,
    draft_definition: autoIvrDefinitionSchema.parse(parsed.draft_definition),
  } satisfies AutoIvrFlowRecord;
}

const savedFlowSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int(),
  validation_error: nullableString,
});

export async function saveAutoIvrFlowDraft(input: {
  flowId: string | null;
  name: string;
  definition: AutoIvrDefinition;
  expectedVersion: number | null;
}) {
  const { data, error } = await createClient().rpc('save_auto_ivr_flow_draft', {
    target_flow_id: input.flowId,
    target_name: input.name.trim(),
    target_definition: input.definition,
    expected_version: input.expectedVersion,
  });
  if (error) throw error;
  return savedFlowSchema.parse(data);
}

export async function publishAutoIvrFlow(flowId: string, expectedVersion: number) {
  const { data, error } = await createClient().rpc('publish_auto_ivr_flow', {
    target_flow_id: flowId,
    expected_version: expectedVersion,
  });
  if (error) throw error;
  return z
    .object({ id: z.uuid(), version: z.coerce.number().int(), published_version_no: z.number() })
    .parse(data);
}

export async function archiveAutoIvrFlow(flowId: string, expectedVersion: number) {
  const { error } = await createClient().rpc('archive_auto_ivr_flow', {
    target_flow_id: flowId,
    expected_version: expectedVersion,
  });
  if (error) throw error;
}

async function sha256Base64(buffer: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Uploads a prompt recording to private storage against the flow. */
export async function uploadAutoIvrPromptAudio(input: {
  organizationId: string;
  flowId: string;
  file: File;
}) {
  const checksum = await sha256Base64(await input.file.arrayBuffer());
  const supabase = createClient();
  const { data: presign, error: presignError } = await supabase.functions.invoke<
    EdgeEnvelope<{
      upload_intent_id: string;
      upload_url: string;
      required_headers: Record<string, string>;
    }>
  >('presign-upload', {
    body: {
      organization_id: input.organizationId,
      branch_id: null,
      resource_type: 'auto_ivr_flow',
      resource_id: input.flowId,
      file_name: input.file.name,
      mime_type: input.file.type,
      size_bytes: input.file.size,
      checksum_sha256: checksum,
    },
  });
  if (presignError || !presign?.ok || !presign.data)
    throw new Error(presign?.error?.message ?? 'Use an MP3 or WAV file up to 5 MB.');
  const uploaded = await fetch(presign.data.upload_url, {
    method: 'PUT',
    headers: presign.data.required_headers,
    body: input.file,
  });
  if (!uploaded.ok) throw new Error('The recording could not be uploaded.');
  const { data: finalized, error: finalizeError } = await supabase.functions.invoke<
    EdgeEnvelope<{ object_file_id: string }>
  >('object-upload-finalize', { body: { upload_intent_id: presign.data.upload_intent_id } });
  if (finalizeError || !finalized?.ok || !finalized.data)
    throw new Error(finalized?.error?.message ?? 'The recording could not be saved.');
  return finalized.data.object_file_id;
}

export async function createAudioPreviewUrl(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{ download_url: string }>
  >('presign-download', { body: { object_file_id: objectFileId } });
  if (error || !data?.ok || !data.data) throw new Error('The recording could not be opened.');
  return data.data.download_url;
}

// ------------------------------------------------------------ telecaller

const statusSchema = z.union([
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    mode: autoCallModeSchema,
    blocked_reason: nullableString,
    enabled: z.boolean(),
    paused_reason: nullableString,
    in_window: z.boolean(),
    calling_window_start: z.string(),
    calling_window_end: z.string(),
    current_call: z
      .object({
        call_id: z.uuid(),
        lead_id: z.uuid(),
        customer_name: z.string(),
        status: z.string(),
        started_at: z.string(),
      })
      .nullable(),
    waiting_count: z.coerce.number().int(),
    today: z.object({
      calls: z.coerce.number().int(),
      answered: z.coerce.number().int(),
      no_answer: z.coerce.number().int(),
      failed: z.coerce.number().int(),
    }),
  }),
]);

export type MyAutoCallStatus = z.infer<typeof statusSchema>;

export const myAutoCallStatusKey = ['my-auto-call-status'] as const;

export async function fetchMyAutoCallStatus(signal?: AbortSignal) {
  const request = createClient().rpc('get_my_auto_call_status');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return statusSchema.parse(data);
}

export async function setMyAutoCall(enabled: boolean) {
  const { error } = await createClient().rpc('set_my_auto_call', { target_enabled: enabled });
  if (error) throw error;
}

const myCallsSchema = z.object({
  records: z.array(
    z.object({
      call_id: z.uuid(),
      lead_id: z.uuid(),
      customer_name: z.string(),
      interested_model: nullableString,
      attempt_no: z.coerce.number().int(),
      status: z.string(),
      mode: autoCallModeSchema,
      ai_outcome: nullableString,
      outcome: nullableString,
      answers: z.coerce.number().int(),
      verified: z.boolean(),
      created_at: z.string(),
    }),
  ),
  total: z.coerce.number().int(),
  page: z.coerce.number().int(),
  page_size: z.coerce.number().int(),
});

export type MyAutoCalls = z.infer<typeof myCallsSchema>;

export async function fetchMyAutoCalls(page: number, pageSize: number, signal?: AbortSignal) {
  const request = createClient().rpc('get_my_auto_calls', {
    target_page: page,
    target_page_size: pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return myCallsSchema.parse(data);
}

// ------------------------------------------------------------ call page

export const aiCallOutcomeSchema = z.enum([
  'ANSWERED_QUALIFIED',
  'CALLBACK_REQUESTED',
  'NOT_INTERESTED',
  'DO_NOT_CALL',
  'WRONG_NUMBER',
  'NO_RESPONSE',
  'VOICEMAIL',
  'FAILED',
]);
export type AiCallOutcome = z.infer<typeof aiCallOutcomeSchema>;

export const aiCallOutcomeLabels: Record<AiCallOutcome, string> = {
  ANSWERED_QUALIFIED: 'Answered the questions',
  CALLBACK_REQUESTED: 'Asked for a callback',
  NOT_INTERESTED: 'Not interested',
  DO_NOT_CALL: 'Asked not to be called',
  WRONG_NUMBER: 'Wrong number',
  NO_RESPONSE: 'Picked up, did not speak',
  VOICEMAIL: 'Voicemail',
  FAILED: 'Call failed',
};

const resultSchema = z.object({
  call: z.object({
    id: z.uuid(),
    mode: autoCallModeSchema,
    status: z.string(),
    outcome: nullableString,
    started_at: z.string(),
    answered_at: nullableString,
    ended_at: nullableString,
    duration_seconds: z.coerce.number().int().nullable(),
    finalized: z.boolean(),
  }),
  lead: z
    .object({
      id: z.uuid(),
      customer_name: z.string(),
      phone: z.string(),
      interested_model: nullableString,
      lifecycle_status: z.string(),
      temperature: nullableString,
      next_followup_at: nullableString,
      auto_contact_call_id: z.uuid().nullable(),
      verified_at: nullableString,
      verified_by_name: nullableString,
      can_update: z.boolean(),
      current: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  answers: z.array(
    z.object({
      node_id: z.string(),
      attempt_no: z.coerce.number().int(),
      question: z.string(),
      key_pressed: nullableString,
      meaning: nullableString,
      answered_at: z.string(),
    }),
  ),
  suggestions: z.record(z.string(), z.unknown()),
  applied: z.record(z.string(), z.unknown()),
  ai: z
    .object({
      outcome: aiCallOutcomeSchema.nullable(),
      summary: nullableString,
      language: aiCallLanguageSchema.nullable(),
    })
    .nullable(),
  transcript: z
    .array(
      z.object({
        speaker: z.enum(['AGENT', 'CUSTOMER', 'UNKNOWN']),
        text: z.string(),
      }),
    )
    .nullable(),
  recordings: z.array(
    z.object({
      id: z.uuid(),
      status: z.string(),
      object_file_id: z.uuid().nullable(),
      duration_seconds: z.coerce.number().int().nullable(),
    }),
  ),
});

export type AutoCallResult = z.infer<typeof resultSchema>;

export const autoCallResultKey = (callId: string) => ['auto-call-result', callId] as const;

export async function fetchAutoCallResult(callId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_auto_call_result', { target_call_id: callId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}

export async function applyAutoCallSuggestions(input: {
  callId: string;
  fields: string[];
  requestId: string;
}) {
  const { error } = await createClient().rpc('apply_auto_call_suggestions', {
    target_call_id: input.callId,
    target_fields: input.fields,
    target_request_id: input.requestId,
  });
  if (error) throw error;
}

export async function setLeadCallLanguage(leadId: string, language: string | null) {
  const { error } = await createClient().rpc('set_lead_call_language', {
    target_lead_id: leadId,
    target_language: language,
  });
  if (error) throw error;
}

export async function verifyAutoContact(callId: string) {
  const { error } = await createClient().rpc('verify_auto_contact', { target_call_id: callId });
  if (error) throw error;
}

const errorMessages: Record<string, string> = {
  AUTO_CALL_NOT_CONFIGURED: 'Your Client Admin has not switched Auto call on yet.',
  AUTO_IVR_FLOW_NOT_PUBLISHED: 'No published question flow is set for Auto call.',
  AUTO_IVR_FLOW_REQUIRED: 'Choose a published question flow first.',
  PIOPIY_NOT_CONNECTED: 'TeleCMI PIOPIY is not connected yet.',
  AUTO_CALL_TELECALLER_REQUIRED: 'Auto call is for telecallers only.',
  AUTO_IVR_FLOW_IN_USE: 'This flow is the one Auto call uses. Choose another flow first.',
  AUTO_CONTACT_NOT_FROM_THIS_CALL: 'This lead was contacted on another call.',
  AUTO_CALL_FIELD_NOT_SUGGESTED: 'That answer was not given on this call.',
  LEAD_UPDATE_PERMISSION_REQUIRED: 'You cannot update this lead.',
  AI_SCRIPT_MISSING: 'Write and save the AI call script first.',
  AI_SCRIPT_AGENT_NAME_INVALID: 'Give the AI agent a name.',
  AI_SCRIPT_GOAL_INVALID: 'Describe the goal of the call in a sentence.',
  AI_SCRIPT_LANGUAGES_INVALID: 'Choose the languages the AI may speak.',
  AI_SCRIPT_DEFAULT_LANGUAGE_INVALID: 'The default language must be one of the call languages.',
  AI_SCRIPT_QUESTIONS_INVALID: 'Add between 1 and 12 questions.',
  AI_SCRIPT_QUESTION_INVALID: 'Every question needs text and a valid CRM field.',
  AI_SCRIPT_TEXT_TOO_LONG: 'The intro or closing is too long.',
  LEAD_CALL_LANGUAGE_INVALID: 'Choose one of the supported call languages.',
};

/** A safe, specific message for a known RPC error; generic otherwise. */
export function autoCallErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; code?: unknown; details?: unknown };
    if (record.code === 'PT409') return 'Someone else changed this. Reload and try again.';
    const message = typeof record.message === 'string' ? record.message : '';
    if (message === 'AUTO_IVR_FLOW_INVALID' && typeof record.details === 'string')
      return record.details;
    if (errorMessages[message]) return errorMessages[message];
  }
  return fallback;
}

export const pausedReasonLabels: Record<string, string> = {
  AUTO_IVR_FLOW_NOT_PUBLISHED: 'No published question flow',
  PIOPIY_NOT_CONNECTED: 'PIOPIY not connected for this branch',
  PIOPIY_AUTH_FAILED: 'PIOPIY rejected the token',
  PIOPIY_BALANCE_LOW: 'PIOPIY balance is low',
  PROVIDER_FAILING: 'Three calls in a row failed',
  NOT_A_TELECALLER: 'Not a telecaller any more',
  AUTO_CALL_DISABLED: 'Switched off by Client Admin',
  AI_SCRIPT_MISSING: 'No AI call script saved',
  AI_CREDITS_EXHAUSTED: 'Not enough AI credits',
  AI_AGENT_NOT_CONFIGURED: 'PIOPIY AI agent ID is missing',
};
