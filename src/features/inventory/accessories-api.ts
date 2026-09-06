import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

export const accessoryCategoryEnum = z.enum([
  'EXTERIOR',
  'INTERIOR',
  'ELECTRICAL',
  'CAR_CARE',
  'SAFETY_UTILITY',
]);
export type AccessoryCategory = z.infer<typeof accessoryCategoryEnum>;

export const accessoryStatusEnum = z.enum(['ORDERED', 'ALLOCATED', 'FITTED']);
export type AccessoryStatus = z.infer<typeof accessoryStatusEnum>;

const accessoryRecordSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  part_number: z.string(),
  category: accessoryCategoryEnum,
  price: z.coerce.number().nonnegative(),
  stock_quantity: z.coerce.number().int().nonnegative(),
  oem: z.boolean(),
  active: z.boolean(),
  created_at: z.string(),
});
export type AccessoryRecord = z.infer<typeof accessoryRecordSchema>;

const accessoriesCatalogResponseSchema = z.object({
  records: z.array(accessoryRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_items: z.coerce.number().int().nonnegative(),
    active_items: z.coerce.number().int().nonnegative(),
    low_stock: z.coerce.number().int().nonnegative(),
  }),
});
export type AccessoriesCatalogResponse = z.infer<typeof accessoriesCatalogResponseSchema>;

const bookingAccessorySchema = z.object({
  id: z.uuid(),
  booking_id: z.uuid(),
  accessory_id: z.uuid(),
  name: z.string(),
  part_number: z.string(),
  category: accessoryCategoryEnum,
  quantity: z.coerce.number().int().positive(),
  unit_price: z.coerce.number().nonnegative(),
  status: accessoryStatusEnum,
  fitted_by: z.uuid().nullable(),
  fitted_at: z.string().nullable(),
});
export type BookingAccessory = z.infer<typeof bookingAccessorySchema>;

export async function fetchAccessoriesCatalog(
  category?: AccessoryCategory | null,
  search: string = '',
  page: number = 1,
  pageSize: number = 25,
  signal?: AbortSignal,
): Promise<AccessoriesCatalogResponse> {
  const request = createClient().rpc('get_accessories_catalog', {
    target_category: category ?? null,
    target_search: search.trim().slice(0, 100) || null,
    target_page: page,
    target_page_size: pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return accessoriesCatalogResponseSchema.parse(data);
}

export async function upsertAccessory(input: {
  id?: string;
  name: string;
  partNumber: string;
  category: AccessoryCategory;
  price: number;
  stockQuantity: number;
  oem?: boolean;
  active?: boolean;
}): Promise<AccessoryRecord> {
  const { data, error } = await createClient().rpc('upsert_accessory', {
    target_id: input.id ?? null,
    target_name: input.name,
    target_part_number: input.partNumber,
    target_category: input.category,
    target_price: input.price,
    target_stock: input.stockQuantity,
    target_oem: input.oem ?? true,
    target_active: input.active ?? true,
  });
  if (error) throw error;
  return accessoryRecordSchema.parse(data);
}

export async function fetchBookingAccessories(bookingId: string): Promise<BookingAccessory[]> {
  const { data, error } = await createClient().rpc('get_booking_accessories', {
    target_booking_id: bookingId,
  });
  if (error) throw error;
  return z.array(bookingAccessorySchema).parse(data);
}

export async function addBookingAccessory(input: {
  bookingId: string;
  accessoryId: string;
  quantity?: number;
  unitPrice?: number;
}): Promise<BookingAccessory> {
  const { data, error } = await createClient().rpc('add_booking_accessory', {
    target_booking_id: input.bookingId,
    target_accessory_id: input.accessoryId,
    target_quantity: input.quantity ?? 1,
    target_unit_price: input.unitPrice ?? null,
  });
  if (error) throw error;
  return bookingAccessorySchema.parse(data);
}

export async function setBookingAccessoryStatus(
  bookingAccessoryId: string,
  status: AccessoryStatus,
): Promise<{ id: string; status: AccessoryStatus; fitted_at: string | null }> {
  const { data, error } = await createClient().rpc('set_booking_accessory_status', {
    target_booking_accessory_id: bookingAccessoryId,
    target_status: status,
  });
  if (error) throw error;
  return z
    .object({
      id: z.uuid(),
      status: accessoryStatusEnum,
      fitted_at: z.string().nullable(),
    })
    .parse(data);
}
