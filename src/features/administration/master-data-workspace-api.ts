import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const recordSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
  created_at: z.string(),
  brand_id: z.uuid().optional(),
  brand_name: z.string().optional(),
  model_id: z.uuid().optional(),
  model_name: z.string().optional(),
  specifications: z.record(z.string(), z.unknown()).optional(),
  canonical_source: z.string().optional(),
});
const workspaceSchema = z.object({
  records: z.array(recordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    brands: z.coerce.number().int().nonnegative(),
    models: z.coerce.number().int().nonnegative(),
    variants: z.coerce.number().int().nonnegative(),
    lead_sources: z.coerce.number().int().nonnegative(),
  }),
});
export type MasterDataCategory = 'MODELS' | 'BRANDS' | 'LEAD_SOURCES' | 'VARIANTS';
export type MasterDataRecord = z.infer<typeof recordSchema>;

export async function fetchMasterDataWorkspace(
  category: MasterDataCategory,
  page: number,
  search: string,
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_master_data_workspace', {
    target_category: category,
    target_page: page,
    target_page_size: 25,
    target_search: search.trim().slice(0, 100) || null,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function setMasterDataActive(
  category: MasterDataCategory,
  id: string,
  active: boolean,
) {
  const { error } = await createClient().rpc('set_master_data_active', {
    target_category: category,
    target_id: id,
    target_active: active,
  });
  if (error) throw error;
}

export async function upsertMasterModel(input: {
  id?: string;
  brandId: string;
  name: string;
  active?: boolean;
}): Promise<{ id: string; brand_id: string; name: string; active: boolean }> {
  const { data, error } = await createClient().rpc('upsert_master_model', {
    target_id: input.id ?? null,
    target_brand_id: input.brandId,
    target_name: input.name,
    target_active: input.active ?? true,
  });
  if (error) throw error;
  return z
    .object({
      id: z.uuid(),
      brand_id: z.uuid(),
      name: z.string(),
      active: z.boolean(),
    })
    .parse(data);
}

export async function upsertMasterVariant(input: {
  id?: string;
  modelId: string;
  name: string;
  specifications?: Record<string, unknown>;
  active?: boolean;
}): Promise<{ id: string; model_id: string; name: string; active: boolean }> {
  const { data, error } = await createClient().rpc('upsert_master_variant', {
    target_id: input.id ?? null,
    target_model_id: input.modelId,
    target_name: input.name,
    target_specifications: input.specifications ?? {},
    target_active: input.active ?? true,
  });
  if (error) throw error;
  return z
    .object({
      id: z.uuid(),
      model_id: z.uuid(),
      name: z.string(),
      active: z.boolean(),
    })
    .parse(data);
}
