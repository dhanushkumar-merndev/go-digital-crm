import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../supabase/functions/_shared/supabase.ts', () => ({
  serviceClient: () => state.client!,
}));

const connectionId = '936cb53f-f04e-421e-a71e-37a3a12000f7';
const organizationId = 'a1b2a2a8-7834-4bac-a068-35eb06286f02';
const appSecret = 'test-app-secret';
let handler: (request: Request) => Promise<Response>;
let background: Promise<unknown>[] = [];
let stored = new Map<string, { id: string; status: string; event_type: string }>();
let triggerRequests: Record<string, unknown>[] = [];
let databaseFails = false;
let triggerFails = false;
let triggerResponse: Promise<Response> | null = null;

function payload(id = 'wamid.test') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-1' },
              messages: [
                {
                  id,
                  from: '919873100001',
                  timestamp: '1791635400',
                  type: 'text',
                  text: { body: 'Hi' },
                },
              ],
              statuses: [
                {
                  id: 'wamid.outbound',
                  recipient_id: '919873100001',
                  timestamp: '1791635400',
                  status: 'read',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function request(body = payload(), validSignature = true) {
  const raw = JSON.stringify(body);
  return handler(
    new Request('https://crm.test/functions/v1/provider-webhook-whatsapp', {
      method: 'POST',
      body: raw,
      headers: {
        'x-hub-signature-256': `sha256=${validSignature ? createHmac('sha256', appSecret).update(raw).digest('hex') : 'invalid'}`,
      },
    }),
  );
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: {
      get: (name: string) =>
        ({ META_APP_SECRET: appSecret, TRIGGER_SECRET_KEY: 'test-trigger-secret' })[name],
    },
    serve: (callback: typeof handler) => {
      handler = callback;
    },
  });
  vi.stubGlobal('EdgeRuntime', {
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  });
  state.client = createClient('https://crm.test', 'test-service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/integration_branch_mappings'))
          return Response.json([
            {
              organization_id: organizationId,
              connected_account_id: connectionId,
              external_resource_id: 'phone-1',
            },
          ]);
        if (url.pathname.endsWith('/connected_accounts'))
          return Response.json([{ id: connectionId, organization_id: organizationId }]);
        if (url.pathname.endsWith('/provider_events')) {
          if (databaseFails)
            return Response.json(
              { code: 'XX000', message: 'database unavailable' },
              { status: 500 },
            );
          const inserted: { id: string }[] = [];
          for (const receipt of JSON.parse(String(init?.body))) {
            if (stored.has(receipt.provider_event_id)) continue;
            const row = {
              id: randomUUID(),
              status: receipt.status,
              event_type: receipt.event_type,
            };
            stored.set(receipt.provider_event_id, row);
            inserted.push({ id: row.id });
          }
          return Response.json(inserted, { status: 201 });
        }
        throw new Error(`Unexpected database path ${url.pathname}`);
      },
    },
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/v1/tasks/provider-event-dispatch-now/trigger')
      throw new Error('Unexpected task endpoint');
    triggerRequests.push(JSON.parse(String(init?.body)));
    if (triggerResponse) return triggerResponse;
    return triggerFails ? Response.json({}, { status: 503 }) : Response.json({ id: 'run_test' });
  });
  // The production handler is checked by Deno. A runtime import exercises it
  // here without pulling Deno's npm specifiers into the web TypeScript build.
  const webhookModule = '../../supabase/functions/provider-webhook-whatsapp/index.ts';
  await import(webhookModule);
});

beforeEach(() => {
  background = [];
  stored = new Map();
  triggerRequests = [];
  databaseFails = false;
  triggerFails = false;
  triggerResponse = null;
});
afterAll(() => vi.unstubAllGlobals());

describe('WhatsApp immediate event dispatch', () => {
  it('acknowledges persisted replies and receipts without waiting for the task API', async () => {
    let resolve!: (response: Response) => void;
    triggerResponse = new Promise<Response>((done) => {
      resolve = done;
    });
    const response = await request();
    expect(response.status).toBe(200);
    expect([...stored.values()].map((row) => row.event_type).sort()).toEqual([
      'WHATSAPP_INBOUND_MESSAGE',
      'WHATSAPP_MESSAGE_STATUS',
    ]);
    expect(background).toHaveLength(1);
    await vi.waitFor(() => expect(triggerRequests).toHaveLength(1));
    expect(triggerRequests[0]).toEqual({
      payload: { eventIds: [...stored.values()].map((row) => row.id) },
      options: { idempotencyKey: expect.stringMatching(/^provider-events:/) },
    });
    resolve(Response.json({ id: 'run_test' }));
    await Promise.all(background);
  });

  it('does not enqueue work for a duplicate or unsigned delivery', async () => {
    expect((await request()).status).toBe(200);
    await Promise.all(background);
    expect((await request()).status).toBe(200);
    expect((await request(payload('wamid.unsigned'), false)).status).toBe(401);
    await Promise.all(background);
    expect(stored.size).toBe(2);
    expect(triggerRequests).toHaveLength(1);
  });

  it('keeps accepted events available to the scheduled worker if the task API fails', async () => {
    triggerFails = true;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await request()).status).toBe(200);
      await Promise.all(background);
      expect(triggerRequests).toHaveLength(1);
      expect([...stored.values()].every((row) => row.status === 'RECEIVED')).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it('never starts a worker before persistence succeeds', async () => {
    databaseFails = true;
    expect((await request()).status).toBe(500);
    expect(stored.size).toBe(0);
    expect(background).toHaveLength(0);
    expect(triggerRequests).toHaveLength(0);
  });
});
