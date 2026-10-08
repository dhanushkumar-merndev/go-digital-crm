import { z } from 'npm:zod@4';
import type { WorkspaceCacheResource } from '../_shared/workspace-cache.ts';

// Aggregate-only resources: counts, series and rankings. Lists a person works
// from (leads, follow-ups, tasks, calls, Customer 360) are never cached here,
// because a stale row there means a double call or the wrong owner.

const days = z.coerce.number().int().min(1).max(9999);
// Performance pages anchor the window on a chosen end date: `Asia/Kolkata|YYYY-MM-DD`.
const timezone = z.string().regex(/^Asia\/Kolkata(\|\d{4}-\d{2}-\d{2})?$/);
const fixedDashboardWindow = z
  .object({})
  .strict()
  .transform(() => ({ target_days: 14, target_timezone: 'Asia/Kolkata' }));
const performanceWindow = z.object({ target_days: days, target_timezone: timezone }).strict();
const ownerWindow = z.object({ target_days: days }).strict();
const noParams = z
  .object({})
  .strict()
  .transform(() => ({}));

type ResourceDefinition = {
  rpc: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Row in workspace_cache_versions whose triggers cover this aggregate's input tables. */
  versionKey: 'tenant-dashboard' | 'inventory-dashboard' | 'platform-dashboard';
  /** Bump when the RPC's result shape changes, so old entries are never parsed. */
  schema: number;
};

export const DASHBOARD_CACHE_RESOURCES = {
  'tenant-dashboard': {
    rpc: 'get_tenant_dashboard_summary',
    params: fixedDashboardWindow,
    versionKey: 'tenant-dashboard',
    schema: 2,
  },
  'inventory-dashboard': {
    rpc: 'get_inventory_dashboard',
    params: noParams,
    versionKey: 'inventory-dashboard',
    schema: 2,
  },
  'platform-dashboard': {
    rpc: 'get_platform_dashboard',
    params: noParams,
    versionKey: 'platform-dashboard',
    schema: 2,
  },
  'telecaller-performance': {
    rpc: 'get_telecaller_performance',
    params: performanceWindow,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'sales-consultant-performance': {
    rpc: 'get_sales_consultant_performance',
    params: performanceWindow,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'team-manager-performance': {
    rpc: 'get_team_manager_performance',
    params: performanceWindow,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'gm-sales-analytics': {
    rpc: 'get_gm_sales_analytics_workspace',
    params: performanceWindow,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'business-sales-overview': {
    rpc: 'get_business_sales_overview',
    params: ownerWindow,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'business-showroom-performance': {
    rpc: 'get_business_showroom_performance',
    params: ownerWindow,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'business-showroom-analytics': {
    rpc: 'get_business_showroom_analytics',
    params: z
      .object({
        target_days: days,
        target_timezone: timezone,
        target_branch_id: z.uuid().nullable(),
      })
      .strict(),
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
  'business-operations-overview': {
    rpc: 'get_business_operations_overview',
    params: noParams,
    versionKey: 'tenant-dashboard',
    schema: 1,
  },
} as const satisfies Record<WorkspaceCacheResource, ResourceDefinition>;

export type DashboardCacheResource = keyof typeof DASHBOARD_CACHE_RESOURCES;

export function isDashboardCacheResource(value: string): value is DashboardCacheResource {
  return Object.hasOwn(DASHBOARD_CACHE_RESOURCES, value);
}
