type SupabaseErrorLike = {
  code?: string | number | null;
  message?: string | null;
  status?: number | null;
};

const transientHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const transientPostgrestCodes = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']);
const transientDatabaseCodes = new Set(['53300', '57P01', '57P02', '57P03']);

/**
 * Retry only failures that can plausibly recover without changing the request.
 * Authorization, validation and missing-RPC errors are deliberately excluded so
 * one bad request cannot double database work on every navigation.
 */
export function isTransientSupabaseError(error: SupabaseErrorLike | null | undefined) {
  if (!error) return false;
  if (typeof error.status === 'number' && transientHttpStatuses.has(error.status)) return true;

  // DOMException (including AbortError) exposes a numeric legacy code.
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  if (code.startsWith('08')) return true;
  if (transientPostgrestCodes.has(code) || transientDatabaseCodes.has(code)) return true;

  // A dropped connection never reaches PostgREST. supabase-js reports it with
  // status 0 and the browser's own wording: Node says "fetch failed", Chromium
  // "Failed to fetch", Safari "Load failed", Firefox "NetworkError when
  // attempting to fetch resource". Without the browser forms, one dropped
  // request on an RPC (POST, which supabase-js never retries itself) showed a
  // page's full "not available" state instead of a single retry.
  const message = error.message?.toLowerCase() ?? '';
  return /\b(fetch failed|failed to fetch|load failed|networkerror when attempting to fetch|network error|connection reset|connection refused|temporarily unavailable)\b/.test(
    message,
  );
}
