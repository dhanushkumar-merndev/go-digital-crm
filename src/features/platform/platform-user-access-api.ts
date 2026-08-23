import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const userSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid().nullable(),
  organization_name: z.string(),
  full_name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  employee_id: z.string().nullable(),
  active: z.boolean(),
  mfa_required: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  branch_count: z.coerce.number().int().nonnegative(),
  roles: z.array(z.object({ name: z.string(), key: z.string(), scope: z.string() })),
});
const resultSchema = z.object({
  records: z.array(userSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
    mfa_required: z.coerce.number().int().nonnegative(),
    organizations: z.coerce.number().int().nonnegative(),
  }),
});
export type PlatformUserAccessRecord = z.infer<typeof userSchema>;
export type PlatformUserAccessResult = z.infer<typeof resultSchema>;
export async function fetchPlatformUserAccess(
  input: {
    search: string;
    status: 'ALL' | 'ACTIVE' | 'INACTIVE';
    page: number;
    pageSize: 25 | 50 | 100;
  },
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_platform_user_access_workspace', {
    target_search: input.search.trim().slice(0, 160),
    target_status: input.status,
    target_page: input.page,
    target_page_size: input.pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return resultSchema.parse(data);
}
