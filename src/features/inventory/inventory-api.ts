import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { fetchCachedDashboard } from '@/lib/query/cached-dashboard-api';
import {
  InventoryVersionConflictError,
  inventoryAgeValue,
  inventoryFilterValue,
  isInventoryVersionConflict,
  type InventoryQuery,
} from './inventory-query';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();

export type InventoryPermissions = {
  organizationId: string;
  scopeKey: string;
  canStockCheck: boolean;
  canView: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canMove: boolean;
  canAllocate: boolean;
};

export async function fetchInventoryPermissions(): Promise<InventoryPermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    organization_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (context?.destination !== 'CRM' || !context.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');

  const permissionKeys = [
    'inventory.stock_check',
    'inventory.view',
    'inventory.create',
    'inventory.update',
    'inventory.move',
    'inventory.allocate',
  ];
  const responses = await Promise.all(
    permissionKeys.map((target_permission) =>
      supabase.rpc('authorize_action', {
        target_organization_id: context.organization_id,
        target_permission,
        target_branch_id: null,
      }),
    ),
  );
  const failed = responses.find((response) => response.error);
  if (failed?.error) throw failed.error;
  if (!responses[0]?.data && !responses[1]?.data)
    throw new Error('INVENTORY_READ_PERMISSION_REQUIRED');
  return {
    organizationId: context.organization_id,
    scopeKey: `${context.role_key ?? 'unknown'}:${context.data_scope ?? 'unknown'}`,
    canStockCheck: Boolean(responses[0]?.data),
    canView: Boolean(responses[1]?.data),
    canCreate: Boolean(responses[2]?.data),
    canUpdate: Boolean(responses[3]?.data),
    canMove: Boolean(responses[4]?.data),
    canAllocate: Boolean(responses[5]?.data),
  };
}

export type InventoryBranch = { id: string; name: string };

export async function fetchInventoryBranches(): Promise<InventoryBranch[]> {
  const { data, error } = await createClient()
    .from('branches')
    .select('id,name')
    .eq('active', true)
    .is('deleted_at', null)
    .order('name');
  if (error) throw error;
  return z.array(z.object({ id: z.uuid(), name: z.string() })).parse(data);
}

const chartDatumSchema = z.object({
  name: z.string(),
  value: z.coerce.number().int().nonnegative(),
  secondary: z.coerce.number().int().nonnegative().optional(),
});

const inventoryDashboardSchema = z.object({
  kpis: z.object({
    total_stock: z.coerce.number().int().nonnegative(),
    available: z.coerce.number().int().nonnegative(),
    reserved: z.coerce.number().int().nonnegative(),
    allocated: z.coerce.number().int().nonnegative(),
    in_transit: z.coerce.number().int().nonnegative(),
    ageing_stock: z.coerce.number().int().nonnegative(),
    ready_for_delivery: z.coerce.number().int().nonnegative(),
    low_stock_models: z.coerce.number().int().nonnegative(),
  }),
  model_distribution: z.array(chartDatumSchema),
  branch_distribution: z.array(chartDatumSchema),
  attention: z.object({
    ageing_90_plus: z.coerce.number().int().nonnegative(),
    on_hold: z.coerce.number().int().nonnegative(),
    incoming: z.coerce.number().int().nonnegative(),
    allocation_pending: z.coerce.number().int().nonnegative(),
  }),
});

export type InventoryDashboard = z.infer<typeof inventoryDashboardSchema>;

export async function fetchInventoryDashboard(): Promise<InventoryDashboard> {
  const cached = await fetchCachedDashboard({
    resource: 'inventory-dashboard',
    schema: inventoryDashboardSchema,
  });
  return cached.result;
}

export const stockUnitSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  variant_id: z.uuid(),
  vin: z.string(),
  chassis_number: z.string(),
  engine_number: nullableString,
  color: nullableString,
  status: z.string(),
  received_at: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  version: z.coerce.number().int().positive(),
  days_in_stock: z.coerce.number().int().nonnegative(),
  branch_name: z.string(),
  brand_name: z.string(),
  model_name: z.string(),
  variant_name: z.string(),
  allocation_id: nullableUuid,
  allocation_status: nullableString,
  booking_id: nullableUuid,
  booking_number: nullableString,
});

