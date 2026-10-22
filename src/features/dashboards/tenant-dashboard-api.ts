import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { cacheDiagnosticSchema, fetchCachedDashboard } from '@/lib/query/cached-dashboard-api';

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
  temperature: z.enum(['COLD', 'WARM', 'HOT', 'DORMANT']).nullable(),
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

/**
 * The cached, browser-persisted half of the dashboard: counts and series only.
 * `cache` is null when the summary came from the direct RPC fallback.
 */
export const tenantDashboardSummaryResultSchema = tenantDashboardSummarySchema.extend({
  cache: cacheDiagnosticSchema.nullable(),
  refresh_budget: refreshBudgetSchema.nullable(),
});
export type TenantDashboardSummaryResult = z.infer<typeof tenantDashboardSummaryResultSchema>;

/** Bounded live rows with customer names and phones: memory only, never Redis or IndexedDB. */
export type TenantDashboardLiveItems = z.infer<typeof tenantDashboardLiveItemsSchema>;

export type TenantDashboardResult = TenantDashboardSummaryResult & TenantDashboardLiveItems;

export type TenantDashboardLeadPreview = z.infer<typeof leadPreviewSchema>;

/** Prefix for every tenant dashboard query; Realtime invalidates by it. */
export const tenantDashboardKey = ['tenant-performance-dashboard'] as const;

async function readTenantDashboardSummary(signal?: AbortSignal) {
  const request = createClient().rpc('get_tenant_dashboard_summary', {
    target_days: 14,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return { ...tenantDashboardSummarySchema.parse(data), cache: null, refresh_budget: null };
}

export async function fetchTenantDashboardSummary(
  signal?: AbortSignal,
  options: { manualRefresh?: boolean; direct?: boolean } = {},
): Promise<TenantDashboardSummaryResult> {
  // An own-records summary is about 170 ms in PostgreSQL, while the Redis hop
  // through the Edge function costs 380–840 ms even on a hit and shares
  // nothing across users. A manual refresh still goes through Edge, which is
  // where its quota is enforced.
  if (options.direct && !options.manualRefresh) return readTenantDashboardSummary(signal);
  try {
    const { result, cache, manualRefresh } = await fetchCachedDashboard({
      resource: 'tenant-dashboard',
      schema: tenantDashboardSummarySchema,
      manualRefresh: options.manualRefresh,
      signal,
    });
    return { ...result, cache, refresh_budget: manualRefresh };
  } catch (error) {
    // A manual refresh is answered by the Edge path or not at all, so its
    // quota stays enforced. An ordinary read falls back to PostgreSQL rather
    // than leave the dashboard blank while the Edge function is unreachable.
    if (options.manualRefresh || signal?.aborted) throw error;
    return readTenantDashboardSummary(signal);
  }
}

export async function fetchTenantDashboardLiveItems(signal?: AbortSignal) {
  const request = createClient().rpc('get_tenant_dashboard_live_items', {
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return tenantDashboardLiveItemsSchema.parse(data);
}
