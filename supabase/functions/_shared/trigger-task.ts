export class TriggerQueueUnavailableError extends Error {
  constructor(code: 'TRIGGER_SECRET_KEY_MISSING' | 'TRIGGER_ENQUEUE_FAILED') {
    super(code);
    this.name = 'TriggerQueueUnavailableError';
  }
}

/**
 * Enqueue a Trigger.dev task and return its run id. The idempotency key makes a
 * retried request reuse the first run instead of starting a second one.
 */
export async function enqueueTriggerTask(
  taskId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<string | null> {
  const triggerSecret = Deno.env.get('TRIGGER_SECRET_KEY');
  if (!triggerSecret) throw new TriggerQueueUnavailableError('TRIGGER_SECRET_KEY_MISSING');
  const response = await fetch(
    `https://api.trigger.dev/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${triggerSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, options: { idempotencyKey } }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new TriggerQueueUnavailableError('TRIGGER_ENQUEUE_FAILED');
  const body = (await response.json().catch(() => ({}))) as { id?: string };
  return body.id ?? null;
}
