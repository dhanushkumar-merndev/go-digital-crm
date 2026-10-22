'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, type RefObject } from 'react';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import {
  fetchTenantDashboardLiveItems,
  fetchTenantDashboardSummary,
  tenantDashboardSummaryResultSchema,
  type TenantDashboardResult,
} from './tenant-dashboard-api';

/** Bump when TenantDashboardSummaryResult changes shape; older IndexedDB copies are ignored. */
const SUMMARY_PERSIST_VERSION = 1;

/**
 * The summary (counts, series) is browser-persisted and served through Redis;
 * the live rows (names, phones) are fetched from PostgreSQL and kept in memory
 * only. Both keys start with `dashboardKey`, so one Realtime invalidation of
 * that prefix refreshes the pair.
 */
export function useTenantDashboard(
  dashboardKey: readonly unknown[],
  manualRefreshRequest: RefObject<boolean>,
  options: {
    /** Read PostgreSQL directly for an own-records summary; see fetchTenantDashboardSummary. */
    direct?: boolean;
  } = {},
) {
  const summary = usePersistedQuery({
    queryKey: [...dashboardKey, 'summary'],
    queryFn: ({ signal }) =>
      fetchTenantDashboardSummary(signal, {
        manualRefresh: manualRefreshRequest.current,
        direct: options.direct,
      }),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    // Another request is rebuilding this entry; check back once it has.
    refetchInterval: (query) =>
      query.state.data?.cache?.status === 'STALE' ? AGGREGATE_REALTIME_MIN_INTERVAL_MS : false,
    persist: { version: SUMMARY_PERSIST_VERSION, schema: tenantDashboardSummaryResultSchema },
  });
  const live = useQuery({
    queryKey: [...dashboardKey, 'live'],
    queryFn: ({ signal }) => fetchTenantDashboardLiveItems(signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
  });

  const data = useMemo<TenantDashboardResult | undefined>(
    () => (summary.data && live.data ? { ...summary.data, ...live.data } : undefined),
    [live.data, summary.data],
  );

  async function refetch() {
    const [summaryResult, liveResult] = await Promise.all([summary.refetch(), live.refetch()]);
    return {
      data:
        summaryResult.data && liveResult.data
          ? { ...summaryResult.data, ...liveResult.data }
          : undefined,
      error: summaryResult.error ?? liveResult.error,
    };
  }

  return {
    data,
    isPending: summary.isPending || live.isPending,
    isFetching: summary.isFetching || live.isFetching,
    isError: summary.isError || live.isError,
    refetch,
  };
}
