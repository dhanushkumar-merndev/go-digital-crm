export const inventoryPageSizes = [25, 50, 100] as const;
export type InventoryPageSize = (typeof inventoryPageSizes)[number];

export type InventoryView =
  'dashboard' | 'units' | 'stock-check' | 'allocations' | 'ageing' | 'movements';

export const inventoryFilters = [
  'all',
  'incoming',
  'available',
  'limited',
  'unavailable',
  'reserved',
  'allocated',
  'in-transit',
  'hold',
  'ready-for-delivery',
  'delivered',
  'active',
  'pending',
  'suggested',
  'on-hold',
  'released',
  'cancelled',
  'intake',
  'detail-update',
  'status-change',
  'branch-transfer',
  'allocation',
  'allocation-release',
] as const;
export type InventoryFilter = (typeof inventoryFilters)[number];

export const inventoryAgeFilters = ['all', '0-30', '31-60', '61-90', '90-plus'] as const;
export type InventoryAgeFilter = (typeof inventoryAgeFilters)[number];

export const inventorySorts = [
  'received:desc',
  'received:asc',
  'age:desc',
  'vin:asc',
  'model:asc',
  'status:asc',
  'updated:desc',
  'available:desc',
  'incoming:desc',
  'branch:asc',
  'allocated:desc',
  'allocated:asc',
  'booking:asc',
  'moved:desc',
  'moved:asc',
  'type:asc',
] as const;
export type InventorySort = (typeof inventorySorts)[number];

export type InventoryQuery = {
  page: number;
  pageSize: InventoryPageSize;
  search: string;
  filter: InventoryFilter;
  branchId: string;
  age: InventoryAgeFilter;
  sort: InventorySort;
};

export function inventoryViewForRoute(role: string, slug: string): InventoryView | null {
  if (role === 'inventory' && slug === 'dashboard') return 'dashboard';
  if (slug === 'vehicle-inventory') return 'units';
  if (slug === 'stock-check') return 'stock-check';
  if (slug === 'stock-allocation') return 'allocations';
  if (slug === 'stock-ageing') return 'ageing';
  if (slug === 'stock-transfer') return 'movements';
  return null;
}

export function defaultInventorySort(view: InventoryView): InventorySort {
  if (view === 'stock-check') return 'model:asc';
  if (view === 'allocations') return 'allocated:desc';
  if (view === 'movements') return 'moved:desc';
  if (view === 'ageing') return 'age:desc';
  return 'received:desc';
}

const filtersByView: Record<InventoryView, readonly InventoryFilter[]> = {
  dashboard: ['all'],
  units: [
    'all',
    'incoming',
    'available',
    'reserved',
    'allocated',
    'in-transit',
    'hold',
    'ready-for-delivery',
    'delivered',
  ],
  'stock-check': ['all', 'available', 'limited', 'incoming', 'unavailable'],
  allocations: [
    'all',
    'active',
    'pending',
    'suggested',
    'reserved',
    'allocated',
    'on-hold',
    'released',
    'cancelled',
  ],
  ageing: [
    'all',
    'incoming',
    'available',
    'reserved',
    'allocated',
    'in-transit',
    'hold',
    'ready-for-delivery',
  ],
  movements: [
    'all',
    'intake',
    'detail-update',
    'status-change',
    'branch-transfer',
    'allocation',
    'allocation-release',
  ],
};

const sortsByView: Record<InventoryView, readonly InventorySort[]> = {
  dashboard: ['received:desc'],
  units: [
    'received:desc',
    'received:asc',
    'age:desc',
    'vin:asc',
    'model:asc',
    'status:asc',
    'updated:desc',
  ],
  'stock-check': ['model:asc', 'available:desc', 'incoming:desc', 'branch:asc'],
  allocations: ['allocated:desc', 'allocated:asc', 'booking:asc', 'vin:asc'],
  ageing: [
    'age:desc',
    'received:desc',
    'received:asc',
    'vin:asc',
    'model:asc',
    'status:asc',
    'updated:desc',
  ],
  movements: ['moved:desc', 'moved:asc', 'vin:asc', 'type:asc'],
};

export function parseInventoryQuery(params: URLSearchParams, view: InventoryView): InventoryQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const filter = params.get('status');
  const age = params.get('age');
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: inventoryPageSizes.includes(pageSize as InventoryPageSize)
      ? (pageSize as InventoryPageSize)
      : 25,
    search: (params.get('q') ?? '').trim().slice(0, 100),
    filter: filtersByView[view].includes(filter as InventoryFilter)
      ? (filter as InventoryFilter)
      : 'all',
    branchId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      params.get('branch') ?? '',
    )
      ? (params.get('branch') as string)
      : '',
    age:
      (view === 'units' || view === 'ageing') &&
      inventoryAgeFilters.includes(age as InventoryAgeFilter)
        ? (age as InventoryAgeFilter)
        : 'all',
    sort: sortsByView[view].includes(sort as InventorySort)
      ? (sort as InventorySort)
      : defaultInventorySort(view),
  };
}

export function toInventoryQueryString(query: InventoryQuery, view: InventoryView) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.filter !== 'all') params.set('status', query.filter);
  if (query.branchId) params.set('branch', query.branchId);
  if (query.age !== 'all') params.set('age', query.age);
  if (query.sort !== defaultInventorySort(view)) params.set('sort', query.sort);
  return params.toString();
}

export const inventoryFilterValue = (value: InventoryFilter) =>
  value === 'all' ? 'ALL' : value.replaceAll('-', '_').toUpperCase();

export const inventoryAgeValue = (value: InventoryAgeFilter) =>
  value === 'all' ? 'ALL' : value.replaceAll('-', '_').toUpperCase();

export class InventoryVersionConflictError extends Error {
  constructor() {
    super('INVENTORY_VERSION_CONFLICT');
    this.name = 'InventoryVersionConflictError';
  }
}

export function isInventoryVersionConflict(error: unknown) {
  return (
    error instanceof InventoryVersionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: string }).code === '40001' ||
        /(?:STOCK|ALLOCATION)_VERSION_CONFLICT/.test(
          (error as { message?: string }).message ?? '',
        )))
  );
}
