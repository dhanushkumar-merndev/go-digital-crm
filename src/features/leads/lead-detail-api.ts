import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

const leadDetailSchema = z.object({
  lead: z.object({
    id: z.uuid(),
    organization_id: z.uuid(),
    branch_id: z.uuid(),
    branch_name: z.string(),
    team_id: nullableUuid,
    team_name: nullableString,
    customer_id: nullableUuid,
    customer_name: z.string(),
    phone: z.string(),
    email: nullableString,
    source: z.string(),
    source_detail: nullableString,
    campaign: nullableString,
    interested_model: nullableString,
    lifecycle_status: z.string(),
    temperature: z.enum(['COLD', 'WARM', 'HOT']).nullable(),
    work_state: z.enum(['NEW_TODAY', 'PENDING', 'SLA_RISK']).nullable(),
    assigned_user_id: nullableUuid,
    assigned_user_name: nullableString,
    first_contacted_at: nullableString,
    next_followup_at: nullableString,
    sla_due_at: nullableString,
    lost_reason: nullableString,
    created_at: z.string(),
    updated_at: z.string(),
  }),
  access: z.object({
    can_update: z.boolean(),
    can_followups: z.boolean(),
    can_calls: z.boolean(),
    can_messages: z.boolean(),
    can_appointments: z.boolean(),
  }),
  counts: z.object({
    calls: z.coerce.number().int().nonnegative(),
    messages: z.coerce.number().int().nonnegative(),
    followups: z.coerce.number().int().nonnegative(),
    appointments: z.coerce.number().int().nonnegative(),
  }),
  followups: z.array(
    z.object({
      id: z.uuid(),
      reason: z.string(),
      priority: z.string(),
      due_at: z.string(),
      status: z.string(),
      assigned_user_name: nullableString,
    }),
  ),
  calls: z.array(
    z.object({
      id: z.uuid(),
      direction: z.string(),
      call_source: z.string(),
      started_at: z.string(),
      duration_seconds: z.coerce.number().int().nonnegative().nullable(),
      outcome: nullableString,
      status: z.string(),
      assigned_user_name: nullableString,
    }),
  ),
  timeline: z.array(
    z.object({
      id: z.uuid(),
      occurred_at: z.string(),
      kind: z.enum(['stage', 'temperature', 'assignment', 'activity']),
      title: z.string(),
      detail: z.string(),
    }),
  ),
  latest_ai_summary: nullableString,
});

export type LeadDetail = z.infer<typeof leadDetailSchema>;

export function isLeadUuid(value: string) {
  return z.uuid().safeParse(value).success;
}

export async function fetchLeadDetail(leadId: string, signal?: AbortSignal): Promise<LeadDetail> {
  const request = createClient().rpc('get_lead_detail_workspace', { target_lead_id: leadId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return leadDetailSchema.parse(data);
}
