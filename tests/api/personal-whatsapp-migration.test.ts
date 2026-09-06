import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { expect, it } from 'vitest';

it('applies the pilot after the complete existing CRM migration history', async () => {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema realtime; create schema extensions;
      grant usage on schema auth to authenticated, service_role;
      create extension pgcrypto with schema extensions;
      create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
      create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role' $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb,created_at timestamptz,updated_at timestamptz,last_sign_in_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz);
      create table realtime.messages(id bigint,topic text,extension text,payload jsonb,event text,private boolean);
      alter table realtime.messages enable row level security;
    `);
    const directory = new URL('../../supabase/migrations/', import.meta.url);
    const migrations = readdirSync(directory)
      .filter((file) => file.endsWith('.sql') && file <= '202609060001_personal_whatsapp_pilot.sql')
      .sort();
    for (const file of migrations) {
      // PGlite is single-connection; index definitions are identical without the
      // production-only CONCURRENTLY execution mode.
      try {
        await db.exec(
          readFileSync(new URL(file, directory), 'utf8').replace(/\bconcurrently\b/gi, ''),
        );
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
    }
    const tables = await db.query<{ tablename: string; rowsecurity: boolean }>(
      "select tablename,rowsecurity from pg_tables where schemaname='public' and tablename like 'personal_whatsapp_%'",
    );
    expect(tables.rows).toHaveLength(6);
    expect(tables.rows.every((row) => row.rowsecurity)).toBe(true);
    // Seed only the in-memory database; all product triggers are re-enabled
    // before exercising linking, ingestion, browser access and send claims.
    const org = randomUUID(),
      actor = randomUUID(),
      branch = randomUUID(),
      role = randomUUID(),
      lead = randomUUID(),
      browser = randomUUID(),
      worker = randomUUID();
    await db.exec('set session_replication_role=replica');
    await db.query('insert into auth.users(id) values($1)', [actor]);
    await db.query('insert into auth.sessions(id,user_id,created_at) values($1,$2,now())', [
      browser,
      actor,
    ]);
    await db.query(
      "insert into public.organizations(id,name,slug,status) values($1,'Pilot','pilot','ACTIVE')",
      [org],
    );
    await db.query(
      "insert into public.profiles(id,organization_id,full_name,email,employee_id) values($1,$2,'Pilot user','pilot@example.invalid','PILOT')",
      [actor, org],
    );
    await db.query(
      "insert into public.branches(id,organization_id,code,name) values($1,$2,'HQ','Head office')",
      [branch, org],
    );
    await db.query(
      "insert into public.roles(id,organization_id,name,role_key,authority_level) values($1,$2,'Telecaller','telecaller_bdc',10)",
      [role, org],
    );
    await db.query(
      "insert into public.permissions(permission_key,module,description) select p,'communications',p from unnest(array['lead.view','customer.view','message.view','message.send']) p on conflict do nothing",
    );
    await db.query(
      "insert into public.role_permissions select $1,id from public.permissions where permission_key in ('lead.view','customer.view','message.view','message.send')",
      [role],
    );
    await db.query(
      "insert into public.user_role_assignments(organization_id,user_id,role_id,data_scope) values($1,$2,$3,'OWN_RECORDS')",
      [org, actor, role],
    );
    await db.query(
      'insert into public.user_branch_access(organization_id,user_id,branch_id) values($1,$2,$3)',
      [org, actor, branch],
    );
    await db.query(
      "insert into public.leads(id,organization_id,branch_id,source,customer_name,phone,normalized_phone,assigned_user_id) values($1,$2,$3,'Manual','CRM customer','919876543210','919876543210',$4)",
      [lead, org, branch, actor],
    );
    await db.exec('set session_replication_role=origin');
    const rpc = async (name: string, values: unknown[] = []) =>
      (
        await db.query<{ result: Record<string, unknown> }>(
          `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) result`,
          values,
        )
      ).rows[0].result;
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: 'service_role' }),
    ]);
    const session = await rpc('personal_whatsapp_link_authorize', [actor, org]);
    await rpc('personal_whatsapp_gateway', [
      session.connection_id,
      session.generation,
      worker,
      'acquire',
      '{}',
    ]);
    await rpc('personal_whatsapp_gateway', [
      session.connection_id,
      session.generation,
      worker,
      'connected',
      JSON.stringify({ masked_phone: '*******3210', account_hash: 'a'.repeat(64) }),
    ]);
    await db.query(
      "update public.personal_whatsapp_sessions set linked_at=now()-interval '1 minute'",
    );
    const inbound = await rpc('personal_whatsapp_ingest', [
      session.connection_id,
      session.generation,
      worker,
      JSON.stringify({
        phone: '919876543210',
        provider_message_id: 'FULL-SCHEMA-INBOUND',
        body: 'Hello',
        sent_at: new Date().toISOString(),
      }),
    ]);
    expect(inbound.conversation_id).toBeTruthy();
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: 'authenticated', sub: actor, session_id: browser, aal: 'aal1' }),
    ]);
    await db.exec('set role authenticated');
    expect(await rpc('get_access_context')).toMatchObject({ destination: 'CRM' });
    expect(
      await rpc('get_inbox_conversation_page', ['', 'WHATSAPP_PERSONAL', 1, 25]),
    ).toMatchObject({ total: 1 });
    expect(await rpc('get_inbox_message_page', [inbound.conversation_id])).toMatchObject({
      has_more: false,
    });
    const prepared = await rpc('personal_whatsapp_send_prepare', [
      inbound.conversation_id,
      randomUUID(),
      'Human reply',
    ]);
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: 'service_role' }),
    ]);
    expect(
      await rpc('personal_whatsapp_send_claim', [
        session.connection_id,
        session.generation,
        worker,
        prepared.message_id,
        'FULL-SCHEMA-OUTBOUND',
      ]),
    ).toMatchObject({ body: 'Human reply', phone: '919876543210' });
  } finally {
    await db.close();
  }
}, 120_000);
