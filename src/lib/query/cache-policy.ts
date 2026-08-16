/** Default freshness for non-sensitive, server-backed workspace data. */
export const QUERY_STALE_TIME_MS = 60 * 60_000;
export const QUERY_GC_TIME_MS = 2 * 60 * 60_000;

export const MANUAL_REFRESH_LIMIT = 3;
export const MANUAL_REFRESH_WINDOW_MS = 10 * 60_000;

type RefreshAttempt = { at: number };
const refreshAttempts = new Map<string, RefreshAttempt[]>();

export type ManualRefreshBudget = {
  allowed: boolean;
  remaining: number;
  retryAt: number | null;
};

function activeAttempts(resource: string, now: number) {
  const earliest = now - MANUAL_REFRESH_WINDOW_MS;
  const attempts = (refreshAttempts.get(resource) ?? []).filter((attempt) => attempt.at > earliest);
  refreshAttempts.set(resource, attempts);
  return attempts;
}

export function getManualRefreshBudget(resource: string, now = Date.now()): ManualRefreshBudget {
  const attempts = activeAttempts(resource, now);
  const remaining = Math.max(0, MANUAL_REFRESH_LIMIT - attempts.length);
  return {
    allowed: remaining > 0,
    remaining,
    retryAt: remaining > 0 ? null : attempts[0].at + MANUAL_REFRESH_WINDOW_MS,
  };
}

/** Claims one user-triggered refresh slot. Realtime/mutation invalidations are never limited. */
export function claimManualRefresh(resource: string, now = Date.now()): ManualRefreshBudget {
  const current = getManualRefreshBudget(resource, now);
  if (!current.allowed) return current;
  refreshAttempts.set(resource, [...activeAttempts(resource, now), { at: now }]);
  const next = getManualRefreshBudget(resource, now);
  // This call claimed the final available slot when next.allowed is false.
  return { ...next, allowed: true };
}

/** Test-only reset for deterministic policy coverage. */
export function resetManualRefreshBudget(resource?: string) {
  if (resource) refreshAttempts.delete(resource);
  else refreshAttempts.clear();
}
