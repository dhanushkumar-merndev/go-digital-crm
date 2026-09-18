import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from 'vitest';

const org = randomUUID(),
  otherOrg = randomUUID(),
  actor = randomUUID(),
  conversation = randomUUID();
let db: PGlite;
const source = (file: string) =>
  readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
async function rpc(name: string, args: unknown[] = []) {
  return (
    await db.query<{
      result: {
        id: string;
        status: string;
        total: number;
        records: { id: string; name: string; body: string; provider_template_id: string | null }[];
      };
    }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) result`, args)
  ).rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema app_private;
    create schema realtime;
    create table public.test_broadcasts(payload jsonb,event text,topic text,private boolean);
    create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$ insert into public.test_broadcasts values(payload,event,topic,private) $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
    create function app_private.current_tenant_organization() returns uuid language sql stable as $$ select nullif(current_setting('test.org',true),'')::uuid $$;
    create function app_private.has_permission(org uuid,p text) returns boolean language sql stable as $$ select org=app_private.current_tenant_organization() and (p='message.send' or current_setting('test.admin',true)='true') $$;
    create table profiles(id uuid primary key,full_name text);
    create table templates(id uuid primary key default gen_random_uuid(),organization_id uuid,channel text,name text,content jsonb,provider_template_id text,status text,created_by uuid,created_at timestamptz default now(),updated_at timestamptz default now());
    create table audit_logs(organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,request_id uuid,metadata jsonb);
    create table personal_whatsapp_conversations(id uuid,organization_id uuid,owner_user_id uuid,deleted_at timestamptz);
    create function app_private.personal_whatsapp_conversation_access(org uuid,cid uuid) returns boolean language sql stable as $$ select exists(select 1 from public.personal_whatsapp_conversations where id=cid and organization_id=org and org=app_private.current_tenant_organization() and owner_user_id=auth.uid()) $$;
  `);
  await db.exec(source('202608220028_template_management_workspace.sql'));
  await db.exec(source('202609160010_personal_whatsapp_reply_templates.sql'));
  await db.exec(source('202608150032_fix_realtime_broadcast_void.sql'));
  await db.exec(source('202609160011_personal_whatsapp_template_realtime.sql'));
}, 30_000);
beforeEach(async () => {
  await db.exec('begin');
  await db.query(
    "select set_config('test.actor',$1,true),set_config('test.org',$2,true),set_config('test.admin','true',true)",
    [actor, org],
  );
  await db.query('insert into personal_whatsapp_conversations values($1,$2,$3,null)', [
    conversation,
    org,
    actor,
  ]);
});
afterEach(async () => {
  await db.exec('rollback');
});
afterAll(async () => {
  await db.close();
});

