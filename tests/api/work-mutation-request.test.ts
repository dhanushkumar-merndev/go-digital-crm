import { describe, expect, it, vi } from 'vitest';
import { runWorkMutation } from '../../src/features/work/work-mutation-request';

describe('work mutation request deadline', () => {
  it('returns successful saves without waiting for the timeout', async () => {
    await expect(runWorkMutation(() => Promise.resolve({ status: 'CANCELLED' }))).resolves.toEqual({
      status: 'CANCELLED',
    });
  });
  it('bounds an auth/network stall and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const pending = runWorkMutation((value) => {
        signal = value;
        return new Promise(() => {});
      }, 20_000);
      const assertion = expect(pending).rejects.toThrow('WORK_REQUEST_TIMEOUT');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('preserves database failures', async () => {
    await expect(
      runWorkMutation(() => Promise.reject(new Error('WORK_VERSION_CONFLICT'))),
    ).rejects.toThrow('WORK_VERSION_CONFLICT');
  });
});
