import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { ManualDashboardRefreshLimitError } from '@/lib/query/cached-dashboard-api';

const metricSchema = z.object({
  value: z.coerce.number().nonnegative(),
  change: z.coerce.number(),
  comparison: z.enum(['YESTERDAY', 'LAST_MONTH']),
});

const scheduleItemSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['FOLLOW_UP', 'SHOWROOM_VISIT', 'TEST_DRIVE', 'DELIVERY']),
  scheduled_at: z.string(),
  customer_name: z.string(),
  detail: z.string().nullable(),
  status: z.string(),
});

const attentionItemSchema = z.object({
  key: z.enum([
    'HOT_NOT_CALLED',
    'OVERDUE_FOLLOWUPS',
    'TEST_DRIVE_QUOTATION',
    'QUOTATION_NO_BOOKING',
    'WAITING_FOR_STOCK',
  ]),
  value: z.coerce.number().int().nonnegative(),
});

const pipelineItemSchema = z.object({
  name: z.string(),
  value: z.coerce.number().int().nonnegative(),
});

const modelSchema = z.object({
  model_id: z.uuid().nullable(),
  name: z.string(),
  bookings: z.coerce.number().int().nonnegative(),
  change: z.coerce.number(),
  available_stock: z.coerce.number().int().nonnegative(),
  image_object_file_id: z.uuid().nullable(),
  image_url: z.string().url().nullable().optional(),
});

const leadSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  customer_name: z.string(),
  phone: z.string(),
  interested_model: z.string().nullable(),
  next_followup_at: z.string().nullable(),
  source: z.string(),
  lifecycle_status: z.string(),
  temperature: z.enum(['COLD', 'WARM', 'HOT']).nullable(),
});

const alertSchema = z.object({
  key: z.enum([
    'FOLLOWUPS_DUE',
    'TEST_DRIVES_SCHEDULED',
    'QUOTATIONS_AWAITING',
    'INSURANCE_DOCUMENTS',
    'RTO_PENDING',
  ]),
  value: z.coerce.number().int().nonnegative(),
});

const dashboardSchema = z.object({
  organization_id: z.uuid(),
  generated_at: z.string(),
  local_date: z.string(),
  timezone: z.string(),
  metrics: z.object({
    leads_assigned_today: metricSchema,
    hot_leads: metricSchema,
    followups_today: metricSchema,
    calls_pending: metricSchema,
    test_drives_today: metricSchema,
    quotations_pending: metricSchema,
    bookings_month: metricSchema,
    target_achievement: metricSchema,
  }),
  attention: z.array(attentionItemSchema),
  schedule: z.array(scheduleItemSchema),
  pipeline: z.array(pipelineItemSchema),
  top_models: z.array(modelSchema),
  recent_leads: z.array(leadSchema),
  alerts: z.array(alertSchema),
});

const refreshBudgetSchema = z.object({
  enforced: z.boolean(),
  remaining: z.coerce.number().int().nonnegative().nullable(),
  retry_after_ms: z.coerce.number().int().nonnegative().nullable(),
});

const envelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    result: dashboardSchema,
    manual_refresh: refreshBudgetSchema.nullable(),
  }),
  error: z.null(),
  request_id: z.uuid(),
});

export type SalesConsultantDashboardResult = z.infer<typeof dashboardSchema> & {
  refresh_budget?: z.infer<typeof refreshBudgetSchema> | null;
};

export const salesConsultantDashboardKey = ['sales-consultant-dashboard'] as const;

async function edgeErrorCode(error: unknown) {
  const response = (error as { context?: unknown } | null)?.context;
  if (!(response instanceof Response)) return null;
  try {
    const payload = (await response.clone().json()) as { error?: { code?: string } };
    return payload.error?.code ?? null;
  } catch {
    return null;
  }
}

export async function fetchSalesConsultantDashboard(
  signal?: AbortSignal,
  options: { manualRefresh?: boolean } = {},
) {
  const { data, error } = await createClient().functions.invoke('sales-consultant-dashboard', {
    body: { manual_refresh: Boolean(options.manualRefresh) },
    signal,
  });
  if (error) {
    if ((await edgeErrorCode(error)) === 'MANUAL_REFRESH_LIMITED')
      throw new ManualDashboardRefreshLimitError();
    throw error;
  }
  const envelope = envelopeSchema.parse(data);
  return {
    ...envelope.data.result,
    refresh_budget: envelope.data.manual_refresh,
  } satisfies SalesConsultantDashboardResult;
}
