import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { expect, it } from 'vitest';

it('applies the pilot and phone matcher after the existing CRM migration history', async () => {
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
      grant usage on schema realtime to authenticated;
      grant select on realtime.messages to authenticated;
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
    await db.exec(
      readFileSync(new URL('202609070203_personal_whatsapp_phone_matching.sql', directory), 'utf8'),
    );
    await db.exec(
      readFileSync(new URL('202609070205_realtime_policy_execution.sql', directory), 'utf8'),
    );
    await db.exec(
      readFileSync(new URL('202609070206_lead_conversation_context.sql', directory), 'utf8'),
    );
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
    const customer = randomUUID(),
      otherLead = randomUUID(),
      unrelatedLead = randomUUID();
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
      "insert into public.permissions(permission_key,module,description) select p,'communications',p from unnest(array['lead.view','customer.view','message.view','message.send','call.view','call.create','followup.view','appointment.view']) p on conflict do nothing",
    );
    await db.query(
      "insert into public.role_permissions select $1,id from public.permissions where permission_key in ('lead.view','customer.view','message.view','message.send','call.view','call.create','followup.view','appointment.view')",
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
      "insert into public.leads(id,organization_id,branch_id,source,customer_name,phone,normalized_phone,assigned_user_id) values($1,$2,$3,'Manual','CRM customer','9876543210','9876543210',$4)",
      [lead, org, branch, actor],
    );
    await db.query(
      "insert into public.customers(id,organization_id,full_name,primary_phone) values($1,$2,'CRM customer','9876543210')",
      [customer, org],
    );
    await db.query('update public.leads set customer_id=$1 where id=$2', [customer, lead]);
    await db.query(
      "insert into public.leads(id,organization_id,branch_id,source,customer_name,phone,normalized_phone,assigned_user_id,customer_id,created_at) values($1,$2,$3,'Manual','CRM customer','9876543210','9876543210',$4,$5,now()-interval '1 day')",
      [otherLead, org, branch, actor, customer],
    );
    await db.query(
      "insert into public.leads(id,organization_id,branch_id,source,customer_name,phone,normalized_phone,assigned_user_id) values($1,$2,$3,'Manual','Someone else','9999999999','9999999999',$4)",
      [unrelatedLead, org, branch, actor],
    );
    for (const activityLead of [lead, otherLead]) {
      await db.query(
        "insert into public.calls(organization_id,branch_id,lead_id,customer_id,assigned_user_id,direction,call_source,started_at,provider_call_id) values($1,$2,$3,$4,$5,'OUTBOUND','PERSONAL_MANUAL',now(),$6)",
        [org, branch, activityLead, customer, actor, randomUUID()],
      );
      await db.query(
        "insert into public.appointments(organization_id,branch_id,lead_id,customer_id,assigned_user_id,appointment_type,scheduled_at) values($1,$2,$3,$4,$5,'Showroom visit',now())",
        [org, branch, activityLead, customer, actor],
      );
      await db.query(
        "insert into public.followups(organization_id,branch_id,lead_id,customer_id,assigned_user_id,reason,due_at) select $1,$2,$3,$4,$5,'Lead follow-up',now()+i*interval '1 minute' from generate_series(1,30) i",
        [org, branch, activityLead, customer, actor],
      );
    }
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
    await db.query(
      "insert into realtime.messages(id,extension,topic,private) values(1,'broadcast',$1,true)",
      [`organization:${org}:communications`],
    );
    await db.exec('set role authenticated');
    expect(await rpc('get_access_context')).toMatchObject({ destination: 'CRM' });
    await db.query("select set_config('realtime.topic',$1,false)", [
      `organization:${org}:communications`,
    ]);
    expect(
      (
        await db.query<{ allowed: boolean }>(
          'select exists(select 1 from realtime.messages where id=1) allowed',
        )
      ).rows[0].allowed,
    ).toBe(true);
    // Exercise RLS as the subscriber, including private helpers in other branches.
    await db.query('select id from realtime.messages limit 1');
    await db.query("select set_config('realtime.topic',$1,false)", [
      `organization:${randomUUID()}:communications`,
    ]);
    expect(
      (
        await db.query<{ allowed: boolean }>(
          'select exists(select 1 from realtime.messages where id=1) allowed',
        )
      ).rows[0].allowed,
    ).toBe(false);
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
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: 'authenticated', sub: actor, session_id: browser, aal: 'aal1' }),
    ]);
    await db.exec('set role authenticated');
    expect(await rpc('get_context_inbox_page', [null, customer])).toMatchObject({ total: 1 });
    // A new enquiry can select an existing customer chat before it has messages.
    expect(await rpc('get_context_inbox_page', [otherLead])).toMatchObject({ total: 1 });
    const before = await rpc('get_context_inbox_messages', [inbound.conversation_id, lead]);
    expect(before.records).toHaveLength(2);
    expect(await rpc('get_inbox_lead_options', [inbound.conversation_id])).toHaveLength(2);
    await expect(
      rpc('set_inbox_working_lead', [inbound.conversation_id, unrelatedLead, lead]),
    ).rejects.toThrow('LEAD_CONTEXT_DENIED');
    await rpc('set_inbox_working_lead', [inbound.conversation_id, otherLead, lead]);
    await expect(
      rpc('set_inbox_working_lead', [inbound.conversation_id, lead, lead]),
    ).rejects.toThrow('LEAD_CONTEXT_CHANGED');
    await expect(
      rpc('personal_whatsapp_send_for_lead', [
        inbound.conversation_id,
        randomUUID(),
        'Stale reply',
        lead,
      ]),
    ).rejects.toThrow('LEAD_CONTEXT_CHANGED');
    expect(
      (await rpc('get_context_inbox_messages', [inbound.conversation_id, lead])).records,
    ).toHaveLength(2);
    expect(
      (await rpc('get_context_inbox_messages', [inbound.conversation_id, otherLead])).records,
    ).toHaveLength(0);
    expect(await rpc('get_context_inbox_page', [lead])).toMatchObject({ total: 1 });
    for (const kind of ['calls', 'appointments']) {
      expect(await rpc('get_lead_activity_page', [lead, kind])).toMatchObject({ total: 1 });
    }
    const followupPage = await rpc('get_lead_activity_page', [lead, 'followups']);
    expect(followupPage.total).toBe(30);
    expect(followupPage.records).toHaveLength(25);
    const followupNext = await rpc('get_lead_activity_page', [lead, 'followups', 2]);
    expect(followupNext.records).toHaveLength(5);
    const firstIds = (followupPage.records as Array<{ id: string }>).map((row) => row.id);
    expect(
      (followupNext.records as Array<{ id: string }>).some((row) => firstIds.includes(row.id)),
    ).toBe(false);
    expect(await rpc('get_lead_telecmi_call_options', [lead])).toMatchObject({
      lead_id: lead,
      connections: [],
    });
    await db.exec('reset role');
    await expect(
      db.query('update public.personal_whatsapp_messages set lead_id=$1 where id=$2', [
        otherLead,
        prepared.message_id,
      ]),
    ).rejects.toThrow('MESSAGE_LEAD_IMMUTABLE');
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: 'service_role' }),
    ]);
    // Future incoming messages follow the saved working lead, not the latest lead.
    for (let i = 0; i < 27; i++) {
      await rpc('personal_whatsapp_ingest', [
        session.connection_id,
        session.generation,
        worker,
        JSON.stringify({
          phone: '919876543210',
          provider_message_id: `CONTEXT-${i}`,
          body: `Page message ${i}`,
          sent_at: new Date(Date.now() + i).toISOString(),
        }),
      ]);
    }
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: 'authenticated', sub: actor, session_id: browser, aal: 'aal1' }),
    ]);
    await db.exec('set role authenticated');
    const firstPage = await rpc('get_context_inbox_messages', [inbound.conversation_id, otherLead]);
    expect(firstPage.records).toHaveLength(25);
    expect(firstPage.has_more).toBe(true);
    const nextPage = await rpc('get_context_inbox_messages', [
      inbound.conversation_id,
      otherLead,
      firstPage.next_before_at,
      firstPage.next_before_id,
    ]);
    expect(nextPage.records).toHaveLength(2);
    expect(nextPage.has_more).toBe(false);
    const ids = [
      ...(firstPage.records as Array<{ id: string }>),
      ...(nextPage.records as Array<{ id: string }>),
    ].map((row) => row.id);
    expect(new Set(ids).size).toBe(27);
    expect(
      (await rpc('get_context_inbox_messages', [inbound.conversation_id, lead])).records,
    ).toHaveLength(2);
    await expect(rpc('get_context_inbox_messages', [randomUUID()])).rejects.toThrow(
      'CONVERSATION_NOT_FOUND',
    );
    await expect(rpc('get_context_inbox_page', [randomUUID()])).rejects.toThrow('LEAD_NOT_FOUND');
    // Official channels use the same immutable message attribution and CAS check.
    await db.exec('reset role; set session_replication_role=replica');
    const officialConnection = randomUUID(),
      officialConversation = randomUUID();
    await db.query(
      "insert into public.connected_accounts(id,organization_id,provider_key,display_name,scope_mode,status) values($1,$2,'whatsapp_cloud','Official','ALL_BRANCHES','CONNECTED')",
      [officialConnection, org],
    );
    await db.query(
      "insert into public.conversations(id,organization_id,branch_id,lead_id,customer_id,connection_id,channel,assigned_user_id) values($1,$2,$3,$4,$5,$6,'WHATSAPP_BUSINESS',$7)",
      [officialConversation, org, branch, lead, customer, officialConnection, actor],
    );
    await db.exec('set session_replication_role=origin');
    const officialMessage = randomUUID();
    await db.query(
      "insert into public.conversation_messages(id,organization_id,conversation_id,direction,sent_at,metadata) values($1,$2,$3,'OUTBOUND',now(),$4)",
      [officialMessage, org, officialConversation, JSON.stringify({ expected_lead_id: lead })],
    );
    await db.exec('set role authenticated');
    await rpc('set_inbox_working_lead', [officialConversation, otherLead, lead]);
    expect(
      (await rpc('get_context_inbox_messages', [officialConversation, lead])).records,
    ).toHaveLength(1);
    expect(
      (await rpc('get_context_inbox_messages', [officialConversation, otherLead])).records,
    ).toHaveLength(0);
    await db.exec('reset role');
    await expect(
      db.query(
        "insert into public.conversation_messages(organization_id,conversation_id,direction,sent_at,metadata) values($1,$2,'OUTBOUND',now(),$3)",
        [org, officialConversation, JSON.stringify({ expected_lead_id: lead })],
      ),
    ).rejects.toThrow('LEAD_CONTEXT_CHANGED');
    await expect(
      db.query('update public.conversation_messages set lead_id=$1 where id=$2', [
        otherLead,
        officialMessage,
      ]),
    ).rejects.toThrow('MESSAGE_LEAD_IMMUTABLE');
    await db.exec('set session_replication_role=replica');
    await db.query(
      "insert into public.conversations(organization_id,branch_id,lead_id,customer_id,connection_id,channel,assigned_user_id) select $1,$2,$3,$4,$5,'WHATSAPP_BUSINESS',$6 from generate_series(1,26)",
      [org, branch, lead, customer, officialConnection, actor],
    );
    await db.exec('set session_replication_role=origin; set role authenticated');
    const threads = await rpc('get_context_inbox_page', [
      null,
      customer,
      '',
      'WHATSAPP_BUSINESS',
      1,
      25,
    ]);
    const moreThreads = await rpc('get_context_inbox_page', [
      null,
      customer,
      '',
      'WHATSAPP_BUSINESS',
      2,
      25,
    ]);
    expect(threads.total).toBe(27);
    expect(threads.records).toHaveLength(25);
    expect(moreThreads.records).toHaveLength(2);
    const threadIds = [
      ...(threads.records as Array<{ id: string }>),
      ...(moreThreads.records as Array<{ id: string }>),
    ].map((row) => row.id);
    expect(new Set(threadIds).size).toBe(27);
  } finally {
    await db.close();
  }
}, 120_000);
