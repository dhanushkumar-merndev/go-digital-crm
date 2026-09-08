import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

let db: PGlite;
const org = randomUUID();
const user = randomUUID();
const branch = randomUUID();
const lead = randomUUID();
let upcoming: { id: string; due_at: string };
let due: { id: string; due_at: string };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema app_private; create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${user}'::uuid $$;
    create function app_private.current_tenant_organization() returns uuid language sql as $$ select '${org}'::uuid $$;
    create function app_private.has_permission(uuid,text) returns boolean language sql as $$ select coalesce(current_setting('test.allowed',true),'yes') <> 'no' $$;
    create function app_private.can_access_record(uuid,uuid,uuid,uuid) returns boolean language sql as $$ select coalesce(current_setting('test.scope',true),'yes') <> 'no' $$;
    create table leads(id uuid primary key, organization_id uuid, deleted_at timestamptz);
    create table followups(id uuid primary key default gen_random_uuid(), organization_id uuid, assigned_user_id uuid, lead_id uuid, branch_id uuid, team_id uuid, status text default 'OPEN', due_at timestamptz, reason text default 'Call customer');
    create table notifications(id uuid primary key default gen_random_uuid(),organization_id uuid,user_id uuid,event_type text,title text,body text,resource_type text,resource_id uuid,dedupe_key text);
    create unique index notifications_dedupe_idx on notifications(organization_id,user_id,dedupe_key) where dedupe_key is not null;
    insert into leads values('${lead}','${org}',null);
  `);
  await db.exec(
    readFileSync('supabase/migrations/202609080008_followup_web_reminders.sql', 'utf8'),
  );
  async function add(interval: string, owner = user, tenant = org, status = 'OPEN') {
    const result = await db.query<{ id: string; due_at: string }>(
      'insert into followups(organization_id,assigned_user_id,lead_id,branch_id,due_at,status) values($1,$2,$3,$4,now()+$5::interval,$6) returning id,due_at::text',
      [tenant, owner, lead, branch, interval, status],
    );
    return result.rows[0]!;
  }
  upcoming = await add('4 minutes');
  due = await add('-1 minute');
  await add('2 hours');
  await add('-1 day');
  await add('1 minute', randomUUID());
  await add('1 minute', user, randomUUID());
  await add('1 minute', user, org, 'CANCELLED');
}, 30000);
afterAll(async () => {
  await db?.close();
});
const claim = (item: { id: string; due_at: string }, phase: string) =>
  db.query<{ claimed: boolean }>('select claim_followup_web_reminder($1,$2,$3) claimed', [
    item.id,
    item.due_at,
    phase,
  ]);

describe('authenticated follow-up reminder RPCs', () => {
  it('returns only nearby, open, owned work and a server timestamp', async () => {
    const result = await db.query<{ result: { records: { id: string }[]; server_now: string } }>(
      'select get_my_followup_reminders() result',
    );
    expect(result.rows[0]!.result.records.map((row) => row.id)).toEqual([due.id, upcoming.id]);
    expect(Date.parse(result.rows[0]!.result.server_now)).toBeGreaterThan(0);
  });
  it('claims each phase once across repeated calls and rejects premature due alerts', async () => {
    expect((await claim(upcoming, 'DUE')).rows[0]!.claimed).toBe(false);
    expect((await claim(upcoming, 'UPCOMING')).rows[0]!.claimed).toBe(true);
    expect((await claim(upcoming, 'UPCOMING')).rows[0]!.claimed).toBe(false);
    expect((await claim(due, 'UPCOMING')).rows[0]!.claimed).toBe(false);
    expect((await claim(due, 'DUE')).rows[0]!.claimed).toBe(true);
    expect((await claim(due, 'DUE')).rows[0]!.claimed).toBe(false);
    expect((await db.query('select * from notifications')).rows).toHaveLength(2);
  });
  it('rejects another owner, stale schedule, closed work and deleted leads', async () => {
    const other = (
      await db.query<{ id: string; due_at: string }>(
        'select id,due_at::text from followups where assigned_user_id<>$1 limit 1',
        [user],
      )
    ).rows[0]!;
    expect((await claim(other, 'UPCOMING')).rows[0]!.claimed).toBe(false);
    await db.query("update followups set due_at=now()+interval '3 minutes' where id=$1", [
      upcoming.id,
    ]);
    expect((await claim(upcoming, 'UPCOMING')).rows[0]!.claimed).toBe(false);
    const changed = (
      await db.query<{ id: string; due_at: string }>(
        'select id,due_at::text from followups where id=$1',
        [upcoming.id],
      )
    ).rows[0]!;
    expect((await claim(changed, 'UPCOMING')).rows[0]!.claimed).toBe(true);
    await db.query("update followups set status='CANCELLED' where id=$1", [upcoming.id]);
    expect((await claim(changed, 'UPCOMING')).rows[0]!.claimed).toBe(false);
    await db.query('update leads set deleted_at=now() where id=$1', [lead]);
    expect((await claim(due, 'DUE')).rows[0]!.claimed).toBe(false);
    const page = await db.query<{ result: { records: unknown[] } }>(
      'select get_my_followup_reminders() result',
    );
    expect(page.rows[0]!.result.records).toEqual([]);
  });
  it('enforces permission and validates the reminder phase', async () => {
    await expect(claim(due, 'INVALID')).rejects.toThrow('INVALID_REMINDER_PHASE');
    await db.exec("select set_config('test.allowed','no',false)");
    await expect(db.query('select get_my_followup_reminders()')).rejects.toThrow(
      'PERMISSION_DENIED',
    );
    await expect(claim(due, 'DUE')).rejects.toThrow('PERMISSION_DENIED');
  });
});
