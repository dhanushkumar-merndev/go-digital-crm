import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
const modelTargetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
  target_units: z.number().int().nonnegative(),
  booked_units: z.number().int().nonnegative(),
  updated_at: z.string().nullable(),
});
const workspaceSchema = z.object({
  branch_id: z.uuid().nullable(),
  month: z.string(),
  branches: z.array(z.object({ id: z.uuid(), name: z.string() })),
  records: z.array(modelTargetSchema),
  total: z.number().int().nonnegative(),
  target_units: z.number().nonnegative(),
  booked_units: z.number().nonnegative(),
  unmatched_units: z.number().nonnegative(),
});
export type ModelTarget = z.infer<typeof modelTargetSchema>;
export async function fetchTenantTargetConfiguration(input: {
  month: string;
  branchId: string | null;
  search: string;
  page: number;
  pageSize: 25 | 50 | 100;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_branch_model_targets', {
    target_month: input.month + '-01',
    target_branch_id: input.branchId,
    target_search: input.search,
    target_page: input.page,
    target_page_size: input.pageSize,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}
export async function saveBranchTargetConfiguration(input: {
  branchId: string;
  month: string;
  modelId: string;
  units: number;
  updatedAt: string | null;
}) {
  z.number().int().min(0).max(1000000).parse(input.units);
  const { error } = await createClient().rpc('save_branch_model_target', {
    target_branch_id: input.branchId,
    target_month: input.month + '-01',
    target_model_id: input.modelId,
    target_units: input.units,
    expected_updated_at: input.updatedAt,
  });
  if (error) throw error;
}