export type StockUnit = z.infer<typeof stockUnitSchema>;

const stockUnitPageSchema = z.object({
  records: z.array(stockUnitSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total_stock: z.coerce.number().int().nonnegative(),
    available: z.coerce.number().int().nonnegative(),
    reserved: z.coerce.number().int().nonnegative(),
    allocated: z.coerce.number().int().nonnegative(),
    ageing_60_plus: z.coerce.number().int().nonnegative(),
    on_hold: z.coerce.number().int().nonnegative(),
  }),
});

export type StockUnitPage = z.infer<typeof stockUnitPageSchema>;

export async function fetchStockUnitPage(query: InventoryQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_stock_unit_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_status: inventoryFilterValue(query.filter),
    target_branch_id: query.branchId || null,
    target_age: inventoryAgeValue(query.age),
    target_sort: query.sort,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return stockUnitPageSchema.parse(data);
}

const stockCheckRowSchema = z.object({
  key: z.string(),
  branch_id: z.uuid(),
  variant_id: z.uuid(),
  branch_name: z.string(),
  brand_name: z.string(),
  model_name: z.string(),
  variant_name: z.string(),
  color: nullableString,
  fuel: nullableString,
  transmission: nullableString,
  available: z.coerce.number().int().nonnegative(),
  reserved: z.coerce.number().int().nonnegative(),
  allocated: z.coerce.number().int().nonnegative(),
  incoming: z.coerce.number().int().nonnegative(),
  availability: z.string(),
});

const stockCheckPageSchema = z.object({
  records: z.array(stockCheckRowSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    available_units: z.coerce.number().int().nonnegative(),
    limited_groups: z.coerce.number().int().nonnegative(),
    incoming_units: z.coerce.number().int().nonnegative(),
    unavailable_groups: z.coerce.number().int().nonnegative(),
  }),
});

export type StockCheckPage = z.infer<typeof stockCheckPageSchema>;

export async function fetchStockCheckPage(query: InventoryQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_stock_check_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_availability: inventoryFilterValue(query.filter),
    target_branch_id: query.branchId || null,
    target_sort: query.sort,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return stockCheckPageSchema.parse(data);
}

export const allocationRowSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  stock_unit_id: z.uuid(),
  booking_id: nullableUuid,
  allocation_method: z.string(),
  status: z.string(),
  allocated_at: z.string(),
  released_at: nullableString,
  release_reason: nullableString,
  updated_at: z.string(),
  version: z.coerce.number().int().positive(),
  stock_version: z.coerce.number().int().positive(),
  vin: z.string(),
  stock_status: z.string(),
  color: nullableString,
  branch_name: z.string(),
  brand_name: z.string(),
  model_name: z.string(),
  variant_name: z.string(),
  booking_number: nullableString,
  allocated_by_name: nullableString,
});

export type AllocationRow = z.infer<typeof allocationRowSchema>;

const allocationPageSchema = z.object({
  records: z.array(allocationRowSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    active: z.coerce.number().int().nonnegative(),
    reserved: z.coerce.number().int().nonnegative(),
    allocated: z.coerce.number().int().nonnegative(),
    released: z.coerce.number().int().nonnegative(),
  }),
});

export type AllocationPage = z.infer<typeof allocationPageSchema>;

export async function fetchAllocationPage(query: InventoryQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_stock_allocation_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_status: inventoryFilterValue(query.filter),
    target_branch_id: query.branchId || null,
    target_sort: query.sort,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return allocationPageSchema.parse(data);
}

