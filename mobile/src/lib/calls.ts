import { supabase } from '@/lib/supabase';
import * as Crypto from 'expo-crypto';
import { File, UploadType } from 'expo-file-system';

export type MobileCallRecord = {
  id: string;
  customer_name: string | null;
  phone: string | null;
  direction: string;
  started_at: string;
  duration_seconds: number | null;
  outcome: string | null;
  status: string;
  recording_available: boolean;
  ai_summary_available: boolean;
};

export type MobileSpeakerTurn = {
  speaker: 'AGENT' | 'CUSTOMER' | 'UNKNOWN';
  text: string;
};

export type MobileCallDetail = MobileCallRecord & {
  organization_id: string;
  branch_id: string;
  team_id: string | null;
  lead_id: string | null;
  customer_id: string | null;
  branch_name: string;
  team_name: string | null;
  caller_name: string;
  provider_name: string | null;
  call_source: string;
  ended_at: string | null;
  notes: string | null;
  recordings: Array<{
    id: string;
    source: string;
    status: string;
    object_file_id: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    created_at: string;
  }>;
  transcript: {
    id: string;
    status: string;
    language: string | null;
    text: string | null;
    speaker_turns: MobileSpeakerTurn[];
    speaker_separation_method: string | null;
    truncated: boolean;
    created_at: string;
  } | null;
  ai_summary: { id: string; summary: string; created_at: string } | null;
};

export type MobileCallPage = { records: MobileCallRecord[]; total: number };

export async function fetchMobileCalls(page: number): Promise<MobileCallPage> {
  const { data, error } = await supabase.rpc('get_call_workspace_page', {
    target_search: '',
    target_page: page,
    target_page_size: 25,
    target_status: 'ALL',
    target_outcome: 'ALL',
    target_source: 'ALL',
    target_sort: 'started:desc',
    target_view: 'history',
  });
  if (error) throw error;
  const result = data as { records?: MobileCallRecord[]; total?: number } | null;
  return { records: result?.records ?? [], total: result?.total ?? 0 };
}

export async function fetchMobileCallDetail(callId: string): Promise<MobileCallDetail> {
  const [detailResponse, speakerResponse] = await Promise.all([
    supabase.rpc('get_call_detail', { target_call_id: callId }),
    supabase.rpc('get_call_speaker_transcript', { target_call_id: callId }),
  ]);
  if (detailResponse.error || !detailResponse.data)
    throw detailResponse.error ?? new Error('CALL_DETAIL_NOT_FOUND');
  if (speakerResponse.error) throw speakerResponse.error;
  const detail = detailResponse.data as MobileCallDetail;
  if (!detail.transcript) return detail;
  const projection = parseMobileSpeakerTranscript(speakerResponse.data);
  return {
    ...detail,
    transcript: {
      ...detail.transcript,
      speaker_turns: projection.speakerTurns,
      speaker_separation_method: projection.separationMethod,
      truncated: detail.transcript.truncated || projection.truncated,
    },
  };
}

function parseMobileSpeakerTranscript(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CALL_SPEAKER_TRANSCRIPT_INVALID');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.speaker_turns) || typeof record.truncated !== 'boolean')
    throw new Error('CALL_SPEAKER_TRANSCRIPT_INVALID');
  if (
    record.speaker_separation_method !== null &&
    typeof record.speaker_separation_method !== 'string'
  )
    throw new Error('CALL_SPEAKER_TRANSCRIPT_INVALID');
  const speakerTurns = record.speaker_turns.map((turn): MobileSpeakerTurn => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn))
      throw new Error('CALL_SPEAKER_TRANSCRIPT_INVALID');
    const speakerTurn = turn as Record<string, unknown>;
    if (
      !['AGENT', 'CUSTOMER', 'UNKNOWN'].includes(String(speakerTurn.speaker)) ||
      typeof speakerTurn.text !== 'string'
    )
      throw new Error('CALL_SPEAKER_TRANSCRIPT_INVALID');
    return {
      speaker: speakerTurn.speaker as MobileSpeakerTurn['speaker'],
      text: speakerTurn.text,
    };
  });
  return {
    speakerTurns,
    separationMethod: record.speaker_separation_method as string | null,
    truncated: record.truncated,
  };
}

export async function createMobileCallFollowup(input: {
  call: MobileCallDetail;
  reason: string;
  dueAt: string;
  requestId: string;
}) {
  const { error } = await supabase.rpc('create_followup', {
    target_lead_id: input.call.lead_id,
    target_customer_id: input.call.customer_id,
    target_branch_id: input.call.branch_id,
    target_team_id: input.call.team_id,
    target_assigned_user_id: null,
    followup_reason: input.reason,
    followup_due_at: input.dueAt,
    followup_priority: 'NORMAL',
    target_request_id: input.requestId,
  });
  if (error) throw error;
}

