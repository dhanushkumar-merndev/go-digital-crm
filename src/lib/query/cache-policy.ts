/** Default freshness for non-sensitive, server-backed workspace data. */
export const QUERY_STALE_TIME_MS = 60_000;
export const QUERY_GC_TIME_MS = 30 * 60_000;

/**
 * Dashboards and analytics are aggregates read browser-first: memory, then the
 * IndexedDB copy (usePersistedQuery, so a reload inside this window makes no
 * network call), then Redis through the dashboard-cache Edge function, then
 * PostgreSQL only when the Redis entry is missing or its data version moved.
 * While a page is open, Realtime refetches it at most once a minute
 * (AGGREGATE_REALTIME_MIN_INTERVAL_MS) so other users' changes still arrive.
 */
export const DASHBOARD_QUERY_STALE_TIME_MS = 30 * 60_000;

/** Kept in memory well past staleTime; a stale copy still paints while the refetch runs. */
export const DASHBOARD_QUERY_GC_TIME_MS = 24 * 60 * 60_000;

/** Realtime refetch ceiling for aggregate queries; matches the Redis rebuild interval. */
export const AGGREGATE_REALTIME_MIN_INTERVAL_MS = 60_000;

/**
 * Pick-list data behind a form control (leads, vehicles, quotations, bookings).
 *
 * These are small, bounded, server-authorized result sets that a consultant
 * opens repeatedly while filling one form, so they stay fresh for the length of
 * a working session rather than the default minute. Every write path that can
 * change them already invalidates their key through the sales-consultant cache
 * map, so a long freshness window never serves a list the user just changed.
 */
export const OPTION_QUERY_STALE_TIME_MS = 5 * 60_000;

/**
 * Kept well past `staleTime` on purpose: the retained entry is what makes
 * reopening a form paint the previous list immediately instead of an empty
 * dropdown, while a background refetch settles the difference.
 */
export const OPTION_QUERY_GC_TIME_MS = 60 * 60_000;
