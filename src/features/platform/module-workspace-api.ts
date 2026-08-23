import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const pageSize = 25;

const resultSchema = z.object({
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_modules: z.coerce.number().int().nonnegative(),
    active_modules: z.coerce.number().int().nonnegative(),
    inactive_modules: z.coerce.number().int().nonnegative(),
    plan_assignments: z.coerce.number().int().nonnegative(),
    enabled_entitlements: z.coerce.number().int().nonnegative(),
  }),
  records: z.array(
    z.object({
      id: z.uuid(),
      module_key: z.string().min(1),
      name: z.string().min(1),
      active: z.boolean(),
      plan_count: z.coerce.number().int().nonnegative(),
      tenant_count: z.coerce.number().int().nonnegative(),
      enabled_tenant_count: z.coerce.number().int().nonnegative(),
      usage_last_30_days: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type PlatformModuleWorkspace = z.infer<typeof resultSchema>;
export type ModuleStatusFilter = 'ALL' | 'ACTIVE' | 'INACTIVE';

export async function fetchPlatformModuleWorkspace(input: {
  page: number;
  search: string;
  status: ModuleStatusFilter;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_platform_module_workspace', {
    target_page: input.page,
    target_page_size: pageSize,
    target_search: input.search.trim().slice(0, 80) || null,
    target_status: input.status,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}

export async function setPlatformModuleActive(input: {
  moduleId: string;
  active: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('set_platform_module_active', {
    target_module_id: input.moduleId,
    target_active: input.active,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z.object({ id: z.uuid(), active: z.boolean(), idempotent: z.boolean() }).parse(data);
}
