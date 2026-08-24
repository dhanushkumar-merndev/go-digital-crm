import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const resultSchema = z.object({
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    used_period: z.coerce.number().nonnegative(),
    remaining: z.coerce.number(),
    allocated: z.coerce.number().nonnegative(),
    average_daily_usage: z.coerce.number().nonnegative(),
  }),
  daily: z.array(z.object({ name: z.string(), value: z.coerce.number().nonnegative() })),
  features: z.array(z.object({ name: z.string(), value: z.coerce.number().nonnegative() })),
  organizations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(1),
      status: z.enum([
        'ONBOARDING',
        'UNDER_REVIEW',
        'CHANGES_REQUIRED',
        'ACTIVE',
        'SUPPORT_MAINTENANCE',
        'SUSPENDED',
        'REJECTED',
        'SOFT_DELETED',
      ]),
      credit_allocation_allowed: z.boolean(),
      used_period: z.coerce.number().nonnegative(),
      balance: z.coerce.number(),
      daily_average: z.coerce.number().nonnegative(),
    }),
  ),
});

export type PlatformAiUsage = z.infer<typeof resultSchema>;

const creditAllocationResultSchema = z.object({
  ledger_id: z.uuid(),
  organization_id: z.uuid(),
  amount: z.coerce.number().int().positive(),
  balance: z.coerce.number().int(),
  replayed: z.boolean(),
});

const creditLedgerSchema = z.object({
  balance: z.coerce.number().int(),
  has_more: z.boolean(),
  next_cursor: z
    .object({
      created_at: z.string(),
      id: z.uuid(),
    })
    .nullable(),
  entries: z.array(
    z.object({
      id: z.uuid(),
      transaction_type: z.enum(['ALLOCATION', 'CONSUMPTION', 'ADJUSTMENT', 'REVERSAL']),
      amount: z.coerce.number().int(),
      feature: z.string().nullable(),
      source: z.string().nullable(),
      reason: z.string(),
      reference_id: z.string(),
      created_by_name: z.string(),
      created_at: z.string(),
    }),
  ),
});

export type PlatformAiCreditLedger = z.infer<typeof creditLedgerSchema>;
export type PlatformAiCreditLedgerCursor = NonNullable<PlatformAiCreditLedger['next_cursor']>;

export async function fetchPlatformAiUsage(input: {
  days: 7 | 14 | 30;
  page: number;
  search: string;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_platform_ai_usage_workspace', {
    target_days: input.days,
    target_page: input.page,
    target_page_size: 25,
    target_search: input.search.trim().slice(0, 80) || null,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}

export async function grantPlatformAiCredits(input: {
  organizationId: string;
  amount: number;
  reason: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('grant_platform_ai_credits', {
    target_organization_id: input.organizationId,
    target_amount: input.amount,
    target_reason: input.reason.trim(),
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return creditAllocationResultSchema.parse(data);
}

export async function fetchPlatformAiCreditLedger(input: {
  organizationId: string;
  cursor: PlatformAiCreditLedgerCursor | null;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_platform_ai_credit_ledger', {
    target_organization_id: input.organizationId,
    target_before_at: input.cursor?.created_at ?? null,
    target_before_id: input.cursor?.id ?? null,
    target_page_size: 25,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return creditLedgerSchema.parse(data);
}