export const movementRowSchema = z.object({
  id: z.uuid(),
  stock_unit_id: z.uuid(),
  from_branch_id: nullableUuid,
  to_branch_id: nullableUuid,
  movement_type: z.string(),
  reason: nullableString,
  moved_at: z.string(),
  vin: z.string(),
  stock_status: z.string(),
  brand_name: z.string(),
  model_name: z.string(),
  variant_name: z.string(),
  from_branch_name: nullableString,
  to_branch_name: nullableString,
  moved_by_name: nullableString,
});

export type MovementRow = z.infer<typeof movementRowSchema>;

const movementPageSchema = z.object({
  records: z.array(movementRowSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    movements_today: z.coerce.number().int().nonnegative(),
    transfers: z.coerce.number().int().nonnegative(),
    intakes: z.coerce.number().int().nonnegative(),
    status_changes: z.coerce.number().int().nonnegative(),
  }),
});

export type MovementPage = z.infer<typeof movementPageSchema>;

export async function fetchMovementPage(query: InventoryQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_stock_movement_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_movement_type: inventoryFilterValue(query.filter),
    target_branch_id: query.branchId || null,
    target_sort: query.sort,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return movementPageSchema.parse(data);
}

const optionSchema = z.object({ id: z.uuid(), label: z.string() });
export type InventoryVariantOption = z.infer<typeof optionSchema>;

export async function fetchVariantOptions(search: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_inventory_variant_options', {
    target_search: search.trim().slice(0, 100),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(optionSchema).parse(data);
}

const bookingOptionSchema = z.object({
  id: z.uuid(),
  booking_number: z.string(),
  customer_name: nullableString,
});
export type InventoryBookingOption = z.infer<typeof bookingOptionSchema>;

export async function fetchBookingOptions(branchId: string, search: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_inventory_booking_options', {
    target_branch_id: branchId,
    target_search: search.trim().slice(0, 100),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(bookingOptionSchema).parse(data);
}

const stockDetailSchema = stockUnitSchema
  .omit({
    days_in_stock: true,
    allocation_id: true,
    allocation_status: true,
    booking_id: true,
    booking_number: true,
  })
  .extend({
    movements: z.array(
      z.object({
        id: z.uuid(),
        movement_type: z.string(),
        from_branch_name: nullableString,
        to_branch_name: nullableString,
        reason: nullableString,
        moved_by_name: nullableString,
        moved_at: z.string(),
      }),
    ),
    allocations: z.array(
      z.object({
        id: z.uuid(),
        booking_id: nullableUuid,
        booking_number: nullableString,
        allocation_method: z.string(),
        status: z.string(),
        allocated_at: z.string(),
        released_at: nullableString,
        release_reason: nullableString,
        version: z.coerce.number().int().positive(),
      }),
    ),
  });

export type StockUnitDetail = z.infer<typeof stockDetailSchema>;

export async function fetchStockUnitDetail(stockUnitId: string) {
  const { data, error } = await createClient().rpc('get_stock_unit_detail', {
    target_stock_unit_id: stockUnitId,
  });
  if (error) throw error;
  return stockDetailSchema.parse(data);
}

