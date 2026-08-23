import { supabase } from '@/lib/supabase';

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
  const { data, error } = await supabase.rpc('get_call_detail', { target_call_id: callId });
  if (error || !data) throw error ?? new Error('CALL_DETAIL_NOT_FOUND');
  return data as MobileCallDetail;
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
