import { keepPreviousData, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import { OPTION_QUERY_GC_TIME_MS, OPTION_QUERY_STALE_TIME_MS } from './cache-policy';

/**
 * The shared shape for every server-backed pick list in the workspace.
 *
 * `keepPreviousData` is the part that matters. Each search term is its own
 * query key, so without it every debounced keystroke put the query back into
 * `pending` and blanked the open dropdown — which is what made these lists read
 * as "not loading" even when the request was fast. With it, the previous page
 * stays on screen and is replaced only once the next one resolves.
 */
export function optionQueryOptions<T>(input: {
  queryKey: QueryKey;
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
  enabled?: boolean;
}) {
  return {
    queryKey: input.queryKey,
    queryFn: input.queryFn,
    enabled: input.enabled,
    staleTime: OPTION_QUERY_STALE_TIME_MS,
    gcTime: OPTION_QUERY_GC_TIME_MS,
    placeholderData: keepPreviousData,
  } as const;
}

/** Rows shown per dropdown page; "See more" fetches the next page of this size. */
export const OPTION_PAGE_SIZE = 5;

export type OptionPage<T> = { items: T[]; nextOffset: number | null };

/**
 * Fetches one dropdown page. It asks the server for one extra row so it knows
 * whether a further page exists without a separate count query.
 */
export async function fetchOptionPage<T>(
  offset: number,
  fetchRows: (offset: number, limit: number) => Promise<T[]>,
): Promise<OptionPage<T>> {
  const rows = await fetchRows(offset, OPTION_PAGE_SIZE + 1);
  return {
    items: rows.slice(0, OPTION_PAGE_SIZE),
    nextOffset: rows.length > OPTION_PAGE_SIZE ? offset + OPTION_PAGE_SIZE : null,
  };
}

/** Infinite-query options for a paged pick list; see `optionQueryOptions`. */
export function optionPagesQueryOptions<T>(input: {
  queryKey: QueryKey;
  fetchRows: (offset: number, limit: number, signal: AbortSignal) => Promise<T[]>;
  enabled?: boolean;
}) {
  return {
    queryKey: input.queryKey,
    queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) =>
      fetchOptionPage(pageParam, (offset, limit) => input.fetchRows(offset, limit, signal)),
    initialPageParam: 0,
    getNextPageParam: (page: OptionPage<T>) => page.nextOffset,
    enabled: input.enabled,
    staleTime: OPTION_QUERY_STALE_TIME_MS,
    gcTime: OPTION_QUERY_GC_TIME_MS,
    placeholderData: keepPreviousData,
  } as const;
}

export function flattenOptionPages<T>(data: InfiniteData<OptionPage<T>> | undefined) {
  return data?.pages.flatMap((page) => page.items);
}