const stockMutationSchema = z.object({
  stock_unit_id: z.uuid(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  branch_id: z.uuid().optional(),
  replayed: z.boolean(),
});

export type CreateStockInput = {
  organizationId: string;
  branchId: string;
  variantId: string;
  vin: string;
  chassisNumber: string;
  engineNumber: string | null;
  color: string | null;
  status: 'INCOMING' | 'AVAILABLE';
  receivedAt: string | null;
  requestId: string;
};

export async function createStockUnit(input: CreateStockInput) {
  const { data, error } = await createClient().rpc('create_stock_unit', {
    target_organization_id: input.organizationId,
    target_branch_id: input.branchId,
    target_variant_id: input.variantId,
    target_vin: input.vin,
    target_chassis_number: input.chassisNumber,
    target_engine_number: input.engineNumber,
    target_color: input.color,
    target_status: input.status,
    target_received_at: input.receivedAt,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return stockMutationSchema.parse(data);
}

export type UpdateStockInput = {
  stockUnitId: string;
  expectedVersion: number;
  engineNumber: string | null;
  color: string | null;
  receivedAt: string | null;
  reason: string;
  requestId: string;
};

export async function updateStockUnit(input: UpdateStockInput) {
  const { data, error } = await createClient().rpc('update_stock_unit', {
    target_stock_unit_id: input.stockUnitId,
    expected_version: input.expectedVersion,
    target_engine_number: input.engineNumber,
    target_color: input.color,
    target_received_at: input.receivedAt,
    target_reason: input.reason,
    target_request_id: input.requestId,
  });
  if (isInventoryVersionConflict(error)) throw new InventoryVersionConflictError();
  if (error) throw error;
  return stockMutationSchema.parse(data);
}

export type ChangeStockStatusInput = {
  stockUnitId: string;
  expectedVersion: number;
  status: string;
  reason: string;
  requestId: string;
};

export async function changeStockStatus(input: ChangeStockStatusInput) {
  const { data, error } = await createClient().rpc('set_stock_unit_status', {
    target_stock_unit_id: input.stockUnitId,
    expected_version: input.expectedVersion,
    target_status: input.status,
    target_reason: input.reason,
    target_request_id: input.requestId,
  });
  if (isInventoryVersionConflict(error)) throw new InventoryVersionConflictError();
  if (error) throw error;
  return stockMutationSchema.parse(data);
}

export type MoveStockInput = {
  stockUnitId: string;
  expectedVersion: number;
  toBranchId: string;
  reason: string;
  requestId: string;
};

export async function moveStockUnit(input: MoveStockInput) {
  const { data, error } = await createClient().rpc('move_stock_unit', {
    target_stock_unit_id: input.stockUnitId,
    expected_version: input.expectedVersion,
    target_to_branch_id: input.toBranchId,
    target_reason: input.reason,
    target_request_id: input.requestId,
  });
  if (isInventoryVersionConflict(error)) throw new InventoryVersionConflictError();
  if (error) throw error;
  return stockMutationSchema.parse(data);
}

const allocationMutationSchema = z.object({
  stock_unit_id: z.uuid(),
  stock_version: z.coerce.number().int().positive(),
  stock_status: z.string(),
  allocation_id: z.uuid(),
  allocation_version: z.coerce.number().int().positive(),
  allocation_status: z.string(),
  booking_id: z.uuid().optional(),
  replayed: z.boolean(),
});

export type AllocateStockInput = {
  stockUnitId: string;
  expectedStockVersion: number;
  bookingId: string;
  allocationStatus: 'RESERVED' | 'ALLOCATED';
  existingAllocationId: string | null;
  expectedAllocationVersion: number | null;
  requestId: string;
};

export async function allocateStockUnit(input: AllocateStockInput) {
  const { data, error } = await createClient().rpc('allocate_stock_unit', {
    target_stock_unit_id: input.stockUnitId,
    expected_stock_version: input.expectedStockVersion,
    target_booking_id: input.bookingId,
    target_allocation_status: input.allocationStatus,
    target_existing_allocation_id: input.existingAllocationId,
    expected_allocation_version: input.expectedAllocationVersion,
    target_request_id: input.requestId,
  });
  if (isInventoryVersionConflict(error)) throw new InventoryVersionConflictError();
  if (error) throw error;
  return allocationMutationSchema.parse(data);
}

export type ReleaseAllocationInput = {
  allocationId: string;
  expectedAllocationVersion: number;
  expectedStockVersion: number;
  reason: string;
  requestId: string;
};

export async function releaseStockAllocation(input: ReleaseAllocationInput) {
  const { data, error } = await createClient().rpc('release_stock_allocation', {
    target_allocation_id: input.allocationId,
    expected_allocation_version: input.expectedAllocationVersion,
    expected_stock_version: input.expectedStockVersion,
    target_reason: input.reason,
    target_request_id: input.requestId,
  });
  if (isInventoryVersionConflict(error)) throw new InventoryVersionConflictError();
  if (error) throw error;
  return allocationMutationSchema.omit({ booking_id: true }).parse(data);
}