export async function getMobileRecordingDownload(objectFileId: string) {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    data: { download_url: string } | null;
  }>('presign-download', { body: { object_file_id: objectFileId } });
  if (error || !data?.ok || !data.data?.download_url)
    throw error ?? new Error('RECORDING_DOWNLOAD_UNAVAILABLE');
  return data.data.download_url;
}

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error?: { code: string; message: string } | null;
};

const maximumCallRecordingBytes = 100 * 1024 * 1024;
const allowedCallRecordingMimeTypes = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
]);
const callRecordingMimeAliases: Record<string, string> = {
  'audio/m4a': 'audio/mp4',
  'audio/mpeg3': 'audio/mpeg',
  'audio/vnd.wave': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-mpeg': 'audio/mpeg',
};
const callRecordingMimeByExtension: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

function bytesToBase64(bytes: Uint8Array) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;
    result += alphabet[(chunk >> 18) & 63];
    result += alphabet[(chunk >> 12) & 63];
    result += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : '=';
    result += index + 2 < bytes.length ? alphabet[chunk & 63] : '=';
  }
  return result;
}

function callRecordingFileName(value: string) {
  const fileName = value
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!fileName || fileName.length > 255) throw new Error('RECORDING_NAME_INVALID');
  return fileName;
}

function callRecordingMimeType(fileName: string, reportedMimeType?: string | null) {
  const reported = reportedMimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const normalized = callRecordingMimeAliases[reported] ?? reported;
  if (allowedCallRecordingMimeTypes.has(normalized)) return normalized;

  // Some Android document providers omit the MIME type or return the generic
  // octet-stream type. Only in that case do we use a known audio extension.
  if (!reported || reported === 'application/octet-stream') {
    const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
    const inferred = callRecordingMimeByExtension[extension];
    if (inferred) return inferred;
  }
  throw new Error('RECORDING_TYPE_NOT_ALLOWED');
}

async function sha256Base64(file: File) {
  const bytes = await file.bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return bytesToBase64(new Uint8Array(digest));
}

export async function uploadMobileCallRecording(input: {
  call: MobileCallDetail;
  asset: { uri: string; name: string; mimeType?: string | null; size?: number | null };
  requestId: string;
}) {
  if (input.call.call_source !== 'PERSONAL_MANUAL') throw new Error('MANUAL_CALL_REQUIRED');
  const fileName = callRecordingFileName(input.asset.name);
  const mimeType = callRecordingMimeType(fileName, input.asset.mimeType);
  const file = new File(input.asset.uri);
  if (!file.exists || !file.size || file.size > maximumCallRecordingBytes)
    throw new Error('RECORDING_SIZE_INVALID');
  const checksum = await sha256Base64(file);
  const presigned = await supabase.functions.invoke<
    EdgeEnvelope<{
      upload_intent_id: string;
      upload_url: string;
      required_headers: Record<string, string>;
    }>
  >('presign-upload', {
    body: {
      organization_id: input.call.organization_id,
      branch_id: input.call.branch_id,
      resource_type: 'call',
      resource_id: input.call.id,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: file.size,
      checksum_sha256: checksum,
    },
  });
  if (presigned.error || !presigned.data?.ok || !presigned.data.data)
    throw presigned.error ?? new Error(presigned.data?.error?.code ?? 'RECORDING_PRESIGN_FAILED');
  const uploaded = await file.upload(presigned.data.data.upload_url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: presigned.data.data.required_headers,
  });
  if (uploaded.status < 200 || uploaded.status >= 300) throw new Error('RECORDING_TRANSFER_FAILED');
  const finalized = await supabase.functions.invoke<EdgeEnvelope<{ object_file_id: string }>>(
    'object-upload-finalize',
    { body: { upload_intent_id: presigned.data.data.upload_intent_id } },
  );
  if (finalized.error || !finalized.data?.ok || !finalized.data.data)
    throw finalized.error ?? new Error(finalized.data?.error?.code ?? 'RECORDING_FINALIZE_FAILED');
  const attached = await supabase.rpc('attach_manual_call_recording', {
    target_call_id: input.call.id,
    target_object_file_id: finalized.data.data.object_file_id,
    target_request_id: input.requestId,
  });
  if (attached.error) throw attached.error;
  return attached.data;
}
