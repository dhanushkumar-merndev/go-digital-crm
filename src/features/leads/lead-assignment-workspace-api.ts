import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const workspaceSchema = z.object({
  total: z.coerce.number().int().nonnegative(),
  records: z.array(
    z.object({
      id: z.uuid(),
      team_id: z.uuid(),
      team_name: z.string(),
      customer_id: z.uuid().nullable(),
      customer_name: z.string(),
      phone: z.string(),
      source: z.string(),
      interested_model: z.string().nullable(),
      lifecycle_status: z.string(),
      temperature: z.string().nullable(),
      created_at: z.string(),
      assignment_kind: z.enum(['FRESH', 'QUALIFIED']),
      assignment_mode: z.enum(['ROUND_ROBIN', 'MANUAL_ASSIGNMENT']),
    }),
  ),
  consultants: z.array(
    z.object({
      user_id: z.uuid(),
      team_id: z.uuid(),
      full_name: z.string(),
      eligible_for_fresh_leads: z.boolean(),
      eligible_for_qualified_leads: z.boolean(),
      current_leads: z.coerce.number().int().nonnegative(),
      hot_leads: z.coerce.number().int().nonnegative(),
    }),
  ),
  recent_assignments: z.array(
    z.object({
      id: z.uuid(),
      lead_id: z.uuid(),
      customer_name: z.string(),
      assigned_to_name: z.string(),
      assigned_by_name: z.string().nullable(),
      method: z.string(),
      reason: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

export type LeadAssignmentWorkspace = z.infer<typeof workspaceSchema>;
export type LeadAssignmentAudience = 'TEAM_MANAGER' | 'SHOWROOM_MANAGER';

export async function fetchLeadAssignmentWorkspace(
  input: { search: string; page: number; pageSize: 25 | 50 | 100 },
  audience: LeadAssignmentAudience,
  signal?: AbortSignal,
): Promise<LeadAssignmentWorkspace> {
  const request = createClient().rpc(
    audience === 'SHOWROOM_MANAGER'
      ? 'get_showroom_lead_assignment_workspace'
      : 'get_team_lead_assignment_workspace',
    {
      target_search: input.search.trim().slice(0, 160),
      target_page: input.page,
      target_page_size: input.pageSize,
    },
  );
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}
