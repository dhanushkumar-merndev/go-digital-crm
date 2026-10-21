import { useCallback, useEffect, useRef, useState } from 'react';

export const pageSize = 25;

export type Page<T> = { records: T[]; total: number; counts?: Record<string, number> };

// Server-paginated infinite list: page 1 on any input change, the next page
// appended on scroll, and stale responses dropped when inputs change mid-flight.
export function usePagedList<T extends { id: string }>(
  fetchPage: (page: number) => Promise<Page<T>>,
  { debounceMs = 0 }: { debounceMs?: number } = {},
) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const request = ++sequence.current;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(false);
      try {
        const result = await fetchPage(1);
        if (request !== sequence.current) return;
        setItems(result.records);
        setTotal(result.total);
        setCounts(result.counts);
        setPage(1);
      } catch {
        if (request === sequence.current) setError(true);
      } finally {
        if (request === sequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fetchPage],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load('initial'), debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, load]);
  const loadMore = useCallback(async () => {
    if (loading || loadingMore || items.length >= total) return;
    const request = sequence.current;
    setLoadingMore(true);
    try {
      const result = await fetchPage(page + 1);
      if (request !== sequence.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...result.records.filter((item) => !seen.has(item.id))];
      });
      setTotal(result.total);
      setPage(page + 1);
    } catch {
      // The next scroll retries; the loaded rows stay usable.
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, items.length, loading, loadingMore, page, total]);
  // `countKey` also lowers that tab's server count, so the chip matches the list.
  const remove = useCallback((id: string, countKey?: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    setTotal((current) => Math.max(0, current - 1));
    if (countKey)
      setCounts((current) =>
        current && countKey in current
          ? { ...current, [countKey]: Math.max(0, current[countKey] - 1) }
          : current,
      );
  }, []);
  const reload = useCallback(() => void load('initial'), [load]);
  const refresh = useCallback(() => void load('refresh'), [load]);
  const more = useCallback(() => void loadMore(), [loadMore]);
  return {
    items,
    total,
    counts,
    loading,
    refreshing,
    loadingMore,
    error,
    reload,
    refresh,
    loadMore: more,
    remove,
  };
}
