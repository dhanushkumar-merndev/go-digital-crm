import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const assignedDealershipSchema = z.object({
  name: z.string().trim().min(1),
});

export async function fetchAssignedDealershipName() {
  const { data, error } = await createClient().rpc('get_assigned_dealership_name');

  if (error) throw error;
  if (!data) throw new Error('ASSIGNED_DEALERSHIP_UNAVAILABLE');

  return assignedDealershipSchema.shape.name.parse(data);
}
