import { z } from 'zod';
import type { PerformanceDateRange } from '@/lib/performance-date-range';
import { performanceRangeDays, performanceRpcTimezone } from '@/lib/performance-date-range';
import { createClient } from '@/lib/supabase/client';

/** Stage buckets a handed-over lead can sit in, furthest first after Lost. */
export const handoffStageBuckets = [
  'WITH_SALES',
  'FOLLOW_UP',
  'TEST_DRIVE',
  'QUOTATION',
  'BOOKED',
  'LOST',
] as const;
export type HandoffStageBucket = (typeof handoffStageBuckets)[number];

const count = z.coerce.number();
const name = z.string();

const summarySchema = z.object({
  days: count,
  generated_at: z.string(),
  kpis: z.object({
    transferred: count,
    with_sales: count,
    follow_up: count,
    test_drive: count,
    quotation: count,
    booked: count,
    lost: count,
    reassigned: count,
    conversion_pct: count,
  }),
  by_consultant: z.array(
    z.object({
      consultant_id: z.string().uuid(),
      consultant: name,
      transferred: count,
      with_sales: count,
      follow_up: count,
      test_drive: count,
      quotation: count,
      booked: count,
      lost: count,
      reassigned: count,
      conversion_pct: count,
    }),
  ),
  by_telecaller: z.array(
    z.object({
      telecaller_id: z.string().uuid().nullable(),
      telecaller: name,
      transferred: count,
      consultants: count,
      in_progress: count,
      booked: count,
      lost: count,
      conversion_pct: count,
    }),
  ),
  matrix: z.array(
    z.object({
      telecaller_id: z.string().uuid().nullable(),
      telecaller: name,
      consultant_id: z.string().uuid(),
      consultant: name,
      transferred: count,
      in_progress: count,
      booked: count,
      lost: count,
      conversion_pct: count,
    }),
  ),
  by_branch: z.array(
    z.object({
      branch_id: z.string().uuid(),
      branch: name,
      transferred: count,
      in_progress: count,
      booked: count,
      lost: count,
      conversion_pct: count,
    }),
  ),
});
export type SalesHandoffSummary = z.infer<typeof summarySchema>;

const leadsSchema = z.object({
  page: count,
  page_size: count,
  total: count,
  rows: z.array(
    z.object({
      lead_id: z.string().uuid(),
      customer_name: name,
      phone: name,
      telecaller: name,
      received_by: name,
      current_owner: name.nullable(),
      reassigned: z.boolean(),
      handed_off_at: z.string(),
      stage: name,
      stage_bucket: z.enum(handoffStageBuckets),
      next_followup_at: z.string().nullable(),
      updated_at: z.string(),
    }),
  ),
});
export type SalesHandoffLeads = z.infer<typeof leadsSchema>;
export type SalesHandoffLead = SalesHandoffLeads['rows'][number];

export type SalesHandoffFilters = {
  branchId: string | null;
  teamId: string | null;
  telecallerId: string | null;
};

export type SalesHandoffLeadFilters = SalesHandoffFilters & {
  consultantId: string | null;
  stage: HandoffStageBucket | null;
  search: string;
  page: number;
  pageSize: 25 | 50 | 100;
};

export const salesHandoffKeys = {
  all: ['sales-handoff'] as const,
  summary: (scope: readonly string[], range: PerformanceDateRange, filters: SalesHandoffFilters) =>
    [
      'sales-handoff',
      'summary',
      ...scope,
      range.from,
      range.to,
      filters.branchId,
      filters.teamId,
      filters.telecallerId,
    ] as const,
  leads: (
    scope: readonly string[],
    range: PerformanceDateRange,
    filters: SalesHandoffLeadFilters,
  ) =>
    [
      'sales-handoff',
      'leads',
      ...scope,
      range.from,
      range.to,
      filters.branchId,
      filters.teamId,
      filters.telecallerId,
      filters.consultantId,
      filters.stage,
      filters.search,
      filters.page,
      filters.pageSize,
    ] as const,
};

export async function fetchSalesHandoffSummary(
  range: PerformanceDateRange,
  filters: SalesHandoffFilters,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_sales_handoff_summary', {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
    target_branch_id: filters.branchId,
    target_team_id: filters.teamId,
    target_telecaller_id: filters.telecallerId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return summarySchema.parse(data);
}

export async function fetchSalesHandoffLeads(
  range: PerformanceDateRange,
  filters: SalesHandoffLeadFilters,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_sales_handoff_leads', {
    target_days: performanceRangeDays(range),
    target_timezone: performanceRpcTimezone(range),
    target_branch_id: filters.branchId,
    target_team_id: filters.teamId,
    target_telecaller_id: filters.telecallerId,
    target_consultant_id: filters.consultantId,
    target_stage: filters.stage,
    target_search: filters.search || null,
    target_page: filters.page,
    target_page_size: filters.pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return leadsSchema.parse(data);
}
