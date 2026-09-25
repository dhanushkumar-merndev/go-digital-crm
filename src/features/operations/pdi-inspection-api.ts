import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export const pdiItemCategoryEnum = z.enum([
  'EXTERIOR',
  'INTERIOR',
  'MECHANICAL',
  'ELECTRICAL',
  'WHEELS_TYRES',
]);
export type PdiItemCategory = z.infer<typeof pdiItemCategoryEnum>;

export const pdiItemStatusEnum = z.enum([
  'PENDING',
  'PASSED',
  'FAILED',
  'RECTIFIED',
  'NOT_APPLICABLE',
]);
export type PdiItemStatus = z.infer<typeof pdiItemStatusEnum>;

export const pdiInspectionStatusEnum = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DEFECTS_FOUND',
  'PASSED',
]);
export type PdiInspectionStatus = z.infer<typeof pdiInspectionStatusEnum>;

export const pdiItemSchema = z.object({
  id: z.uuid(),
  category: pdiItemCategoryEnum,
  item_name: z.string(),
  status: pdiItemStatusEnum,
  defect_notes: z.string().nullable(),
  photo_url: z.string().nullable(),
  inspected_at: z.string().nullable(),
});
export type PdiChecklistItem = z.infer<typeof pdiItemSchema>;

export const pdiInspectionSchema = z.object({
  id: z.uuid(),
  delivery_id: z.uuid(),
  booking_id: z.uuid(),
  status: pdiInspectionStatusEnum,
  inspector_id: z.uuid().nullable(),
  overall_notes: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type PdiInspection = z.infer<typeof pdiInspectionSchema>;

export const pdiDetailResponseSchema = z.object({
  inspection: pdiInspectionSchema,
  items: z.array(pdiItemSchema),
  stats: z.object({
    total_items: z.coerce.number().int().nonnegative(),
    passed: z.coerce.number().int().nonnegative(),
    failed: z.coerce.number().int().nonnegative(),
    pending: z.coerce.number().int().nonnegative(),
  }),
});
export type PdiDetailResponse = z.infer<typeof pdiDetailResponseSchema>;

export async function fetchOrCreatePdiInspection(deliveryId: string): Promise<PdiDetailResponse> {
  const { data, error } = await createClient().rpc('get_or_create_pdi_inspection', {
    target_delivery_id: deliveryId,
  });
  if (error) throw error;
  return pdiDetailResponseSchema.parse(data);
}

/**
 * Saves every changed checklist result in one request, optionally certifying
 * the inspection in the same transaction. The sheet keeps results as a local
 * draft, so clicking Pass/Defect costs no network round trip.
 */
export async function savePdiInspection(input: {
  inspectionId: string;
  items: Array<{ id: string; status: PdiItemStatus; notes: string | null }>;
  notes?: string;
  complete: boolean;
}) {
  const { data, error } = await createClient().rpc('save_pdi_inspection', {
    target_inspection_id: input.inspectionId,
    target_items: input.items,
    target_notes: input.notes ?? null,
    target_complete: input.complete,
  });
  if (error) throw error;
  return z
    .object({
      id: z.uuid(),
      delivery_id: z.uuid(),
      status: pdiInspectionStatusEnum,
      completed_at: z.string().nullable(),
    })
    .parse(data);
}
