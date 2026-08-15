import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

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

export const tenantDashboardSchema = z.object({
  organization_id: z.uuid(),
  generated_at: z.string(),
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  capabilities: capabilitySchema,
  kpis: kpiSchema,
  activity: z.array(chartDatumSchema),
  pipeline: z.array(chartDatumSchema),
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
  activity_primary: z.string(),
  activity_secondary: z.string(),
});

export type TenantDashboardResult = z.infer<typeof tenantDashboardSchema>;

export async function fetchTenantDashboard(signal?: AbortSignal) {
  const request = createClient().rpc('get_tenant_performance_dashboard', {
    target_days: 14,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return tenantDashboardSchema.parse(data);
}
