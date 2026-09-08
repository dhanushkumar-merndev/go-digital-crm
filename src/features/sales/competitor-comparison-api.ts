import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
const sharingSchema = z.object({
  enabled: z.boolean(),
  version: z.number().int(),
  can_manage: z.boolean(),
});
const vehicleSchema = z.object({
  id: z.uuid(),
  manufacturer: z.string(),
  model: z.string(),
  variant: z.string(),
  dealership_name: z.string(),
  is_own: z.boolean(),
});
const detailSchema = vehicleSchema.extend({ specifications: z.record(z.string(), z.unknown()) });
export type ComparisonVehicle = z.infer<typeof detailSchema>;
export async function fetchCatalogSharing(signal?: AbortSignal) {
  const request = createClient().rpc('get_vehicle_catalog_sharing');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return sharingSchema.parse(data);
}
export async function setCatalogSharing(enabled: boolean, version: number) {
  const { data, error } = await createClient().rpc('set_vehicle_catalog_sharing', {
    target_enabled: enabled,
    expected_version: version,
    accepted_consent: enabled ? 'vehicle-catalog-v1' : null,
  });
  if (error) throw error;
  return sharingSchema.parse(data);
}
export async function searchComparisonVehicles(
  search: string,
  ownOnly: boolean,
  page: number,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('search_comparison_vehicles', {
    target_search: search,
    own_only: ownOnly,
    target_page: page,
    target_page_size: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z
    .object({ records: z.array(vehicleSchema), total: z.number(), sharing_enabled: z.boolean() })
    .parse(data);
}
export async function fetchVehicleComparison(ourId: string, otherId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_vehicle_comparison', {
    target_our_id: ourId,
    target_other_id: otherId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.object({ ours: detailSchema, other: detailSchema }).parse(data);
}
