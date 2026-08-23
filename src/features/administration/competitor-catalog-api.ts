import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
const profileSchema = z.object({
  id: z.uuid(),
  manufacturer: z.string(),
  model: z.string(),
  variant: z.string(),
  fuel_type: z.string().nullable(),
  ex_showroom_price: z.coerce.number().nonnegative().nullable(),
  specifications: z.record(z.string(), z.unknown()),
  advantages: z.array(z.string()),
  active: z.boolean(),
});
export type CompetitorProfile = z.infer<typeof profileSchema>;
export async function fetchCompetitorProfiles(signal?: AbortSignal) {
  const request = createClient().rpc('list_competitor_vehicle_profiles');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(profileSchema).parse(data);
}
export async function saveCompetitorProfile(input: {
  id?: string;
  manufacturer: string;
  model: string;
  variant: string;
  fuelType: string;
  price: number | null;
  specifications: Record<string, unknown>;
  advantages: string[];
  active: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('save_competitor_vehicle_profile', {
    target_id: input.id ?? null,
    target_manufacturer: input.manufacturer,
    target_model: input.model,
    target_variant: input.variant,
    target_fuel_type: input.fuelType || null,
    target_ex_showroom_price: input.price,
    target_specifications: input.specifications,
    target_advantages: input.advantages,
    target_active: input.active,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return profileSchema
    .pick({ id: true, manufacturer: true, model: true, variant: true, active: true })
    .parse(data);
}
