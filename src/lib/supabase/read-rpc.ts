import { isTransientSupabaseError } from './transient-error';

const READ_TIMEOUT_MS = 10_000;

type RpcError = { message: string; code?: string; details?: string; hint?: string };
type RpcResponse<T> = { data: T | null; error: RpcError | null; status: number };
type RpcRead<T> = { abortSignal: (signal: AbortSignal) => PromiseLike<RpcResponse<T>> };

/** Bounded interactive reads only. Never cancel or retry a business mutation here. */
export async function readRpc<T>(request: RpcRead<T>, signal?: AbortSignal): Promise<T | null> {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    combined.throwIfAborted();
    const { data, error, status } = await request.abortSignal(combined);
    combined.throwIfAborted();
    // PostgREST keeps HTTP status on the response, not on its error. Preserve
    // it for retry classification, especially gateway failures without a code.
    if (error) throw Object.assign(new Error(error.message), error, { status });
    return data;
  } catch (error) {
    // Route changes/search cancellation must not become a retryable timeout.
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted)
      throw Object.assign(new Error('The request took too long. Please try again.'), {
        code: 'READ_TIMEOUT',
        status: 408,
      });
    throw error;
  }
}

/** TanStack Query owns the single retry; the transport does not retry again. */
export function retryRpcRead(failureCount: number, error: Error) {
  return error.name !== 'AbortError' && failureCount < 1 && isTransientSupabaseError(error);
}
