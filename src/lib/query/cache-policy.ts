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
