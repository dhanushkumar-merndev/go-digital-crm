import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = new URL(
  '../../supabase/migrations/202610101071_provider_event_immediate_claim.sql',
  import.meta.url,
);
let db: PGlite;
const organization = randomUUID();
const otherOrganization = randomUUID();
const connection = randomUUID();

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;
    create function auth.role() returns text language sql as $$
      select current_setting('request.jwt.claim.role', true)
    $$;
    create table public.provider_events (
      id uuid primary key, organization_id uuid not null, connected_account_id uuid not null,
      event_type text not null, status text not null default 'RECEIVED',
      attempt_count integer not null default 0, next_attempt_at timestamptz,
      received_at timestamptz not null default now(), processing_started_at timestamptz,
      processing_worker_id text, safe_error_code text, processed_at timestamptz
    );
  `);
  if (existsSync(migration)) await db.exec(readFileSync(migration, 'utf8'));
}, 20_000);

beforeEach(async () => {
  await db.exec('truncate provider_events');
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
});
afterAll(async () => db?.close());

async function receipt(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.query(
    `insert into provider_events
      (id,organization_id,connected_account_id,event_type,status,attempt_count,next_attempt_at)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      overrides.organization ?? organization,
      connection,
      overrides.type ?? 'WHATSAPP_INBOUND_MESSAGE',
      overrides.status ?? 'RECEIVED',
      overrides.attempts ?? 0,
      overrides.nextAttempt ?? null,
    ],
  );
  return id;
}

async function claim(ids: string[], worker = 'instant-worker') {
  return (
    await db.query<{ id: string; processing_worker_id: string; attempt_count: number }>(
      'select * from claim_provider_event_receipts($1,$2::uuid[])',
      [worker, ids],
    )
  ).rows;
}

describe('immediate provider receipt leases', () => {
  it('claims the webhook receipts without claiming another tenant’s backlog', async () => {
    const inbound = await receipt();
    const delivery = await receipt({ type: 'WHATSAPP_MESSAGE_STATUS' });
    const unrelated = await receipt({ organization: otherOrganization });
    const claimed = await claim([inbound, delivery]);
    expect(claimed.map((row) => row.id).sort()).toEqual([inbound, delivery].sort());
    expect(
      claimed.every(
        (row) => row.processing_worker_id === 'instant-worker' && row.attempt_count === 1,
      ),
    ).toBe(true);
    expect(
      (
        await db.query<{ status: string }>('select status from provider_events where id=$1', [
          unrelated,
        ])
      ).rows[0].status,
    ).toBe('RECEIVED');
  });

  it('does not steal events from a worker or bypass retry backoff', async () => {
    const ready = await receipt();
    const leased = await receipt({ status: 'PROCESSING', attempts: 1 });
    const retry = await receipt({ status: 'RETRY', attempts: 1 });
    const future = await receipt({ nextAttempt: new Date(Date.now() + 60_000).toISOString() });
    const processed = await receipt({ status: 'PROCESSED', attempts: 1 });
    expect((await claim([ready, leased, retry, future, processed])).map((row) => row.id)).toEqual([
      ready,
    ]);
    expect(await claim([ready], 'second-worker')).toEqual([]);
  });

  it('refuses ordinary authenticated callers and invalid batches', async () => {
    const id = await receipt();
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await expect(claim([id])).rejects.toThrow('SERVICE_ROLE_REQUIRED');
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
    await expect(claim([])).rejects.toThrow('INVALID_PROVIDER_EVENT_CLAIM');
    await expect(claim(Array.from({ length: 101 }, () => randomUUID()))).rejects.toThrow(
      'INVALID_PROVIDER_EVENT_CLAIM',
    );
    await expect(claim([id], '')).rejects.toThrow('INVALID_PROVIDER_EVENT_CLAIM');
  });
});
