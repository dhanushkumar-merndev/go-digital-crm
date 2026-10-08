import { z } from 'zod';
import { fetchCachedAggregate } from '@/lib/query/cached-dashboard-api';
import { createClient } from '@/lib/supabase/client';

const salesSchema = z.object({
  window_days: z.coerce.number().int().positive(),
  pipeline: z.array(z.object({ stage: z.string(), leads: z.coerce.number().int().nonnegative() })),
  sources: z.array(z.object({ source: z.string(), leads: z.coerce.number().int().nonnegative() })),
  consultants: z.array(
    z.object({
      name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      won: z.coerce.number().int().nonnegative(),
    }),
  ),
  totals: z.object({
    leads: z.coerce.number().int().nonnegative(),
    lost: z.coerce.number().int().nonnegative(),
    transferred: z.coerce.number().int().nonnegative(),
  }),
});

const showroomSchema = z.object({
  window_days: z.coerce.number().int().positive(),
  branches: z.array(
    z.object({
      branch_id: z.uuid(),
      branch: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      transferred: z.coerce.number().int().nonnegative(),
      test_drives: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
    }),
  ),
});

const operationsSchema = z.object({
  closed_statuses: z.array(z.string()),
  departments: z.array(
    z.object({
      department: z.string(),
      total: z.coerce.number().int().nonnegative(),
      open: z.coerce.number().int().nonnegative(),
      statuses: z
        .array(z.object({ status: z.string(), count: z.coerce.number().int().nonnegative() }))
        .nullable()
        .transform((value) => value ?? []),
    }),
  ),
});

const count = z.coerce.number().int().nonnegative();
const amount = z.coerce.number().nonnegative();
const minutes = z.coerce.number().int().nonnegative().nullable();
const namedLeads = z.array(z.object({ name: z.string(), leads: count }));
const namedBookings = z.array(z.object({ name: z.string(), bookings: count }));

const analyticsTotalsShape = {
  leads: count,
  contacted: count,
  moved_to_sales: count,
  lost: count,
  test_drives: count,
  completed_drives: count,
  quotations: count,
  bookings: count,
  booking_value: amount,
  delivered: count,
  pending_delivery: count,
  calls: count,
  connected_calls: count,
  response_minutes: minutes,
};

const showroomAnalyticsSchema = z.object({
  window_days: z.coerce.number().int().positive(),
  month: z.string(),
  branch_id: z.uuid().nullable(),
  per_branch: z.array(
    z.object({
      branch_id: z.uuid(),
      branch: z.string(),
      ...analyticsTotalsShape,
      temperatures: z.record(z.string(), count),
      sources: z.record(z.string(), count),
    }),
  ),
  focus: z.object({
    totals: z.object(analyticsTotalsShape),
    daily: z.array(z.object({ day: z.string(), leads: count, bookings: count })),
    sources: namedLeads,
    booking_sources: namedBookings,
    models: namedLeads,
    lost_reasons: namedLeads,
  }),
  targets: z.array(
    z.object({
      branch_id: z.uuid(),
      branch: z.string(),
      unit_target: count,
      bookings: count,
      booking_value: amount,
    }),
  ),
});

export type BusinessShowroomAnalytics = z.infer<typeof showroomAnalyticsSchema>;

export type BusinessSalesOverview = z.infer<typeof salesSchema>;
export type BusinessShowroomPerformance = z.infer<typeof showroomSchema>;
export type BusinessOperationsOverview = z.infer<typeof operationsSchema>;

export const businessSalesOverviewKey = (scope: readonly string[], days: number) =>
  ['business-sales-overview', ...scope, days] as const;
export const businessShowroomKey = (scope: readonly string[], days: number) =>
  ['business-showroom-performance', ...scope, days] as const;
export const businessOperationsKey = ['business-operations-overview'] as const;
export const businessShowroomAnalyticsKey = (
  scope: readonly string[],
  days: number,
  branchId: string | null,
) => ['business-showroom-analytics', ...scope, days, branchId ?? 'all'] as const;

export async function fetchBusinessShowroomAnalytics(
  days: number,
  branchId: string | null,
  signal?: AbortSignal,
) {
  const params = {
    target_days: days,
    target_timezone: 'Asia/Kolkata',
    target_branch_id: branchId,
  };
  return fetchCachedAggregate({
    resource: 'business-showroom-analytics',
    schema: showroomAnalyticsSchema,
    params,
    signal,
    direct: async () => {
      const request = createClient().rpc('get_business_showroom_analytics', params);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return showroomAnalyticsSchema.parse(data);
    },
  });
}

export async function fetchBusinessSalesOverview(days: number, signal?: AbortSignal) {
  const params = { target_days: days };
  return fetchCachedAggregate({
    resource: 'business-sales-overview',
    schema: salesSchema,
    params,
    signal,
    direct: async () => {
      const request = createClient().rpc('get_business_sales_overview', params);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return salesSchema.parse(data);
    },
  });
}

export async function fetchBusinessShowroomPerformance(days: number, signal?: AbortSignal) {
  const params = { target_days: days };
  return fetchCachedAggregate({
    resource: 'business-showroom-performance',
    schema: showroomSchema,
    params,
    signal,
    direct: async () => {
      const request = createClient().rpc('get_business_showroom_performance', params);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return showroomSchema.parse(data);
    },
  });
}

export async function fetchBusinessOperationsOverview(signal?: AbortSignal) {
  return fetchCachedAggregate({
    resource: 'business-operations-overview',
    schema: operationsSchema,
    signal,
    direct: async () => {
      const request = createClient().rpc('get_business_operations_overview');
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return operationsSchema.parse(data);
    },
  });
}

/** Exported for the IndexedDB copy, which is re-validated before it is shown. */
export {
  operationsSchema as businessOperationsSchema,
  salesSchema as businessSalesOverviewSchema,
  showroomAnalyticsSchema as businessShowroomAnalyticsSchema,
};