it('creates, edits, lists and archives a reply with audit records', async () => {
  const saved = await rpc('save_personal_whatsapp_template', ['Greeting', 'Hello!']);
  expect(saved.status).toBe('ACTIVE');
  await rpc('save_personal_whatsapp_template', ['Greeting', 'Welcome!', saved.id]);
  expect((await rpc('get_personal_whatsapp_templates', [conversation])).records).toEqual([
    { id: saved.id, name: 'Greeting', body: 'Welcome!' },
  ]);
  const admin = await rpc('get_template_workspace', [1, 25, null, 'WHATSAPP_PERSONAL', 'ACTIVE']);
  expect(admin.total).toBe(1);
  expect(admin.records[0].provider_template_id).toBeNull();
  await rpc('archive_template', [saved.id]);
  expect((await rpc('get_personal_whatsapp_templates', [conversation])).records).toEqual([]);
  expect((await db.query('select * from audit_logs')).rows).toHaveLength(3);
  expect((await db.query('select * from templates')).rows).toHaveLength(1);
});
it('allows senders to select replies but refuses management', async () => {
  await rpc('save_personal_whatsapp_template', ['Greeting', 'Hello']);
  await db.exec("select set_config('test.admin','false',true)");
  expect((await rpc('get_personal_whatsapp_templates', [conversation])).records).toHaveLength(1);
  await expect(rpc('save_personal_whatsapp_template', ['Blocked', 'Hello'])).rejects.toThrow(
    'TEMPLATE_MANAGE_PERMISSION_REQUIRED',
  );
});
it('broadcasts metadata-only admin changes to the owning tenant', async () => {
  const saved = await rpc('save_personal_whatsapp_template', ['Greeting', 'Private reply body']);
  await rpc('save_personal_whatsapp_template', ['Greeting', 'Updated private body', saved.id]);
  await rpc('archive_template', [saved.id]);
  const { rows } = await db.query<{
    payload: Record<string, unknown>;
    event: string;
    topic: string;
    private: boolean;
  }>('select * from public.test_broadcasts');
  expect(rows.map((row) => row.event)).toEqual(['insert', 'update', 'update']);
  for (const row of rows) {
    expect(row.topic).toBe(`organization:${org}:communications`);
    expect(row.private).toBe(true);
    expect(row.payload).toEqual({
      resource: 'communications',
      table: 'templates',
      operation: row.event.toUpperCase(),
      record_id: saved.id,
    });
  }
});
it('denies access to another owners conversation', async () => {
  await db.query('update personal_whatsapp_conversations set owner_user_id=$1', [randomUUID()]);
  await expect(rpc('get_personal_whatsapp_templates', [conversation])).rejects.toThrow(
    'PERSONAL_WHATSAPP_ACCESS_DENIED',
  );
});
it('never lists another tenants replies', async () => {
  await rpc('save_personal_whatsapp_template', ['Our reply', 'Hello']);
  await db.query(
    "insert into templates(organization_id,channel,name,content,status) values($1,'WHATSAPP_PERSONAL','Other reply','{\"body\":\"Private\"}','ACTIVE')",
    [otherOrg],
  );
  expect(
    (await rpc('get_personal_whatsapp_templates', [conversation])).records.map(
      (r: { name: string }) => r.name,
    ),
  ).toEqual(['Our reply']);
});
it('rejects overlong text rather than silently truncating it', async () => {
  await expect(
    rpc('save_personal_whatsapp_template', ['Long reply', 'x'.repeat(1501)]),
  ).rejects.toThrow('INVALID_TEMPLATE_INPUT');
});
it('refuses to edit another tenant template', async () => {
  const id = randomUUID();
  await db.query(
    `insert into templates(id,organization_id,channel,name,content,status)
     values($1,$2,'WHATSAPP_PERSONAL','Private reply','{"body":"Private"}','ACTIVE')`,
    [id, otherOrg],
  );
  await expect(rpc('save_personal_whatsapp_template', ['Changed', 'Hello', id])).rejects.toThrow(
    'TEMPLATE_NOT_FOUND',
  );
});
it('does not expose template RPCs anonymously', async () => {
  const grants = await db.query<{ allowed: boolean }>(
    `select has_function_privilege('anon','public.get_personal_whatsapp_templates(uuid,text,integer)','execute')
      or has_function_privilege('anon','public.save_personal_whatsapp_template(text,text,uuid)','execute') as allowed`,
  );
  expect(grants.rows[0].allowed).toBe(false);
});
it('cannot turn a personal saved reply into a provider approved template', async () => {
  const saved = await rpc('save_personal_whatsapp_template', ['Greeting', 'Hello']);
  await expect(
    db.query("update templates set status='APPROVED',provider_template_id='fake' where id=$1", [
      saved.id,
    ]),
  ).rejects.toThrow('personal_reply_template_content');
});
it('paginates and searches saved replies on the server', async () => {
  for (let i = 0; i < 26; i++)
    await rpc('save_personal_whatsapp_template', [`Reply ${String(i).padStart(2, '0')}`, 'Hello']);
  expect(
    (await rpc('get_personal_whatsapp_templates', [conversation, null, 1])).records,
  ).toHaveLength(25);
  expect(
    (await rpc('get_personal_whatsapp_templates', [conversation, null, 2])).records,
  ).toHaveLength(1);
  expect(
    (await rpc('get_personal_whatsapp_templates', [conversation, '25', 1])).records[0].name,
  ).toBe('Reply 25');
});
