import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { runProviderEventDispatch } from '../../trigger/provider-event-dispatch';

const receiptId = '8759339f-76f5-46e2-a9bb-6f2bf584451f';

describe('event-driven provider worker', () => {
  it('claims only its persisted webhook IDs instead of the global queue', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const supabase = createClient('https://crm.test', 'test-service-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          requests.push({
            path: new URL(String(input)).pathname,
            body: JSON.parse(String(init?.body)),
          });
          return Response.json([]);
        },
      },
    });
    const result = await runProviderEventDispatch(supabase, [receiptId]);
    expect(result.claimed).toBe(0);
    expect(requests).toEqual([
      {
        path: '/rest/v1/rpc/claim_provider_event_receipts',
        body: {
          target_worker_id: expect.stringMatching(/^trigger:/),
          target_event_ids: [receiptId],
        },
      },
    ]);
  });

  it('rejects empty or malformed task batches before accessing the database', async () => {
    const supabase = createClient('https://crm.test', 'test-service-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async () => {
          throw new Error('unexpected database request');
        },
      },
    });
    for (const ids of [[], ['not-a-uuid'], Array.from({ length: 101 }, () => receiptId)])
      await expect(runProviderEventDispatch(supabase, ids)).rejects.toThrow(
        'INVALID_PROVIDER_EVENT_IDS',
      );
  });
});
