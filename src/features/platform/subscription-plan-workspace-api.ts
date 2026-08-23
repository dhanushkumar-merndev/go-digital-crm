import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const moduleSchema = z.object({
  id: z.uuid(),
  module_key: z.string(),
  name: z.string(),
  active: z.boolean(),
});
const resultSchema = z.object({
  kpis: z.object({
    total_plans: z.coerce.number().int().nonnegative(),
    active_plans: z.coerce.number().int().nonnegative(),
    module_assignments: z.coerce.number().int().nonnegative(),
    active_modules: z.coerce.number().int().nonnegative(),
  }),
  available_modules: z.array(moduleSchema),
  plans: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(2),
      active: z.boolean(),
      created_at: z.string(),
      modules: z.array(moduleSchema.extend({ limits: z.record(z.string(), z.unknown()) })),
    }),
  ),
});

export type SubscriptionPlanWorkspace = z.infer<typeof resultSchema>;
export type SubscriptionPlan = SubscriptionPlanWorkspace['plans'][number];

export async function fetchSubscriptionPlanWorkspace(signal?: AbortSignal) {
  const request = createClient().rpc('get_platform_subscription_plan_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}

export async function saveSubscriptionPlan(input: {
  planId: string | null;
  name: string;
  active: boolean;
  moduleIds: string[];
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('save_platform_subscription_plan', {
    target_plan_id: input.planId,
    target_name: input.name,
    target_active: input.active,
    target_module_ids: input.moduleIds,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z
    .object({ id: z.uuid(), name: z.string(), active: z.boolean(), replayed: z.boolean() })
    .parse(data);
}
