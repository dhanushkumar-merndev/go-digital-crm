import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  isSalesEscalationVersionConflict,
  type SalesEscalationQuery,
} from './sales-escalation-query';

const nullableString = z.string().nullable();

export const salesEscalationRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid().nullable(),
  resource_type: z.enum(['customer_care_case', 'lead', 'quotation', 'booking']),
  resource_id: z.uuid(),
  assigned_user_id: z.uuid().nullable(),
  reason: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  status: z.enum(['OPEN', 'RESOLVED']),
  resolved_at: nullableString,
  version: z.coerce.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  reference: z.string(),
  subject: nullableString,
  resource_label: z.string(),
  customer_name: z.string(),
  assigned_user_name: nullableString,
  team_name: nullableString,
});
export type SalesEscalationRecord = z.infer<typeof salesEscalationRecordSchema>;

const workspaceSchema = z.object({
  organization_id: z.uuid(),
  records: z.array(salesEscalationRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    open: z.coerce.number().int().nonnegative(),
    critical: z.coerce.number().int().nonnegative(),
    high: z.coerce.number().int().nonnegative(),
    unassigned: z.coerce.number().int().nonnegative(),
    resolved_today: z.coerce.number().int().nonnegative(),
  }),
});
export type SalesEscalationWorkspaceResult = z.infer<typeof workspaceSchema>;

export type SalesEscalationPermissions = {
  organizationId: string;
  scopeKey: string;
  canResolve: boolean;
};

export async function fetchSalesEscalationPermissions(): Promise<SalesEscalationPermissions> {
  const supabase = createClient();
  const { data: context, error: contextError } = await supabase.rpc('get_access_context');
  if (contextError) throw contextError;
  const access = context as {
    destination?: string;
    organization_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (access?.destination !== 'CRM' || !access.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const [view, resolve] = await Promise.all(
    ['escalation.view', 'escalation.resolve'].map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: access.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  if (view.error) throw view.error;
  if (resolve.error) throw resolve.error;
  if (!view.data) throw new Error('SALES_ESCALATION_VIEW_PERMISSION_REQUIRED');
  return {
    organizationId: access.organization_id,
    scopeKey: `${access.role_key ?? 'unknown'}:${access.data_scope ?? 'unknown'}`,
    canResolve: Boolean(resolve.data),
  };
}

export async function fetchSalesEscalationWorkspace(
  query: SalesEscalationQuery,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_sales_escalation_workspace_page', {
    target_search: query.search,
    target_status: query.status,
    target_severity: query.severity,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

const mutationSchema = z.object({
  id: z.uuid(),
  status: z.literal('RESOLVED'),
  version: z.coerce.number().int().positive(),
  resolution: z.string(),
  replayed: z.boolean(),
});

export async function resolveSalesEscalation(input: {
  escalationId: string;
  expectedVersion: number;
  resolution: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('resolve_sales_escalation', {
    target_escalation_id: input.escalationId,
    expected_version: input.expectedVersion,
    target_resolution: input.resolution,
    target_request_id: input.requestId,
  });
  if (error) {
    if (isSalesEscalationVersionConflict(error))
      throw new Error('SALES_ESCALATION_VERSION_CONFLICT');
    throw error;
  }
  return mutationSchema.parse(data);
}
