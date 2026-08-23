import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const resultSchema = z.object({
  generated_at: z.string(),
  kpis: z.object({
    provider_connections: z.coerce.number().int().nonnegative(),
    provider_attention: z.coerce.number().int().nonnegative(),
    sync_runs_24h: z.coerce.number().int().nonnegative(),
    errors_24h: z.coerce.number().int().nonnegative(),
    active_tenants: z.coerce.number().int().nonnegative(),
  }),
  services: z.array(
    z.object({
      service: z.string(),
      errors_24h: z.coerce.number().int().nonnegative(),
      last_error_at: z.string().nullable(),
      last_safe_code: z.string().nullable(),
    }),
  ),
  provider_attention: z.array(
    z.object({
      id: z.uuid(),
      provider_key: z.string(),
      display_name: z.string(),
      organization_name: z.string(),
      status: z.string(),
      last_sync_at: z.string().nullable(),
      last_error_code: z.string().nullable(),
    }),
  ),
});

export type PlatformHealth = z.infer<typeof resultSchema>;

export async function fetchPlatformHealth(signal?: AbortSignal) {
  const request = createClient().rpc('get_platform_health_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
