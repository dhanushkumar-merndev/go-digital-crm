import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { fetchCachedDashboard } from '@/lib/query/cached-dashboard-api';

const capabilitySchema = z.object({
  leads: z.boolean(),
  calls: z.boolean(),
  work: z.boolean(),
  bookings: z.boolean(),
  inventory: z.boolean(),
  test_drives: z.boolean(),
  operations: z.boolean(),
});

const kpiSchema = z.object({
  open_leads: z.coerce.number().int().nonnegative(),
  new_leads_today: z.coerce.number().int().nonnegative(),
  followups_due_today: z.coerce.number().int().nonnegative(),
  followups_overdue: z.coerce.number().int().nonnegative(),
  appointments_today: z.coerce.number().int().nonnegative(),
  calls_today: z.coerce.number().int().nonnegative(),
  bookings_month: z.coerce.number().int().nonnegative(),
  booking_value_month: z.coerce.number().nonnegative(),
  test_drives_today: z.coerce.number().int().nonnegative(),
  available_stock: z.coerce.number().int().nonnegative(),
  open_cases: z.coerce.number().int().nonnegative(),
  overdue_cases: z.coerce.number().int().nonnegative(),
  cases_due_today: z.coerce.number().int().nonnegative(),
  cases_completed_month: z.coerce.number().int().nonnegative(),
});

const chartDatumSchema = z.object({
  name: z.string(),
  value: z.coerce.number().nonnegative(),
  secondary: z.coerce.number().nonnegative().optional(),
});

const leadPreviewSchema = z.object({
  id: z.uuid(),
  customer_name: z.string(),
  phone: z.string(),
  source: z.string(),
  interested_model: z.string().nullable(),
  lifecycle_status: z.string(),
  temperature: z.enum(['COLD', 'WARM', 'HOT']).nullable(),
  work_state: z.enum(['NEW_TODAY', 'PENDING', 'SLA_RISK']).nullable(),
  next_followup_at: z.string().nullable(),
  updated_at: z.string(),
});

const tenantDashboardSummarySchema = z.object({
  organization_id: z.uuid(),
  generated_at: z.string(),
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  capabilities: capabilitySchema,
  kpis: kpiSchema,
  activity: z.array(chartDatumSchema),
  pipeline: z.array(chartDatumSchema),
  activity_primary: z.string(),
  activity_secondary: z.string(),
});

const tenantDashboardLiveItemsSchema = z.object({
  lead_preview: z.array(leadPreviewSchema),
  attention: z.array(
    z.object({
      id: z.uuid(),
      kind: z.literal('FOLLOWUP'),
      title: z.string(),
      detail: z.string(),
      severity: z.enum(['HIGH', 'MEDIUM']),
      sort_at: z.string(),
      lead_id: z.uuid().nullable(),
    }),
  ),
});

const refreshBudgetSchema = z.object({
  enforced: z.boolean(),
  remaining: z.coerce.number().int().nonnegative().nullable(),
  retry_after_ms: z.coerce.number().int().nonnegative().nullable(),
});

export const tenantDashboardSchema = tenantDashboardSummarySchema.extend({
  lead_preview: z.array(leadPreviewSchema),
  attention: tenantDashboardLiveItemsSchema.shape.attention,
  refresh_budget: refreshBudgetSchema.nullable().optional(),
});

export type TenantDashboardResult = z.infer<typeof tenantDashboardSchema>;

export type TenantDashboardLeadPreview = z.infer<typeof leadPreviewSchema>;

export async function fetchTenantDashboard(
  signal?: AbortSignal,
  options: { manualRefresh?: boolean } = {},
) {
  const [summary, liveItems] = await Promise.all([
    fetchCachedDashboard({
      resource: 'tenant-dashboard',
      schema: tenantDashboardSummarySchema,
      manualRefresh: options.manualRefresh,
    }),
    (async () => {
      const request = createClient().rpc('get_tenant_dashboard_live_items', {
        target_timezone: 'Asia/Kolkata',
      });
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return tenantDashboardLiveItemsSchema.parse(data);
    })(),
  ]);
  return tenantDashboardSchema.parse({
    ...summary.result,
    ...liveItems,
    refresh_budget: summary.manualRefresh,
  });
}
