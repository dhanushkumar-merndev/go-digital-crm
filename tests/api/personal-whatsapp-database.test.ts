import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID(),
  actor = randomUUID(),
  other = randomUUID(),
  manager = randomUUID(),
  branch = randomUUID(),
  role = randomUUID(),
  lead = randomUUID();
const worker = randomUUID();
let db: PGlite;
let session: { connection_id: string; generation: string };
async function claims(user: string, roleName = 'authenticated') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role: roleName, aal: 'aal2' }),
  ]);
}
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}
async function gateway(op: string, data: unknown = {}) {
  await claims(actor, 'service_role');
  return rpc('personal_whatsapp_gateway', [
    session.connection_id,
    session.generation,
    worker,
    op,
    JSON.stringify(data),
  ]);
}
async function incoming(phone = '919876543210', fromMe = false, id = randomUUID()) {
  await claims(actor, 'service_role');
  return rpc('personal_whatsapp_ingest', [
    session.connection_id,
    session.generation,
    worker,
    JSON.stringify({
      phone,
      from_me: fromMe,
      provider_message_id: id,
      body: 'Hello',
      message_type: 'text',
      sent_at: new Date().toISOString(),
    }),
  ]);
}
async function prepare(conversation: unknown, id = randomUUID(), body = 'A personal reply') {
  await claims(actor);
  return rpc('personal_whatsapp_send_prepare', [conversation, id, body]);
}

