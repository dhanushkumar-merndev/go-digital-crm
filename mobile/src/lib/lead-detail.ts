import { supabase } from '@/lib/supabase';

export type MobileLeadDetail = {
  lead: {
    id: string;
    branch_id: string;
    branch_name: string;
    team_id: string | null;
    team_name: string | null;
    customer_id: string | null;
    customer_name: string;
    phone: string;
    email: string | null;
    source: string;
    interested_model: string | null;
    lifecycle_status: string;
    temperature: 'COLD' | 'WARM' | 'HOT' | 'DORMANT' | null;
    work_state: 'NEW_TODAY' | 'PENDING' | 'SLA_RISK' | null;
    assigned_user_name: string | null;
    next_followup_at: string | null;
  };
  access: {
    can_followups: boolean;
    can_calls: boolean;
    can_appointments: boolean;
  };
  counts: { calls: number; messages: number; followups: number; appointments: number };
  followups: Array<{
    id: string;
    reason: string;
    priority: string;
    due_at: string;
    status: string;
    assigned_user_name: string | null;
  }>;
  calls: Array<{
    id: string;
    started_at: string;
    duration_seconds: number | null;
    outcome: string | null;
    status: string;
  }>;
  timeline: Array<{
    id: string;
    occurred_at: string;
    kind: string;
    title: string;
    detail: string;
  }>;
  latest_ai_summary: string | null;
};

export async function fetchMobileLeadDetail(leadId: string): Promise<MobileLeadDetail> {
  const { data, error } = await supabase.rpc('get_lead_detail_workspace', {
    target_lead_id: leadId,
  });
  if (error || !data) throw error ?? new Error('LEAD_DETAIL_NOT_FOUND');
  return data as MobileLeadDetail;
}

export async function createMobileLeadFollowup(input: {
  detail: MobileLeadDetail;
  reason: string;
  dueAt: string;
  requestId: string;
}) {
  const { error } = await supabase.rpc('create_followup', {
    target_lead_id: input.detail.lead.id,
    target_customer_id: input.detail.lead.customer_id,
    target_branch_id: input.detail.lead.branch_id,
    target_team_id: input.detail.lead.team_id,
    target_assigned_user_id: null,
    followup_reason: input.reason,
    followup_due_at: input.dueAt,
    followup_priority: 'NORMAL',
    target_request_id: input.requestId,
  });
  if (error) throw error;
}

export async function createMobileTestDriveAppointment(input: {
  detail: MobileLeadDetail;
  scheduledAt: string;
  requestId: string;
}) {
  const { error } = await supabase.rpc('create_appointment', {
    target_lead_id: input.detail.lead.id,
    target_customer_id: input.detail.lead.customer_id,
    target_branch_id: input.detail.lead.branch_id,
    target_team_id: input.detail.lead.team_id,
    target_assigned_user_id: null,
    target_appointment_type: 'Test Drive',
    target_scheduled_at: input.scheduledAt,
    target_notes: null,
    target_request_id: input.requestId,
  });
  if (error) throw error;
}
