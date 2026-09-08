import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { expect, it } from 'vitest';

it('applies sharing, pricing and comparison migrations after the full CRM history', async () => {
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
    for (const file of readdirSync(directory)
      .filter(
        (file) => file.endsWith('.sql') && file <= '202609080006_vehicle_specs_ai_comparison.sql',
      )
      .sort()) {
      try {
        await db.exec(
          readFileSync(new URL(file, directory), 'utf8').replace(/\bconcurrently\b/gi, ''),
        );
      } catch (error) {
        throw new Error(file + ': ' + (error as Error).message);
      }
    }
    const result = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('authenticated','public.begin_vehicle_comparison_ai(uuid,uuid,uuid,uuid)','execute') allowed",
    );
    expect(result.rows[0].allowed).toBe(false);
  } finally {
    await db.close();
  }
}, 120000);