describe('personal WhatsApp PostgreSQL pilot', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/personal-whatsapp-base.sql'));
    await db.exec(source('supabase/migrations/202608220009_shared_inbox_workspace.sql'));
    await db.exec(source('supabase/migrations/202609060001_personal_whatsapp_pilot.sql'));
    await db.exec(source('supabase/migrations/202609070203_personal_whatsapp_phone_matching.sql'));
    await db.exec('alter table personal_whatsapp_messages add column lead_id uuid');
    await db.exec(source('supabase/migrations/202609080003_personal_whatsapp_text_history.sql'));
    await db.exec(
      `create trigger personal_message_lead_snapshot before insert or update of lead_id,conversation_id,organization_id on personal_whatsapp_messages for each row execute function app_private.snapshot_message_lead()`,
    );
    await db.query('insert into organizations(id) values($1)', [org]);
    for (const id of [actor, other, manager])
      await db.query('insert into profiles(id,organization_id) values($1,$2)', [id, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query(
      "insert into roles(id,organization_id,role_key) values($1,$2,'telecaller_bdc')",
      [role, org],
    );
    await db.query('insert into role_permissions select $1,id from permissions', [role]);
    for (const id of [actor, other, manager]) {
      await db.query(
        'insert into user_role_assignments(organization_id,user_id,role_id) values($1,$2,$3)',
        [org, id, role],
      );
      await db.query('insert into user_branch_access values($1,$2,$3)', [org, id, branch]);
    }
    await db.query(
      'insert into leads(id,organization_id,branch_id,assigned_user_id,normalized_phone,customer_name) values($1,$2,$3,$4,$5,$6)',
      [lead, org, branch, actor, '9876543210', 'CRM customer'],
    );
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims(actor, 'service_role');
    session = (await rpc('personal_whatsapp_link_authorize', [actor, org])) as typeof session;
    await gateway('acquire');
    await gateway('connected', { masked_phone: '*******3210', account_hash: 'a'.repeat(64) });
    // Fixture timestamps use a fixed earlier link time, preserving second-resolution provider timestamps.
    await db.query(
      "update personal_whatsapp_sessions set linked_at=now()-interval '1 minute' where connection_id=$1",
      [session.connection_id],
    );
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('imports recent text history once without assigning an old message to the current lead', async () => {
    const payload = {
      phone: '919876543210',
      provider_message_id: randomUUID(),
      from_me: false,
      message_type: 'text',
      body: 'Offline text',
      sent_at: new Date(Date.now() - 86400000).toISOString(),
      is_history: true,
    };
    const args = [session.connection_id, session.generation, worker, JSON.stringify(payload)];
    const result = await rpc('personal_whatsapp_ingest', args);
    expect(result.message_id).toBeTruthy();
    expect((await rpc('personal_whatsapp_ingest', args)).message_id).toBeNull();
    const rows = await db.query<{ lead_id: string | null }>(
      'select lead_id from personal_whatsapp_messages where id=$1',
      [result.message_id],
    );
    expect(rows.rows[0].lead_id).toBeNull();
    await claims(actor);
    expect(await rpc('personal_whatsapp_sync_authorize', [result.conversation_id])).toMatchObject({
      connection_id: session.connection_id,
    });
    await expect(rpc('personal_whatsapp_sync_authorize', [result.conversation_id])).rejects.toThrow(
      /SYNC_RATE_LIMITED/,
    );
  });
  it('rejects media and history older than thirty days', async () => {
    for (const extra of [
      { message_type: 'image' },
      { sent_at: new Date(Date.now() - 31 * 86400000).toISOString() },
    ]) {
      expect(
        await rpc('personal_whatsapp_ingest', [
          session.connection_id,
          session.generation,
          worker,
          JSON.stringify({
            phone: '919876543210',
            provider_message_id: randomUUID(),
            body: 'caption',
            message_type: 'text',
            is_history: true,
            sent_at: new Date().toISOString(),
            ...extra,
          }),
        ]),
      ).toMatchObject({ ignored: true });
    }
  });
  it('ingests only accessible CRM contacts and deduplicates phone events', async () => {
    expect(await incoming('919999999999')).toMatchObject({ ignored: true });
    const id = randomUUID();
    const first = await incoming(undefined, false, id);
    expect(first.conversation_id).toBeTruthy();
    expect(
      (
        await db.query<{ discarded_message_count: number }>(
          'select discarded_message_count::int from personal_whatsapp_sessions',
        )
      ).rows[0].discarded_message_count,
    ).toBe(1);
    await incoming(undefined, false, id);
    await incoming(undefined, true);
    const counts = await db.query<{ count: number }>(
      'select count(*)::int count from personal_whatsapp_messages',
    );
    expect(counts.rows[0].count).toBe(2);
    expect((await db.query('select * from conversation_messages')).rows).toHaveLength(0);
  });
  it('does not use arbitrary international suffixes as CRM phone matches', async () => {
    expect(await incoming('449876543210')).toMatchObject({ ignored: true });
  });
  it('drops ambiguous phone matches and records outside owner scope', async () => {
    await db.query(
      'insert into leads(id,organization_id,branch_id,assigned_user_id,normalized_phone) values($1,$2,$3,$4,$5)',
      [randomUUID(), org, branch, actor, '919876543210'],
    );
    expect(await incoming()).toMatchObject({ ignored: true });
    await db.query('update leads set assigned_user_id=$1', [other]);
    expect(await incoming()).toMatchObject({ ignored: true });
  });
  it('does not move an existing phone conversation to a different CRM identity', async () => {
    await incoming();
    await db.query('update leads set assigned_user_id=$1 where id=$2', [other, lead]);
    await db.query(
      'insert into leads(id,organization_id,branch_id,assigned_user_id,normalized_phone) values($1,$2,$3,$4,$5)',
      [randomUUID(), org, branch, actor, '919876543210'],
    );
    expect(await incoming()).toMatchObject({ ignored: true });
    expect((await db.query('select id from personal_whatsapp_messages')).rows).toHaveLength(1);
  });
  it('denies other users through RLS and inbox RPCs and hides session keys', async () => {
    const message = await incoming();
    await claims(other);
    await db.exec('set role authenticated');
    expect((await db.query('select * from personal_whatsapp_messages')).rows).toHaveLength(0);
    await expect(rpc('get_inbox_message_page', [message.conversation_id])).rejects.toThrow(
      'CONVERSATION_NOT_FOUND',
    );
  });
  it('returns personal records in the paged inbox and keeps official channel filters separate', async () => {
    await incoming();
    await claims(actor);
    expect(
      await rpc('get_inbox_conversation_page', ['', 'WHATSAPP_PERSONAL', 1, 25]),
    ).toMatchObject({ total: 1 });
    expect(await rpc('get_inbox_conversation_page', ['', 'all', 1, 25])).toMatchObject({
      total: 1,
    });
    expect(
      await rpc('get_inbox_conversation_page', ['', 'WHATSAPP_BUSINESS', 1, 25]),
    ).toMatchObject({ total: 0 });
  });
  it('rejects key access and gateway calls from authenticated callers', async () => {
    await claims(actor);
    await db.exec('set role authenticated');
    await expect(db.query('select * from personal_whatsapp_keys')).rejects.toThrow(
      'permission denied',
    );
  });
  it('requires a recent inbound before sending and rejects oversized bodies', async () => {
    const sent = await incoming(undefined, true);
    await expect(prepare(sent.conversation_id)).rejects.toThrow(
      'PERSONAL_WHATSAPP_REPLY_WINDOW_CLOSED',
    );
  });
  it('atomically reserves one send and keeps idempotency payloads immutable', async () => {
    const thread = await incoming();
    const id = randomUUID();
    const first = await prepare(thread.conversation_id, id);
    expect(await prepare(thread.conversation_id, id)).toMatchObject({
      message_id: first.message_id,
      duplicate: true,
    });
    await expect(prepare(thread.conversation_id, id, 'Different')).rejects.toThrow(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    );
  });
  it('enforces cooldowns before a second outbound reservation', async () => {
    const thread = await incoming();
    await prepare(thread.conversation_id);
    await expect(prepare(thread.conversation_id)).rejects.toThrow('PERSONAL_WHATSAPP_RATE_LIMITED');
  });
  it('uses a lease and generation fence to prevent duplicate gateway owners', async () => {
    await expect(
      rpc('personal_whatsapp_gateway', [
        session.connection_id,
        session.generation,
        randomUUID(),
        'acquire',
        '{}',
      ]),
    ).rejects.toThrow('PERSONAL_WHATSAPP_LEASE_HELD');
  });
  it('revokes credentials and future ingestion when the owner disconnects', async () => {
    await gateway('keys_set', { creds: 'encrypted-test-value' });
    await claims(actor);
    await rpc('personal_whatsapp_disconnect', [session.connection_id]);
    expect((await db.query('select * from personal_whatsapp_keys')).rows).toHaveLength(0);
    await expect(gateway('heartbeat')).rejects.toThrow('PERSONAL_WHATSAPP_SESSION_REVOKED');
  });
  it('prevents signed request replay across process restarts', async () => {
    const nonce = randomUUID();
    const until = new Date(Date.now() + 60_000).toISOString();
    expect(await rpc('personal_whatsapp_nonce', [nonce, until])).toBe(true);
    expect(await rpc('personal_whatsapp_nonce', [nonce, until])).toBe(false);
  });
  it('rejects a reply after the last inbound is 24 hours old', async () => {
    const thread = await incoming();
    await db.query(
      "update personal_whatsapp_conversations set last_inbound_at=now()-interval '24 hours' where id=$1",
      [thread.conversation_id],
    );
    await expect(prepare(thread.conversation_id)).rejects.toThrow(
      'PERSONAL_WHATSAPP_REPLY_WINDOW_CLOSED',
    );
  });
  it('rejects more than 1500 characters', async () => {
    const thread = await incoming();
    await expect(prepare(thread.conversation_id, randomUUID(), 'a'.repeat(1501))).rejects.toThrow(
      'PERSONAL_WHATSAPP_INVALID_MESSAGE',
    );
  });
  it.each([
    [10, '2 minutes', 'connection'],
    [50, '1 hour', 'connection'],
    [20, '1 hour', 'recipient'],
  ])('enforces %i sends per %s rolling window (%s)', async (count, age) => {
    const thread = await incoming();
    await db.query(
      `insert into personal_whatsapp_messages(organization_id,connection_id,conversation_id,direction,body,origin,delivery_status,sent_at,created_at)
      select $1,$2,$3,'OUTBOUND','reply','CRM','SENT',now()-$4::interval,now()-$4::interval from generate_series(1,$5::int)`,
      [org, session.connection_id, thread.conversation_id, age, count],
    );
    // The daily account limit must fail independently of the 20/recipient limit.
    let target = thread;
    if (count === 50) {
      await db.query(
        'insert into leads(id,organization_id,branch_id,assigned_user_id,normalized_phone) values($1,$2,$3,$4,$5)',
        [randomUUID(), org, branch, actor, '919876543211'],
      );
      target = await incoming('919876543211');
    }
    await expect(prepare(target.conversation_id)).rejects.toThrow('PERSONAL_WHATSAPP_RATE_LIMITED');
  });
  it('keeps unknown sends blocked until a human acknowledges the phone result', async () => {
    const thread = await incoming();
    const message = await prepare(thread.conversation_id);
    await claims(actor, 'service_role');
    await rpc('personal_whatsapp_send_result', [
      session.connection_id,
      message.message_id,
      'UNKNOWN',
    ]);
    await db.query(
      "update personal_whatsapp_messages set created_at=now()-interval '10 seconds' where id=$1",
      [message.message_id],
    );
    await claims(actor);
    expect(await rpc('get_personal_whatsapp_status', [thread.conversation_id])).toMatchObject({
      send_disabled_reason: 'PERSONAL_WHATSAPP_SEND_UNRESOLVED',
    });
    await rpc('personal_whatsapp_resolve_unknown', [message.message_id]);
    expect(await prepare(thread.conversation_id)).toMatchObject({ duplicate: false });
  });
  it('blocks a second pending send even after the cooldown', async () => {
    const thread = await incoming();
    const message = await prepare(thread.conversation_id);
    await db.query(
      "update personal_whatsapp_messages set created_at=now()-interval '10 seconds' where id=$1",
      [message.message_id],
    );
    await expect(prepare(thread.conversation_id)).rejects.toThrow(
      'PERSONAL_WHATSAPP_SEND_UNRESOLVED',
    );
  });
  it('pauses after three failures and never regresses delivered/read statuses', async () => {
    const thread = await incoming();
    const message = await prepare(thread.conversation_id);
    await claims(actor, 'service_role');
    await db.query(
      `insert into personal_whatsapp_messages(organization_id,connection_id,conversation_id,direction,body,origin,delivery_status,sent_at,failed_at)
      select $1,$2,$3,'OUTBOUND','reply','CRM','FAILED',now(),now() from generate_series(1,2)`,
      [org, session.connection_id, thread.conversation_id],
    );
    await rpc('personal_whatsapp_send_result', [
      session.connection_id,
      message.message_id,
      'FAILED',
    ]);
    await claims(actor);
    expect(await rpc('get_personal_whatsapp_status', [thread.conversation_id])).toMatchObject({
      send_disabled_reason: 'PERSONAL_WHATSAPP_PAUSED',
    });
    await claims(actor, 'service_role');
    await rpc('personal_whatsapp_send_result', [session.connection_id, message.message_id, 'READ']);
    await rpc('personal_whatsapp_send_result', [session.connection_id, message.message_id, 'SENT']);
    expect(
      (
        await db.query<{ delivery_status: string }>(
          'select delivery_status from personal_whatsapp_messages where id=$1',
          [message.message_id],
        )
      ).rows[0].delivery_status,
    ).toBe('READ');
  });
  it('clears expired QR values at read time', async () => {
    await gateway('qr', { qr: 'secret-qr' });
    await db.query("update personal_whatsapp_qr_attempts set expires_at=now()-interval '1 second'");
    await claims(actor);
    expect(await rpc('get_personal_whatsapp_status')).toMatchObject({ qr: null });
  });
  it('rejects a sixth active account across the deployment', async () => {
    for (let i = 0; i < 4; i++) {
      const user = randomUUID();
      await db.query('insert into profiles(id,organization_id) values($1,$2)', [user, org]);
      await db.query(
        'insert into user_role_assignments(organization_id,user_id,role_id) values($1,$2,$3)',
        [org, user, role],
      );
      await db.query('insert into user_branch_access values($1,$2,$3)', [org, user, branch]);
      await rpc('personal_whatsapp_link_authorize', [user, org]);
    }
    await expect(rpc('personal_whatsapp_link_authorize', [other, org])).rejects.toThrow(
      'PERSONAL_WHATSAPP_CAPACITY',
    );
  });
  it('refuses manager accounts even with message permissions', async () => {
    const managerRole = randomUUID();
    await db.query("insert into roles(id,organization_id,role_key) values($1,$2,'team_manager')", [
      managerRole,
      org,
    ]);
    await db.query('update user_role_assignments set role_id=$1 where user_id=$2', [
      managerRole,
      manager,
    ]);
    await expect(rpc('personal_whatsapp_link_authorize', [manager, org])).rejects.toThrow(
      'PERSONAL_WHATSAPP_ROLE_REQUIRED',
    );
  });
  it('does not allow a caller to specify another tenant on linking', async () => {
    await expect(rpc('personal_whatsapp_link_authorize', [actor, randomUUID()])).rejects.toThrow(
      'PERSONAL_WHATSAPP_ROLE_REQUIRED',
    );
  });
  it('revokes existing sockets when an employee is promoted to a noneligible role', async () => {
    const promotedRole = randomUUID();
    await db.query(
      "insert into roles(id,organization_id,role_key,authority_level) values($1,$2,'team_manager',100)",
      [promotedRole, org],
    );
    await db.query(
      'insert into user_role_assignments(organization_id,user_id,role_id) values($1,$2,$3)',
      [org, actor, promotedRole],
    );
    await rpc('personal_whatsapp_reconcile');
    expect(
      (await db.query<{ enabled: boolean }>('select enabled from personal_whatsapp_sessions'))
        .rows[0].enabled,
    ).toBe(false);
    await expect(gateway('heartbeat')).rejects.toThrow('PERSONAL_WHATSAPP_SESSION_REVOKED');
  });
  it('does not reuse the previous phone reply window after a fresh QR link', async () => {
    const thread = await incoming();
    await claims(actor);
    await rpc('personal_whatsapp_disconnect', [session.connection_id]);
    await claims(actor, 'service_role');
    session = (await rpc('personal_whatsapp_link_authorize', [actor, org])) as typeof session;
    await gateway('acquire');
    await gateway('connected', { masked_phone: '*******1111', account_hash: 'b'.repeat(64) });
    await expect(prepare(thread.conversation_id)).rejects.toThrow(
      'PERSONAL_WHATSAPP_REPLY_WINDOW_CLOSED',
    );
  });
});
