import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  CallVersionConflictError,
  callOutcomeValues,
  callSourceValues,
  callStatusValues,
  callWorkspaceViewValues,
  isCallVersionConflict,
  type CallQuery,
  type CallWorkspaceView,
} from './call-workspace-query';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();
const callSpeakerTurnSchema = z.object({
  speaker: z.enum(['AGENT', 'CUSTOMER', 'UNKNOWN']),
  text: z.string(),
});

export const callRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  lead_id: nullableUuid,
  customer_id: nullableUuid,
  customer_name: nullableString,
  phone: nullableString,
  branch_name: z.string(),
  team_name: nullableString,
  caller_name: z.string(),
  caller_role: nullableString,
  provider_name: nullableString,
  provider_call_id: nullableString,
  direction: z.string(),
  call_source: z.string(),
  started_at: z.string(),
  ended_at: nullableString,
  duration_seconds: z.coerce.number().int().nonnegative().nullable(),
  outcome: nullableString,
  status: z.string(),
  recording_status: nullableString,
  recording_available: z.boolean(),
  transcript_status: nullableString,
  ai_summary_available: z.boolean(),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
});

export type CallRecord = z.infer<typeof callRecordSchema>;

const callWorkspaceSchema = z.object({
  records: z.array(callRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_today: z.coerce.number().int().nonnegative(),
    connected_today: z.coerce.number().int().nonnegative(),
    connection_rate: z.coerce.number().nonnegative(),
    average_duration_seconds: z.coerce.number().int().nonnegative(),
    callbacks_required: z.coerce.number().int().nonnegative(),
    recordings_ready: z.coerce.number().int().nonnegative(),
    // Keep the workspace usable while an older RPC response is being rolled
    // forward. The database migration supplies the authoritative values; these
    // defaults prevent an additive KPI from blanking the entire Calls page.
    not_connected_today: z.coerce.number().int().nonnegative().default(0),
    talk_time_seconds: z.coerce.number().int().nonnegative().default(0),
  }),
  trend: z.array(
    z.object({
      name: z.string(),
      value: z.coerce.number().int().nonnegative(),
      secondary: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type CallWorkspaceResult = z.infer<typeof callWorkspaceSchema>;

export type CallWorkspacePermissions = {
  organizationId: string;
  scopeKey: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDownload: boolean;
};

export async function fetchCallWorkspacePermissions(): Promise<CallWorkspacePermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    organization_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (context?.destination !== 'CRM' || !context.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');

  const permissionResponses = await Promise.all(
    ['call.view', 'call.create', 'call.update', 'document.download'].map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: context.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = permissionResponses.find((response) => response.error);
  if (failed?.error) throw failed.error;
  if (!permissionResponses[0]?.data) throw new Error('CALL_VIEW_PERMISSION_REQUIRED');
  return {
    organizationId: context.organization_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canCreate: Boolean(permissionResponses[1]?.data),
    canUpdate: Boolean(permissionResponses[2]?.data),
    canDownload: Boolean(permissionResponses[3]?.data),
  };
}

export async function fetchCallWorkspace(
  query: CallQuery,
  signal?: AbortSignal,
  view: CallWorkspaceView = 'history',
): Promise<CallWorkspaceResult> {
  const request = createClient().rpc('get_call_workspace_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_status: callStatusValues[query.status],
    target_outcome: callOutcomeValues[query.outcome],
    target_source: callSourceValues[query.source],
    target_sort: query.sort,
    target_view: callWorkspaceViewValues[view],
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return callWorkspaceSchema.parse(data);
}

const callPartySchema = z.object({
  key: z.string(),
  lead_id: nullableUuid,
  customer_id: nullableUuid,
  branch_id: nullableUuid,
  team_id: nullableUuid,
  customer_name: z.string(),
  phone: nullableString,
  context_label: z.string(),
});

export type CallPartyOption = z.infer<typeof callPartySchema>;

export async function fetchCallPartyOptions(
  search: string,
  signal?: AbortSignal,
): Promise<CallPartyOption[]> {
  const request = createClient().rpc('get_call_party_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(callPartySchema).parse(data);
}

export type CallScopeOptions = {
  branches: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; branch_id: string; name: string }>;
};

export async function fetchCallScopeOptions(signal?: AbortSignal): Promise<CallScopeOptions> {
  const supabase = createClient();
  const branchRequest = supabase
    .from('branches')
    .select('id,name')
    .eq('active', true)
    .order('name');
  const teamRequest = supabase
    .from('teams')
    .select('id,branch_id,name')
    .eq('active', true)
    .order('name');
  const [branches, teams] = await Promise.all([
    signal ? branchRequest.abortSignal(signal) : branchRequest,
    signal ? teamRequest.abortSignal(signal) : teamRequest,
  ]);
  if (branches.error) throw branches.error;
  if (teams.error) throw teams.error;
  return {
    branches: branches.data as CallScopeOptions['branches'],
    teams: teams.data as CallScopeOptions['teams'],
  };
}

const callProviderOptionSchema = z.object({
  id: z.uuid(),
  provider_key: z.literal('telecmi'),
  display_name: z.string(),
  caller_id_label: nullableString,
});
export type CallProviderOption = z.infer<typeof callProviderOptionSchema>;

export async function fetchCallProviderOptions(
  branchId: string,
  signal?: AbortSignal,
): Promise<CallProviderOption[]> {
  const request = createClient().rpc('get_call_provider_options', {
    target_branch_id: branchId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(callProviderOptionSchema).parse(data);
}

export async function startProviderCall(input: {
  organizationId: string;
  connectionId: string;
  leadId: string;
  requestId: string;
}) {
  const { data, error } = await createClient().functions.invoke<
    EdgeEnvelope<{
      call_id: string;
      provider_request_id: string;
      status: string;
    }>
  >('call-provider-start', {
    body: {
      organization_id: input.organizationId,
      connection_id: input.connectionId,
      lead_id: input.leadId,
      request_id: input.requestId,
    },
  });
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'PROVIDER_CALL_START_FAILED');
  return z
    .object({ call_id: z.uuid(), provider_request_id: z.string(), status: z.string() })
    .parse(data.data);
}

const createdCallSchema = z.object({
  call_id: z.uuid(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  replayed: z.boolean(),
});

export type CreateManualCallInput = {
  organizationId: string;
  branchId: string;
  teamId: string | null;
  leadId: string | null;
  customerId: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  startedAt: string;
  notes: string;
  requestId: string;
};

export async function createManualCall(input: CreateManualCallInput) {
  const { data, error } = await createClient().rpc('create_manual_call', {
    target_organization_id: input.organizationId,
    target_branch_id: input.branchId,
    target_team_id: input.teamId,
    target_lead_id: input.leadId,
    target_customer_id: input.customerId,
    target_direction: input.direction,
    target_started_at: input.startedAt,
    target_notes: input.notes || null,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return createdCallSchema.parse(data);
}

const finalizedCallSchema = z.object({
  call_id: z.uuid(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  outcome: z.string(),
  duration_seconds: z.coerce.number().int().nonnegative(),
  replayed: z.boolean(),
});

export type FinalizeManualCallInput = {
  callId: string;
  expectedVersion: number;
  endedAt: string;
  outcome:
    | 'CONNECTED'
    | 'NO_ANSWER'
    | 'BUSY'
    | 'SWITCHED_OFF'
    | 'CALLBACK_REQUIRED'
    | 'WRONG_NUMBER'
    | 'OTHER';
  notes: string;
  requestId: string;
};

export async function finalizeManualCall(input: FinalizeManualCallInput) {
  const { data, error } = await createClient().rpc('finalize_manual_call', {
    target_call_id: input.callId,
    expected_version: input.expectedVersion,
    target_ended_at: input.endedAt,
    target_outcome: input.outcome,
    target_notes: input.notes || null,
    target_request_id: input.requestId,
  });
  if (isCallVersionConflict(error)) throw new CallVersionConflictError();
  if (error) throw error;
  return finalizedCallSchema.parse(data);
}

export async function logCompletedManualCall(
  input: Omit<CreateManualCallInput, 'requestId'> & {
    endedAt: string;
    outcome: FinalizeManualCallInput['outcome'];
    createRequestId: string;
    finalizeRequestId: string;
  },
) {
  const created = await createManualCall({ ...input, requestId: input.createRequestId });
  return finalizeManualCall({
    callId: created.call_id,
    expectedVersion: created.version,
    endedAt: input.endedAt,
    outcome: input.outcome,
    notes: input.notes,
    requestId: input.finalizeRequestId,
  });
}

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

async function sha256Base64(buffer: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function uploadManualCallRecording(input: {
  organizationId: string;
  branchId: string;
  callId: string;
  file: File;
  requestId: string;
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
      branch_id: input.branchId,
      resource_type: 'call',
      resource_id: input.callId,
      file_name: input.file.name,
      mime_type: input.file.type,
      size_bytes: input.file.size,
      checksum_sha256: checksum,
    },
  });
  if (presignError || !presign?.ok || !presign.data)
    throw presignError ?? new Error(presign?.error?.code ?? 'CALL_RECORDING_PRESIGN_FAILED');
  const uploaded = await fetch(presign.data.upload_url, {
    method: 'PUT',
    headers: presign.data.required_headers,
    body: input.file,
  });
  if (!uploaded.ok) throw new Error('CALL_RECORDING_TRANSFER_FAILED');
  const { data: finalized, error: finalizeError } = await supabase.functions.invoke<
    EdgeEnvelope<{ object_file_id: string }>
  >('object-upload-finalize', {
    body: { upload_intent_id: presign.data.upload_intent_id },
  });
  if (finalizeError || !finalized?.ok || !finalized.data)
    throw finalizeError ?? new Error(finalized?.error?.code ?? 'CALL_RECORDING_FINALIZE_FAILED');
  const { data: attached, error: attachError } = await supabase.rpc(
    'attach_manual_call_recording',
    {
      target_call_id: input.callId,
      target_object_file_id: finalized.data.object_file_id,
      target_request_id: input.requestId,
    },
  );
  if (attachError) throw attachError;
  return z
    .object({
      recording_id: z.uuid(),
      call_id: z.uuid(),
      object_file_id: z.uuid(),
      status: z.string(),
      replayed: z.boolean(),
    })
    .parse(attached);
}

const callDetailSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  lead_id: nullableUuid,
  customer_id: nullableUuid,
  customer_name: nullableString,
  phone: nullableString,
  branch_name: z.string(),
  team_name: nullableString,
  caller_name: z.string(),
  provider_name: nullableString,
  provider_call_id: nullableString,
  direction: z.string(),
  call_source: z.string(),
  started_at: z.string(),
  ended_at: nullableString,
  duration_seconds: z.coerce.number().int().nonnegative().nullable(),
  outcome: nullableString,
  status: z.string(),
  notes: nullableString,
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
  finalized_at: nullableString,
  can_finalize: z.boolean(),
  recordings: z.array(
    z.object({
      id: z.uuid(),
      source: z.string(),
      status: z.string(),
      object_file_id: nullableUuid,
      mime_type: nullableString,
      size_bytes: z.coerce.number().nonnegative().nullable(),
      created_at: z.string(),
    }),
  ),
  transcript: z
    .object({
      id: z.uuid(),
      status: z.string(),
      language: nullableString,
      text: nullableString,
      speaker_turns: z.array(callSpeakerTurnSchema).default([]),
      speaker_separation_method: nullableString.default(null),
      truncated: z.boolean(),
      created_at: z.string(),
    })
    .nullable(),
  ai_summary: z.object({ id: z.uuid(), summary: z.string(), created_at: z.string() }).nullable(),
});

export type CallDetail = z.infer<typeof callDetailSchema>;

const callSpeakerTranscriptSchema = z.object({
  speaker_turns: z.array(callSpeakerTurnSchema),
  speaker_separation_method: nullableString,
  truncated: z.boolean(),
});

export async function fetchCallDetail(callId: string, signal?: AbortSignal): Promise<CallDetail> {
  const supabase = createClient();
  const detailRequest = supabase.rpc('get_call_detail', {
    target_call_id: callId,
  });
  const speakerRequest = supabase.rpc('get_call_speaker_transcript', {
    target_call_id: callId,
  });
  const [detailResponse, speakerResponse] = await Promise.all([
    signal ? detailRequest.abortSignal(signal) : detailRequest,
    signal ? speakerRequest.abortSignal(signal) : speakerRequest,
  ]);
  if (detailResponse.error) throw detailResponse.error;
  if (speakerResponse.error) throw speakerResponse.error;
  const detail = callDetailSchema.parse(detailResponse.data);
  const speakerTranscript = callSpeakerTranscriptSchema.parse(speakerResponse.data);
  if (!detail.transcript) return detail;
  return {
    ...detail,
    transcript: {
      ...detail.transcript,
      speaker_turns: speakerTranscript.speaker_turns,
      speaker_separation_method: speakerTranscript.speaker_separation_method,
      truncated: detail.transcript.truncated || speakerTranscript.truncated,
    },
  };
}

type DownloadEnvelope = {
  ok: boolean;
  data: {
    download_url: string;
    expires_at: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
  } | null;
  error: { code: string; message: string } | null;
};

export async function createCallRecordingDownload(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke<DownloadEnvelope>(
    'presign-download',
    { body: { object_file_id: objectFileId } },
  );
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'CALL_RECORDING_DOWNLOAD_FAILED');
  return data.data;
}
