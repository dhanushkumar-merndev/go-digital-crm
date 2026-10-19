import * as Crypto from 'expo-crypto';
import { supabase } from '@/lib/supabase';

// Transcription, summary and field suggestions for a call. Processing runs on
// the server worker; the app asks for it (or the user's auto setting does) and
// polls the state. Suggestions are only written after the user reviews them.

export type CallAiJobStatus = 'QUEUED' | 'PROCESSING' | 'RETRY' | 'COMPLETED' | 'FAILED';

export type CallAiState = {
  call_id: string;
  lead_id: string | null;
  phone: string | null;
  call_source: string;
  recording_ready: boolean;
  job: {
    id: string;
    status: CallAiJobStatus;
    safe_error_code: string | null;
    updated_at: string;
    completed_at: string | null;
  } | null;
  transcript_status: string | null;
  has_summary: boolean;
  extraction_run_id: string | null;
  can_request: boolean;
  can_regenerate: boolean;
  can_create_lead: boolean;
  auto_process: boolean;
};

export type CallAiFieldKey =
  | 'customer_name'
  | 'phone'
  | 'email'
  | 'interested_model'
  | 'lifecycle_status'
  | 'temperature'
  | 'next_followup_at'
  | 'lost_reason';

export type CallAiField = {
  field_key: CallAiFieldKey;
  suggested_value: unknown;
  current_value: unknown;
  decision: 'PENDING' | 'APPLIED' | 'REJECTED' | 'EDITED';
  applied_value: unknown;
};

export type CallAiReview = {
  call: {
    id: string;
    lead_id: string | null;
    customer_name: string;
    phone: string;
    interested_model: string | null;
    started_at: string;
    duration_seconds: number | null;
  };
  summary: string | null;
  extraction: { id: string; status: string; created_at: string; fields: CallAiField[] } | null;
};

export type CallAiDecision = {
  field_key: CallAiFieldKey;
  decision: 'APPLIED' | 'REJECTED' | 'EDITED';
  value?: unknown;
};

export type CallAiPreferences = { auto_process: boolean; auto_sync: boolean };

export const callAiFieldLabels: Record<CallAiFieldKey, string> = {
  customer_name: 'Customer name',
  phone: 'Phone',
  email: 'Email',
  interested_model: 'Interested model',
  lifecycle_status: 'Lead stage',
  temperature: 'Temperature',
  next_followup_at: 'Next follow-up',
  lost_reason: 'Lost reason',
};

export function isCallAiRunning(state: CallAiState | null) {
  return Boolean(state?.job && ['QUEUED', 'PROCESSING', 'RETRY'].includes(state.job.status));
}

export async function fetchCallAiState(callId: string) {
  const { data, error } = await supabase.rpc('get_call_ai_processing_state', {
    target_call_id: callId,
  });
  if (error || !data) throw error ?? new Error('CALL_AI_STATE_UNAVAILABLE');
  return data as CallAiState;
}

export async function requestCallAiProcessing(callId: string, regenerate = false) {
  const { data, error } = await supabase.rpc('request_call_ai_processing', {
    target_call_id: callId,
    target_regenerate: regenerate,
  });
  if (error) throw error;
  return data as { job_id: string; status: CallAiJobStatus; queued: boolean };
}

export async function fetchCallAiReview(callId: string) {
  const { data, error } = await supabase.rpc('get_ai_call_field_review', {
    target_call_id: callId,
  });
  if (error || !data) throw error ?? new Error('CALL_AI_REVIEW_UNAVAILABLE');
  return data as CallAiReview;
}

export async function reviewCallAiFields(extractionRunId: string, decisions: CallAiDecision[]) {
  const { data, error } = await supabase.rpc('review_ai_call_fields', {
    target_extraction_run_id: extractionRunId,
    target_decisions: decisions,
    target_request_id: Crypto.randomUUID(),
  });
  if (error) throw error;
  return data as { lead_id: string; accepted_fields: string[] };
}

export async function createLeadFromCallReview(input: {
  callId: string;
  customerName: string;
  email: string | null;
  interestedModel: string | null;
  decisions: CallAiDecision[];
  requestId: string;
}) {
  const { data, error } = await supabase.rpc('create_lead_from_call_review', {
    target_call_id: input.callId,
    target_customer_name: input.customerName,
    target_email: input.email,
    target_interested_model: input.interestedModel,
    target_decisions: input.decisions,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return data as { lead_id: string; customer_id: string | null; accepted_fields: string[] };
}

export async function fetchCallAiPreferences() {
  const { data, error } = await supabase.rpc('get_my_call_ai_preferences');
  if (error || !data) throw error ?? new Error('CALL_AI_PREFERENCES_UNAVAILABLE');
  return data as CallAiPreferences;
}

export async function saveCallAiPreferences(input: Partial<CallAiPreferences>) {
  const { data, error } = await supabase.rpc('set_my_call_ai_preferences', {
    target_auto_process: input.auto_process ?? null,
    target_auto_sync: input.auto_sync ?? null,
  });
  if (error || !data) throw error ?? new Error('CALL_AI_PREFERENCES_UNAVAILABLE');
  return data as CallAiPreferences;
}

// Values the worker suggests are JSON; show them as plain text.
export function displayAiValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime()))
        return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    }
    return value;
  }
  return String(value);
}

const friendlyErrors: Record<string, string> = {
  AI_ALREADY_DONE: 'This call already has a transcript and summary.',
  CALL_RECORDING_NOT_READY: 'Upload the recording first.',
  CALL_AI_NOT_SUPPORTED: 'AI is not available for this call.',
  PERMISSION_DENIED: 'You do not have permission for this call.',
  CALL_ALREADY_HAS_LEAD: 'This call is already linked to a lead.',
  INVALID_LEAD_FROM_CALL_REQUEST: 'Check the name and email.',
  LEAD_UPDATE_PERMISSION_REQUIRED: 'You cannot update this lead.',
  GROQ_API_KEY_MISSING: 'AI transcription is not configured for this dealership yet.',
  INSUFFICIENT_CREDITS: 'The dealership has run out of AI credits.',
};

export function callAiErrorMessage(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? '');
  const code = Object.keys(friendlyErrors).find((key) => message.includes(key));
  return code ? friendlyErrors[code] : 'Something went wrong. Try again.';
}
