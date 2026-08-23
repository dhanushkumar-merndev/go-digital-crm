import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const workspaceSchema = z.object({
  organization_id: z.uuid(),
  kpis: z.object({
    enabled: z.coerce.number().int().nonnegative(),
    expiring_30_days: z.coerce.number().int().nonnegative(),
    disabled: z.coerce.number().int().nonnegative(),
    not_configured: z.coerce.number().int().nonnegative(),
  }),
  records: z.array(
    z.object({
      id: z.uuid(),
      module_key: z.string().min(1),
      name: z.string().min(1),
      catalog_active: z.boolean(),
      status: z.enum(['ENABLED', 'DISABLED', 'EXPIRED', 'NOT_CONFIGURED']),
      valid_until: z.string().nullable(),
      usage_last_30_days: z.coerce.number().int().nonnegative(),
    }),
  ),
});

export type TenantModuleEntitlementsWorkspace = z.infer<typeof workspaceSchema>;

export async function fetchTenantModuleEntitlementsWorkspace(signal?: AbortSignal) {
  const request = createClient().rpc('get_tenant_module_entitlements_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}
