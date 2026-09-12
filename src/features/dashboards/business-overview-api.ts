import { z } from 'zod';
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

export type BusinessSalesOverview = z.infer<typeof salesSchema>;
export type BusinessShowroomPerformance = z.infer<typeof showroomSchema>;
export type BusinessOperationsOverview = z.infer<typeof operationsSchema>;

export const businessSalesOverviewKey = (scope: readonly string[], days: number) =>
  ['business-sales-overview', ...scope, days] as const;
export const businessShowroomKey = (scope: readonly string[], days: number) =>
  ['business-showroom-performance', ...scope, days] as const;
export const businessOperationsKey = ['business-operations-overview'] as const;

export async function fetchBusinessSalesOverview(days: number, signal?: AbortSignal) {
  const request = createClient().rpc('get_business_sales_overview', { target_days: days });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return salesSchema.parse(data);
}

export async function fetchBusinessShowroomPerformance(days: number, signal?: AbortSignal) {
  const request = createClient().rpc('get_business_showroom_performance', { target_days: days });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return showroomSchema.parse(data);
}

export async function fetchBusinessOperationsOverview(signal?: AbortSignal) {
  const request = createClient().rpc('get_business_operations_overview');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return operationsSchema.parse(data);
}
