import { z } from 'zod';
import { fetchCachedDashboard } from '@/lib/query/cached-dashboard-api';
import { assertPlatformReviewAccess } from './onboarding-review-api';

const platformDashboardSchema = z.object({
  kpis: z.object({
    active_dealerships: z.coerce.number().int().nonnegative(),
    onboarding: z.coerce.number().int().nonnegative(),
    provider_attention: z.coerce.number().int().nonnegative(),
    pending_support: z.coerce.number().int().nonnegative(),
  }),
  tenant_statuses: z.array(
    z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() }),
  ),
  activity: z.array(
    z.object({
      name: z.string(),
      value: z.coerce.number().int().nonnegative(),
      secondary: z.coerce.number().int().nonnegative(),
    }),
  ),
  attention: z.array(
    z.object({
      organization_id: z.uuid(),
      title: z.string(),
      detail: z.string(),
      severity: z.enum(['high', 'medium']),
      href: z
        .string()
        .regex(
          /^\/super-admin\/(?:dealerships|onboarding-reviews|support-sessions)(?:\?status=[a-z-]+)?$/,
        ),
    }),
  ),
});

export type PlatformDashboardData = z.infer<typeof platformDashboardSchema>;

export async function fetchPlatformDashboard(): Promise<PlatformDashboardData> {
  await assertPlatformReviewAccess();
  const cached = await fetchCachedDashboard({
    resource: 'platform-dashboard',
    schema: platformDashboardSchema,
  });
  return cached.result;
}
