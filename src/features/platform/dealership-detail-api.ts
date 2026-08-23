import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const dealershipDetailSchema = z.object({
  organization: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
    legal_name: z.string().nullable(),
    gst_number: z.string().nullable(),
    status: z.string(),
    created_at: z.string(),
    owner_name: z.string().nullable(),
    owner_email: z.string().nullable(),
    owner_phone: z.string().nullable(),
  }),
  kpis: z.object({
    branches: z.coerce.number().int().nonnegative(),
    users: z.coerce.number().int().nonnegative(),
    leads_this_week: z.coerce.number().int().nonnegative(),
    bookings_this_week: z.coerce.number().int().nonnegative(),
    enabled_modules: z.coerce.number().int().nonnegative(),
  }),
  daily: z.array(
    z.object({
      name: z.string(),
      leads: z.coerce.number().int().nonnegative(),
      bookings: z.coerce.number().int().nonnegative(),
    }),
  ),
  lead_sources: z.array(
    z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() }),
  ),
  branches: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      code: z.string(),
      users: z.coerce.number().int().nonnegative(),
      leads_this_week: z.coerce.number().int().nonnegative(),
    }),
  ),
  recent_activity: z.array(
    z.object({
      id: z.uuid(),
      action: z.string(),
      resource_type: z.string(),
      summary: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

export type PlatformDealershipDetail = z.infer<typeof dealershipDetailSchema>;

export async function fetchPlatformDealershipDetail(organizationId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_platform_dealership_detail', {
    target_organization_id: organizationId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return dealershipDetailSchema.parse(data);
}
