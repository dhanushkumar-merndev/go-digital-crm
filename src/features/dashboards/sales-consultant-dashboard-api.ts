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
  kind: z.enum([
    'FOLLOW_UP',
    'SHOWROOM_VISIT',
    'APPOINTMENT_VIDEO_CALL',
    'APPOINTMENT_TEST_DRIVE',
    'APPOINTMENT_CONSULTANT_CALL',
    'TEST_DRIVE',
    'DELIVERY',
  ]),
  scheduled_at: z.string(),
  lead_id: z.uuid().nullable().optional(),
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
  temperature: z.enum(['COLD', 'WARM', 'HOT', 'DORMANT']).nullable(),
});

const alertSchema = z.object({
  key: z.enum([
    'TASKS_DUE',
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

const cacheDiagnosticSchema = z.object({
  status: z.enum(['HIT', 'MISS', 'COALESCED', 'BYPASS', 'FALLBACK']),
  resource: z.literal('sales-consultant-dashboard'),
  version: z.coerce.number().int().positive(),
  age_seconds: z.coerce.number().int().nonnegative().nullable(),
  // nullish, not nullable: an edge function deployed before this field
  // existed omits it entirely, and a client that hard-fails on that turns
  // a routine deploy skew into a blank dashboard.
  synced_at: z.string().nullish(),
});

const envelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    result: dashboardSchema,
    cache: cacheDiagnosticSchema,
    manual_refresh: refreshBudgetSchema.nullable(),
  }),
  error: z.null(),
  request_id: z.uuid(),
});

const aiSummaryEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    summary: z.string().min(1).max(2_000),
    generated_at: z.string(),
    provider: z.enum(['RULE_BASED', 'AI']),
    cache: cacheDiagnosticSchema.extend({ resource: z.literal('sales-consultant-ai-summary') }),
  }),
  error: z.null(),
  request_id: z.uuid(),
});

export type SalesConsultantDashboardResult = z.infer<typeof dashboardSchema> & {
  cache: z.infer<typeof cacheDiagnosticSchema>;
  refresh_budget?:
    | (z.infer<typeof refreshBudgetSchema> & {
        /**
         * `retry_after_ms` is a duration, and turning it into a wall-clock time
         * needs a clock read. Doing that here, once, where the response is
         * received, keeps it out of render — a component that read the clock
         * while rendering would show a countdown that silently drifts with
         * every unrelated re-render.
         */
        retry_at: string | null;
      })
    | null;
};

export const salesConsultantDashboardKey = ['sales-consultant-dashboard'] as const;

async function edgeErrorDetails(error: unknown) {
  const response = (error as { context?: unknown } | null)?.context;
  if (!(response instanceof Response)) return { code: null, retryAfterMs: null };
  try {
    const payload = (await response.clone().json()) as {
      error?: { code?: string; details?: { retry_after_ms?: unknown } };
    };
    const retryAfterMs = Number(payload.error?.details?.retry_after_ms);
    return {
      code: payload.error?.code ?? null,
      retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null,
    };
  } catch {
    return { code: null, retryAfterMs: null };
  }
}

export async function fetchSalesConsultantDashboard(
  signal?: AbortSignal,
  options: { manualRefresh?: boolean } = {},
) {
  const { data, error } = await createClient().functions.invoke('sales-consultant-dashboard', {
    body: { manual_refresh: Boolean(options.manualRefresh), response_version: 2 },
    signal,
  });
  if (error) {
    const details = await edgeErrorDetails(error);
    if (details.code === 'MANUAL_REFRESH_LIMITED')
      throw new ManualDashboardRefreshLimitError(details.retryAfterMs);
    throw error;
  }
  const envelope = envelopeSchema.parse(data);
  const manualRefresh = envelope.data.manual_refresh;
  return {
    ...envelope.data.result,
    cache: envelope.data.cache,
    refresh_budget: manualRefresh
      ? {
          ...manualRefresh,
          retry_at: manualRefresh.retry_after_ms
            ? new Date(Date.now() + manualRefresh.retry_after_ms).toISOString()
            : null,
        }
      : manualRefresh,
  } satisfies SalesConsultantDashboardResult;
}

export async function generateSalesConsultantAiSummary(
  forceRefresh: boolean,
  signal?: AbortSignal,
) {
  const { data, error } = await createClient().functions.invoke('sales-consultant-ai-summary', {
    body: { force_refresh: forceRefresh },
    signal,
  });
  if (error) throw error;
  return aiSummaryEnvelopeSchema.parse(data).data;
}
