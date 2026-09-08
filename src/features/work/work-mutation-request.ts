/** Bound the UI wait, including an auth refresh stalled before fetch starts.
 * A timeout is an unknown outcome; retry with the same idempotency key.
 */
export async function runWorkMutation<T>(
  request: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(request(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('WORK_REQUEST_TIMEOUT'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
