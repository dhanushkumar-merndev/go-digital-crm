import { keepPreviousData, type QueryKey } from '@tanstack/react-query';
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
