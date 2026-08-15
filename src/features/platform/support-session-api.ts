import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { SupportWorkspaceQuery } from './support-session-query';

const supportRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  organization_name: z.string().min(1),
  requested_by: z.uuid(),
  requester_name: z.string().min(1),
  purpose: z.string(),
  permissions: z.array(z.string()).max(20),
  duration_minutes: z.coerce.number().int().min(5).max(60),
  request_status: z.string(),
  approved_by: z.uuid().nullable(),
  approver_name: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  session_id: z.uuid().nullable(),
  starts_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  termination_reason: z.string().nullable(),
  status: z.enum(['PENDING', 'ACTIVE', 'APPROVED', 'REJECTED', 'ENDED', 'EXPIRED']),
  can_end: z.boolean(),
});

const supportWorkspaceSchema = z.object({
  records: z.array(supportRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    pending: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
    expiring_soon: z.coerce.number().int().nonnegative(),
    sessions_this_month: z.coerce.number().int().nonnegative(),
  }),
  viewer: z.object({
    mode: z.enum(['PLATFORM', 'TENANT']),
    user_id: z.uuid(),
    organization_id: z.uuid().nullable(),
    can_request: z.boolean(),
    can_decide: z.boolean(),
    can_end: z.boolean(),
  }),
});

const supportTenantSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(240) });
const supportCapabilitySchema = z.object({
  permission_key: z.string().min(1).max(100),
  module: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
});

export type SupportSessionRecord = z.infer<typeof supportRecordSchema>;
export type SupportWorkspaceResult = z.infer<typeof supportWorkspaceSchema>;
export type SupportTenantOption = z.infer<typeof supportTenantSchema>;
export type SupportCapability = z.infer<typeof supportCapabilitySchema>;

export async function fetchSupportWorkspace(
  query: SupportWorkspaceQuery,
): Promise<SupportWorkspaceResult> {
  const { data, error } = await createClient().rpc('get_support_workspace_page', {
    search_term: query.search || null,
    status_filter: query.status,
    page_size: query.pageSize,
    page_offset: (query.page - 1) * query.pageSize,
    sort_key: query.sort,
  });
  if (error) throw error;
  return supportWorkspaceSchema.parse(data);
}

export async function searchSupportTenants(search: string): Promise<SupportTenantOption[]> {
  const normalized = search.trim().slice(0, 80);
  if (normalized.length < 2) return [];
  const { data, error } = await createClient().rpc('search_support_tenants', {
    search_term: normalized,
    result_limit: 25,
  });
  if (error) throw error;
  return z.array(supportTenantSchema).parse(data ?? []);
}

export async function fetchSupportCapabilities(): Promise<SupportCapability[]> {
  const { data, error } = await createClient().rpc('list_support_capabilities');
  if (error) throw error;
  return z.array(supportCapabilitySchema).parse(data ?? []);
}

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  request_id?: string;
};

async function invokeSupportFunction<T>(name: string, body: Record<string, unknown>) {
  const { data, error } = await createClient().functions.invoke<EdgeEnvelope<T>>(name, { body });
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'SUPPORT_REQUEST_FAILED');
  return data.data;
}

export function createSupportRequest(input: {
  organizationId: string;
  purpose: string;
  permissions: string[];
  durationMinutes: number;
}) {
  return invokeSupportFunction<{ support_request: { id: string } }>('support-session-request', {
    organization_id: input.organizationId,
    purpose: input.purpose.trim(),
    permissions: input.permissions,
    duration_minutes: input.durationMinutes,
  });
}

export function decideSupportRequest(input: {
  requestId: string;
  decision: 'APPROVE' | 'REJECT';
  decisionNote?: string;
}) {
  return invokeSupportFunction<{ decision: { request_id: string; status: string } }>(
    'support-session-accept',
    {
      request_id: input.requestId,
      decision: input.decision,
      decision_note: input.decisionNote?.trim() || undefined,
    },
  );
}

export function terminateSupportSession(input: { sessionId: string; reason: string }) {
  return invokeSupportFunction<{ support_session: { id: string } }>('support-session-end', {
    session_id: input.sessionId,
    reason: input.reason.trim(),
  });
}
