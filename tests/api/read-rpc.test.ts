import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { readRpc, retryRpcRead } from '../../src/lib/supabase/read-rpc';

afterEach(() => vi.restoreAllMocks());

describe('bounded interactive RPC reads', () => {
  it('returns a successful response including a valid empty result', async () => {
    for (const data of [null, [{ user_id: 'consultant' }]]) {
      const request = {
        abortSignal: vi.fn(async (signal: AbortSignal) => {
          expect(signal.aborted).toBe(false);
          return { data, error: null, status: 200 };
        }),
      };
      await expect(readRpc(request)).resolves.toEqual(data);
      expect(request.abortSignal).toHaveBeenCalledOnce();
    }
  });

  it('preserves HTTP status and the database error for retry classification', async () => {
    const request = {
      abortSignal: async () => ({
        data: null,
        error: { code: 'PGRST003', message: 'Connection pool timeout', details: 'pool exhausted' },
        status: 504,
      }),
    };
    await expect(readRpc(request)).rejects.toMatchObject({
      code: 'PGRST003',
      status: 504,
      message: 'Connection pool timeout',
      details: 'pool exhausted',
    });
  });

  it('aborts a stalled read after ten seconds and reports a retryable timeout', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let observedSignal: AbortSignal | undefined;
    const request = {
      abortSignal: (signal: AbortSignal) =>
        new Promise<{ data: null; error: null; status: number }>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const pending = readRpc(request);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'READ_TIMEOUT', status: 408 });
    deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    await assertion;
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(observedSignal?.aborted).toBe(true);
  });

  it('also recognizes timeouts returned as Supabase error results', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    await expect(
      readRpc({
        abortSignal: async () => {
          deadline.abort();
          return { data: null, error: { message: 'FetchError' }, status: 0 };
        },
      }),
    ).rejects.toMatchObject({ code: 'READ_TIMEOUT', status: 408 });
  });

  it('preserves caller cancellation and does not retry or start an already cancelled read', async () => {
    const caller = new AbortController();
    caller.abort();
    const request = { abortSignal: vi.fn() };
    await expect(readRpc(request, caller.signal)).rejects.toBe(caller.signal.reason);
    expect(request.abortSignal).not.toHaveBeenCalled();
    expect(retryRpcRead(0, caller.signal.reason)).toBe(false);
  });

  it('propagates in-flight caller cancellation without turning it into a timeout', async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    await expect(
      readRpc(
        {
          abortSignal: async (signal) => {
            observedSignal = signal;
            caller.abort();
            return { data: null, error: { message: 'Aborted' }, status: 0 };
          },
        },
        caller.signal,
      ),
    ).rejects.toBe(caller.signal.reason);
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([401, 403, 400])('does not retry HTTP %s', async (status) => {
    const client = new QueryClient();
    const request = {
      abortSignal: vi.fn(async () => ({
        data: null,
        error: { code: '42501', message: 'Permission denied' },
        status,
      })),
    };
    try {
      await expect(
        client.fetchQuery({
          queryKey: ['denied'],
          queryFn: () => readRpc(request),
          retry: retryRpcRead,
          retryDelay: 0,
        }),
      ).rejects.toMatchObject({ status });
      expect(request.abortSignal).toHaveBeenCalledOnce();
    } finally {
      client.clear();
    }
  });

  it.each([false, true])(
    'bounds retries to one and preserves recovery (recover=%s)',
    async (recover) => {
      const client = new QueryClient();
      let calls = 0;
      const request = {
        abortSignal: vi.fn(async () => {
          calls += 1;
          return recover && calls > 1
            ? { data: ['consultant'], error: null, status: 200 }
            : { data: null, error: { message: 'Service unavailable' }, status: 503 };
        }),
      };
      try {
        const result = client.fetchQuery({
          queryKey: ['service'],
          queryFn: () => readRpc(request),
          retry: retryRpcRead,
          retryDelay: 0,
        });
        if (recover) await expect(result).resolves.toEqual(['consultant']);
        else await expect(result).rejects.toMatchObject({ status: 503 });
        expect(request.abortSignal).toHaveBeenCalledTimes(2);
      } finally {
        client.clear();
      }
    },
  );
});
