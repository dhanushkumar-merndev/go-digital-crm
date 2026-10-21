import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { readRpc } from '@/lib/supabase/read-rpc';

const count = z.coerce.number().int().nonnegative();
const slice = z.object({ name: z.string(), value: count });

const adminOverviewSchema = z.object({
  organization_wide: z.boolean(),
  kpis: z.object({
    branches: count,
    active_branches: count,
    users: count,
    active_users: count,
    inactive_users: count,
    sales_users: count,
    operational_users: count,
    mfa_required_users: count,
    integrations_connected: count,
    integration_issues: count,
  }),
  roles: z.array(slice),
  branches: z.array(slice),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const adminOverviewKey = ['admin-overview'] as const;

/** Aggregates only, limited to the caller's user.manage scope (get_admin_overview). */
export async function fetchAdminOverview(signal?: AbortSignal): Promise<AdminOverview> {
  const data = await readRpc(createClient().rpc('get_admin_overview'), signal);
  return adminOverviewSchema.parse(data);
}
