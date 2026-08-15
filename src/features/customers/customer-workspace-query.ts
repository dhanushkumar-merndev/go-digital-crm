export const customerPageSizes = [25, 50, 100] as const;
export type CustomerPageSize = (typeof customerPageSizes)[number];

export const customerSortOptions = [
  'updated:desc',
  'updated:asc',
  'created:desc',
  'created:asc',
  'name:asc',
  'name:desc',
] as const;
export type CustomerSort = (typeof customerSortOptions)[number];

export type CustomerQuery = {
  page: number;
  pageSize: CustomerPageSize;
  search: string;
  sort: CustomerSort;
};

export const defaultCustomerQuery: CustomerQuery = {
  page: 1,
  pageSize: 25,
  search: '',
  sort: 'updated:desc',
};

export function parseCustomerQuery(params: URLSearchParams): CustomerQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1,
    pageSize: customerPageSizes.includes(pageSize as CustomerPageSize)
      ? (pageSize as CustomerPageSize)
      : 25,
    search: (params.get('q') ?? '').normalize('NFKC').trim().slice(0, 160),
    sort: customerSortOptions.includes(sort as CustomerSort)
      ? (sort as CustomerSort)
      : 'updated:desc',
  };
}

export function toCustomerQueryString(query: CustomerQuery) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.sort !== 'updated:desc') params.set('sort', query.sort);
  return params.toString();
}

export function isCustomerUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
