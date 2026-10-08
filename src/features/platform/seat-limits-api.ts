import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const limit = z.number().int().nonnegative().nullable();

const seatLimitsSchema = z.object({
  organization_id: z.string().uuid(),
  max_branches: z.number().int().positive().nullable(),
  active_branches: z.coerce.number(),
  roles: z.array(
    z.object({
      role_key: z.string(),
      role_name: z.string(),
      role_group: z.enum(['ADMINISTRATION', 'SALES', 'DEPARTMENTS']),
      limit_scope: z.enum(['BRANCH', 'ORGANIZATION']),
      default_max_users: limit,
      overridden: z.boolean(),
      max_users: limit,
      in_use: z.coerce.number(),
      busiest_branch: z.string().nullable(),
      over_limit: z.boolean(),
    }),
  ),
});
export type OrganizationSeatLimits = z.infer<typeof seatLimitsSchema>;
export type OrganizationSeatLimitRole = OrganizationSeatLimits['roles'][number];

/** One role's save instruction: back to the platform default, or a custom limit (null = unlimited). */
export type SeatLimitChange =
  { role_key: string; use_default: true } | { role_key: string; max_users: number | null };

export const seatLimitsKey = (organizationId: string) =>
  ['platform-seat-limits', organizationId] as const;

export async function fetchOrganizationSeatLimits(organizationId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_organization_seat_limits', {
    target_organization_id: organizationId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return seatLimitsSchema.parse(data);
}

export async function saveOrganizationSeatLimits(input: {
  organizationId: string;
  maxBranches: number | null;
  limits: SeatLimitChange[];
}) {
  const { data, error } = await createClient().rpc('set_organization_seat_limits', {
    target_organization_id: input.organizationId,
    target_max_branches: input.maxBranches,
    target_limits: input.limits,
    target_request_id: crypto.randomUUID(),
  });
  if (error) throw error;
  return seatLimitsSchema.parse(data);
}
