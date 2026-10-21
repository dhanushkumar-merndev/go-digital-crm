import { createMobileLeadFollowup, fetchMobileLeadDetail } from '@/lib/lead-detail';
import { supabase } from '@/lib/supabase';

// Mutations behind the follow-up and task row actions. Same RPCs and optimistic
// `version` contract as the web workspace (src/features/work/workspace-api.ts).

export function newRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export function isVersionConflict(error: unknown) {
  const text =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : '';
  return /VERSION_CONFLICT|PT409/.test(text);
}

export async function completeFollowup(input: { id: string; version: number; note?: string }) {
  const { error } = await supabase.rpc('complete_followup', {
    target_followup_id: input.id,
    expected_version: input.version,
    completion_note: input.note ?? 'Completed from the mobile app.',
    target_request_id: newRequestId(),
    followup_outcome: 'FOLLOW_UP',
  });
  if (error) throw error;
}

export async function rescheduleFollowup(input: {
  id: string;
  version: number;
  dueAt: Date;
  reason?: string;
}) {
  const { error } = await supabase.rpc('update_followup', {
    target_followup_id: input.id,
    expected_version: input.version,
    followup_patch: {
      due_at: input.dueAt.toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    target_request_id: newRequestId(),
  });
  if (error) throw error;
}

export async function completeTask(input: { id: string; version: number }) {
  const { error } = await supabase.rpc('complete_task', {
    target_task_id: input.id,
    expected_version: input.version,
    completion_note: 'Completed from the mobile app.',
    target_request_id: newRequestId(),
  });
  if (error) throw error;
}

export async function rescheduleTask(input: { id: string; version: number; dueAt: Date }) {
  const { error } = await supabase.rpc('update_task', {
    target_task_id: input.id,
    expected_version: input.version,
    task_patch: { due_at: input.dueAt.toISOString() },
    target_request_id: newRequestId(),
  });
  if (error) throw error;
}

// A lead carries one open follow-up: move it when there is one, otherwise
// create it, so "next step" from anywhere never stacks duplicates.
export async function setLeadNextFollowup(input: { leadId: string; reason: string; dueAt: Date }) {
  const { data, error } = await supabase.rpc('get_lead_open_followup', {
    target_lead_id: input.leadId,
  });
  if (error) throw error;
  const open = data as { id?: string; version?: number } | null;
  if (open?.id && typeof open.version === 'number') {
    await rescheduleFollowup({
      id: open.id,
      version: open.version,
      dueAt: input.dueAt,
      reason: input.reason,
    });
    return 'moved' as const;
  }
  const detail = await fetchMobileLeadDetail(input.leadId);
  await createMobileLeadFollowup({
    detail,
    reason: input.reason,
    dueAt: input.dueAt.toISOString(),
    requestId: newRequestId(),
  });
  return 'created' as const;
}

export async function updateAppointment(input: {
  id: string;
  version: number;
  patch: {
    scheduled_at?: string;
    status?: 'CONFIRMED' | 'RESCHEDULED' | 'NO_SHOW';
    attendance_status?: 'ARRIVED' | 'NO_SHOW';
  };
}) {
  const { error } = await supabase.rpc('update_appointment', {
    target_appointment_id: input.id,
    expected_version: input.version,
    appointment_patch: input.patch,
    target_request_id: newRequestId(),
  });
  if (error) throw error;
}
