type SupabaseErrorLike = {
  code?: string | null;
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

  const code = error.code?.toUpperCase() ?? '';
  if (code.startsWith('08')) return true;
  if (transientPostgrestCodes.has(code) || transientDatabaseCodes.has(code)) return true;

  const message = error.message?.toLowerCase() ?? '';
  return /\b(fetch failed|network error|connection reset|connection refused|temporarily unavailable)\b/.test(
    message,
  );
}
