import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const pageSize = 25;

const resultSchema = z.object({
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_connections: z.coerce.number().int().nonnegative(),
    healthy_connections: z.coerce.number().int().nonnegative(),
    attention_connections: z.coerce.number().int().nonnegative(),
    events_last_7_days: z.coerce.number().int().nonnegative(),
    sync_runs_last_7_days: z.coerce.number().int().nonnegative(),
  }),
  status_overview: z.object({
    healthy: z.coerce.number().int().nonnegative(),
    attention: z.coerce.number().int().nonnegative(),
    pending: z.coerce.number().int().nonnegative(),
  }),
  records: z.array(
    z.object({
      id: z.uuid(),
      provider_key: z.string().min(1),
      display_name: z.string().min(1),
      organization_name: z.string().min(1),
      scope_mode: z.enum(['ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES']),
      status: z.string().min(1),
      external_account_hint: z.string().nullable(),
      last_tested_at: z.string().nullable(),
      last_sync_at: z.string().nullable(),
      has_attention: z.boolean(),
      events_last_30_days: z.coerce.number().int().nonnegative(),
      sync_runs_last_30_days: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type PlatformIntegrationWorkspace = z.infer<typeof resultSchema>;
export type PlatformIntegrationStatus = 'ALL' | 'CONNECTED' | 'ATTENTION' | 'PENDING';

export async function fetchPlatformIntegrationWorkspace(input: {
  page: number;
  search: string;
  status: PlatformIntegrationStatus;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_platform_integration_workspace', {
    target_page: input.page,
    target_page_size: pageSize,
    target_search: input.search.trim().slice(0, 80) || null,
    target_status: input.status,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
