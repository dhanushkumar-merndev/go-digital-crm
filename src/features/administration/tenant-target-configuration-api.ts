import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const branchTargetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sales_target: z.coerce.number().nonnegative(),
  sales_value: z.coerce.number().nonnegative(),
  booking_target: z.coerce.number().nonnegative(),
  bookings: z.coerce.number().int().nonnegative(),
  drive_target: z.coerce.number().nonnegative(),
  test_drives: z.coerce.number().int().nonnegative(),
});

const workspaceSchema = z.object({
  month: z.string(),
  kpis: z.object({
    branch_count: z.coerce.number().int().nonnegative(),
    configured_branches: z.coerce.number().int().nonnegative(),
    sales_target: z.coerce.number().nonnegative(),
    sales_value: z.coerce.number().nonnegative(),
  }),
  branches: z.array(branchTargetSchema),
});

const saveSchema = z.object({
  branch_id: z.uuid(),
  month: z.string(),
  sales_target: z.coerce.number().nonnegative(),
  booking_target: z.coerce.number().nonnegative(),
  drive_target: z.coerce.number().nonnegative(),
});

export type TenantTargetWorkspace = z.infer<typeof workspaceSchema>;
export type BranchTarget = z.infer<typeof branchTargetSchema>;

export async function fetchTenantTargetConfiguration(month: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_tenant_target_configuration_workspace', {
    target_month: `${month}-01`,
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function saveBranchTargetConfiguration(input: {
  branchId: string;
  month: string;
  salesTarget: number;
  bookingTarget: number;
  driveTarget: number;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('save_branch_target_configuration', {
    target_branch_id: input.branchId,
    target_month: `${input.month}-01`,
    target_sales_value: input.salesTarget,
    target_booking_count: input.bookingTarget,
    target_test_drive_count: input.driveTarget,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return saveSchema.parse(data);
}
