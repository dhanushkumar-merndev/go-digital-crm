export const marketingViews = ['SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS'] as const;
export type MarketingView = (typeof marketingViews)[number];
export const marketingPageSizes = [25, 50, 100] as const;
export type MarketingPageSize = (typeof marketingPageSizes)[number];
export const marketingSorts = ['updated:desc', 'created:desc', 'name:asc', 'status:asc'] as const;
export type MarketingSort = (typeof marketingSorts)[number];

export type MarketingQuery = {
  page: number;
  pageSize: MarketingPageSize;
  view: MarketingView;
  search: string;
  sort: MarketingSort;
};

export function marketingInitialView(slug: string): MarketingView | null {
  if (slug === 'dashboard' || slug === 'lead-sources' || slug === 'performance') return 'SOURCES';
  if (slug === 'campaigns') return 'CAMPAIGNS';
  if (slug === 'social-posts') return 'SOCIAL_POSTS';
  return null;
}

export function marketingLabel(value: string) {
  return value
    .replace(':', ' ')
    .toLowerCase()
    .split(/[_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function parseMarketingQuery(
  params: URLSearchParams,
  initialView: MarketingView,
): MarketingQuery {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const pageSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const view = (params.get('view') ?? initialView).trim().toUpperCase();
  const sort = params.get('sort');
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: marketingPageSizes.includes(pageSize as MarketingPageSize)
      ? (pageSize as MarketingPageSize)
      : 25,
    view: marketingViews.includes(view as MarketingView) ? (view as MarketingView) : initialView,
    search: (params.get('q') ?? '').trim().slice(0, 160),
    sort: marketingSorts.includes(sort as MarketingSort) ? (sort as MarketingSort) : 'updated:desc',
  };
}

export function toMarketingQueryString(query: MarketingQuery, initialView: MarketingView) {
  const params = new URLSearchParams();
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (query.view !== initialView) params.set('view', query.view);
  if (query.search) params.set('q', query.search);
  if (query.sort !== 'updated:desc') params.set('sort', query.sort);
  return params.toString();
}
