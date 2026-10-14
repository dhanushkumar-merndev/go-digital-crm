import { createClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProviderOutbox } from '../../trigger/provider-outbox';

const messageId = randomUUID();
const organizationId = randomUUID();
const connectionId = randomUUID();
const conversationId = randomUUID();
let db: PGlite;
let encrypted: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create table conversation_messages (
    id uuid primary key, delivery_status text, provider_status_at timestamptz,
    provider_message_id text, safe_error_code text, attempt_count integer,
    last_attempt_at timestamptz
  )`);
  const rawKey = randomBytes(32);
  vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', rawKey.toString('base64url'));
  vi.stubEnv('META_GRAPH_API_VERSION', 'v26.0');
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(
      JSON.stringify({ access_token: 'test-token', phone_number_id: 'test-phone' }),
    ),
  );
  encrypted = `\\x${Buffer.from(
    JSON.stringify({
      version: 'AES-256-GCM-v1',
      iv: iv.toString('base64url'),
      ciphertext: Buffer.from(ciphertext).toString('base64url'),
    }),
  ).toString('hex')}`;
}, 20_000);
beforeEach(async () => {
  await db.exec('truncate conversation_messages');
  await db.query(
    "insert into conversation_messages(id,delivery_status,attempt_count) values($1,'RETRY',1)",
    [messageId],
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db?.close();
});

describe('WhatsApp sender and receipt ordering', () => {
  it.each(['DELIVERED', 'READ', 'FAILED', null])(
    'preserves an early %s receipt while completing the provider send',
    async (receiptStatus) => {
      // Meta can deliver the callback before returning its accepted-send response.
      vi.stubGlobal('fetch', async () => {
        if (receiptStatus)
          await db.query(
            'update conversation_messages set delivery_status=$1,provider_status_at=now(),provider_message_id=$2 where id=$3',
            [receiptStatus, 'wamid.accepted', messageId],
          );
        return Response.json({ messages: [{ id: 'wamid.accepted' }] });
      });
      const supabase = createClient('https://crm.test', 'test-service-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/rpc/claim_domain_outbox'))
              return Response.json([
                {
                  id: randomUUID(),
                  organization_id: organizationId,
                  event_type: 'message.send.retry',
                  aggregate_id: messageId,
                  payload: {},
                  attempts: 1,
                },
              ]);
            if (url.pathname.endsWith('/rpc/complete_domain_outbox')) return Response.json(true);
            if (url.pathname.endsWith('/conversation_messages')) {
              if (init?.method !== 'PATCH')
                return Response.json({
                  id: messageId,
                  conversation_id: conversationId,
                  application_message_id: randomUUID(),
                  status: 'RETRY',
                  body: 'Hello',
                  metadata: {},
                  attempt_count: 1,
                });
              const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
              const columns = Object.keys(patch);
              const values = Object.values(patch);
              const statusFilter = url.searchParams.get('delivery_status');
              const receiptFilter = url.searchParams.get('provider_status_at');
              await db.query(
                `update conversation_messages set ${columns.map((name, i) => `${name}=$${i + 1}`).join(',')}
             where id=$${values.length + 1}
             ${statusFilter === 'eq.RETRY' ? "and delivery_status='RETRY'" : ''}
             ${receiptFilter === 'is.null' ? 'and provider_status_at is null' : ''}`,
                [...values, messageId],
              );
              return new Response(null, { status: 204 });
            }
            if (url.pathname.endsWith('/conversations'))
              return Response.json({
                id: conversationId,
                connection_id: connectionId,
                external_contact: '919873100001',
              });
            if (url.pathname.endsWith('/integration_credentials'))
              return Response.json({ encrypted_payload: encrypted });
            throw new Error(`Unexpected database path ${url.pathname}`);
          },
        },
      });
      const result = await runProviderOutbox(supabase);
      expect(result.completed).toBe(1);
      const row = (
        await db.query<{ delivery_status: string; provider_message_id: string }>(
          'select * from conversation_messages',
        )
      ).rows[0];
      expect(row.delivery_status).toBe(receiptStatus ?? 'SENT');
      expect(row.provider_message_id).toBe('wamid.accepted');
    },
  );
});
