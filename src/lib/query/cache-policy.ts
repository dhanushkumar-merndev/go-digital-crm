/** Default freshness for non-sensitive, server-backed workspace data. */
export const QUERY_STALE_TIME_MS = 60_000;
export const QUERY_GC_TIME_MS = 30 * 60_000;

/**
 * Dashboards are expensive multi-query aggregates behind a Redis entry. An
 * in-session revisit stays in memory; the user can explicitly rebuild Redis
 * from the database with the Refresh control.
 */
export const DASHBOARD_QUERY_STALE_TIME_MS = 30 * 60_000;

/**
 * Retained for the Redis lifetime so a tab left open overnight keeps using the
 * same aggregate until the user asks for a fresh server rebuild.
 */
export const DASHBOARD_QUERY_GC_TIME_MS = 24 * 60 * 60_000;

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
