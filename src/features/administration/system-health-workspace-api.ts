import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const resultSchema = z.object({
  generated_at: z.string(),
  scope: z.object({
    organization_wide: z.boolean(),
    accessible_branches: z.coerce.number().int().nonnegative(),
  }),
  kpis: z.object({
    visible_connections: z.coerce.number().int().nonnegative(),
    attention_connections: z.coerce.number().int().nonnegative(),
    sync_runs_24h: z.coerce.number().int().nonnegative(),
    failed_syncs_24h: z.coerce.number().int().nonnegative(),
  }),
  provider_summary: z.array(
    z.object({
      provider_key: z.string(),
      connections: z.coerce.number().int().nonnegative(),
      attention_connections: z.coerce.number().int().nonnegative(),
      sync_runs_7d: z.coerce.number().int().nonnegative(),
    }),
  ),
  attention_connections: z.array(
    z.object({
      id: z.uuid(),
      provider_key: z.string(),
      display_name: z.string(),
      scope_mode: z.string(),
      status: z.string(),
      last_tested_at: z.string().nullable(),
      last_sync_at: z.string().nullable(),
      last_error_code: z.string().nullable(),
      visible_branch_names: z.array(z.string()),
    }),
  ),
  recent_sync_runs: z.array(
    z.object({
      id: z.uuid(),
      connection_id: z.uuid(),
      provider_key: z.string(),
      display_name: z.string(),
      sync_type: z.string(),
      status: z.string(),
      records_processed: z.coerce.number().int().nonnegative(),
      started_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
});

export type SystemHealthWorkspaceResult = z.infer<typeof resultSchema>;

export async function fetchSystemHealthWorkspace(signal?: AbortSignal) {
  const request = createClient().rpc('get_system_administrator_health_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
