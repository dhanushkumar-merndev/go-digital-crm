import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const org = '00000000-0000-0000-0000-000000000001';
const actor = '00000000-0000-0000-0000-000000000002';
const branch = '00000000-0000-0000-0000-000000000003';
const other = '00000000-0000-0000-0000-000000000004';
const lead = '00000000-0000-0000-0000-000000000005';
let db: PGlite;
async function report(days = 7, timezone = 'Asia/Kolkata') {
  const { rows } = await db.query<{
    result: {
      kpis: Record<string, number>;
      daily: Record<string, number>[];
      targets: Record<string, number>;
    };
  }>('select get_telecaller_performance($1,$2) as result', [days, timezone]);
  return rows[0].result;
}

describe('Telecaller activity performance', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql as $$ select '${actor}'::uuid $$;
      create function public.get_access_context() returns jsonb language sql as $$
        select jsonb_build_object('destination', 'CRM', 'role_key', coalesce(nullif(current_setting('test.role',true),''),'telecaller'),
          'data_scope','OWN_RECORDS','organization_id','${org}') $$;
      create function app_private.has_permission(uuid,text) returns boolean language sql as $$
        select $2 is distinct from current_setting('test.denied',true) $$;
      create function app_private.sales_consultant_allowed_branches(uuid) returns uuid[] language sql as $$ select array['${branch}'::uuid] $$;
      create table leads(id uuid primary key, organization_id uuid default '${org}', branch_id uuid default '${branch}',
        assigned_user_id uuid default '${actor}', created_at timestamptz default now()-interval '1 hour', deleted_at timestamptz);
      create table calls(id uuid default gen_random_uuid(), organization_id uuid default '${org}', branch_id uuid default '${branch}',
        assigned_user_id uuid default '${actor}', lead_id uuid, started_at timestamptz default now()-interval '30 minutes', outcome text default 'CONNECTED', duration_seconds integer default 60);
      create table activities(id uuid default gen_random_uuid(), organization_id uuid default '${org}', actor_id uuid default '${actor}',
        lead_id uuid, activity_type text, metadata jsonb default '{}', occurred_at timestamptz default now()-interval '20 minutes');
      create table lead_stage_history(id uuid default gen_random_uuid(), organization_id uuid default '${org}', changed_by uuid default '${actor}',
        lead_id uuid, to_status text, created_at timestamptz default now()-interval '20 minutes');
      create table lead_assignment_history(id uuid default gen_random_uuid(), organization_id uuid default '${org}', branch_id uuid default '${branch}',
        lead_id uuid, previous_owner_id uuid, new_owner_id uuid, created_at timestamptz default now()-interval '20 minutes');
      create table followups(id uuid primary key, organization_id uuid default '${org}', branch_id uuid default '${branch}',
        assigned_user_id uuid default '${actor}', status text default 'COMPLETED', completed_at timestamptz default now()-interval '20 minutes');
      create table targets(id uuid default gen_random_uuid(), organization_id uuid default '${org}', branch_id uuid,
        user_id uuid default '${actor}', metric text, target_value numeric, period_start date, period_end date, created_at timestamptz default now());
    `);
    await db.exec(
      readFileSync('supabase/migrations/202609160015_telecaller_performance_activity.sql', 'utf8'),
    );
  }, 30_000);
  beforeEach(async () => {
    await db.exec(`truncate leads, calls, activities, lead_stage_history, lead_assignment_history, followups, targets;
      select set_config('test.role','',false),set_config('test.denied','',false);
      insert into leads(id) values('${lead}');`);
  });
  afterAll(async () => db?.close());

  it('keeps assignments and contact credit after a sales handoff', async () => {
    await db.exec(`
      insert into calls(lead_id) values('${lead}'),('${lead}');
      insert into lead_stage_history(lead_id,to_status) values('${lead}','Contacted'),('${lead}','Qualified'),('${lead}','Transferred to Sales');
      insert into activities(lead_id,activity_type) values('${lead}','TELECALLER_CONTACTED');
      insert into lead_assignment_history(lead_id,previous_owner_id,new_owner_id) values('${lead}','${actor}','${other}');
      update leads set assigned_user_id='${other}';`);
    const result = await report();
    expect(result.kpis).toMatchObject({
      leads: 1,
      contacted: 1,
      calls: 2,
      connected_calls: 2,
      talk_seconds: 120,
      qualified: 1,
      transferred: 1,
    });
    expect(result.daily).toHaveLength(7);
    expect(result.daily.reduce((n, d) => n + d.calls, 0)).toBe(2);
    expect(result.daily.reduce((n, d) => n + d.transferred, 0)).toBe(1);
  });

  it('counts work on old leads by activity date and deduplicates reassignment', async () => {
    await db.exec(`update leads set created_at=now()-interval '90 days';
      insert into calls(lead_id) values('${lead}');
      insert into lead_assignment_history(lead_id,new_owner_id) values('${lead}','${actor}'),('${lead}','${actor}');`);
    expect((await report()).kpis).toMatchObject({ leads: 1, contacted: 1, calls: 1 });
  });

  it('credits follow-up completion to the actor, excluding manager completions', async () => {
    await db.exec(`insert into followups(id,assigned_user_id) values('${lead}','${other}'),('${other}','${actor}');
      insert into activities(activity_type,metadata) values('FOLLOWUP_COMPLETED','{"followup_id":"${lead}"}');
      insert into activities(actor_id,activity_type,metadata) values('${other}','FOLLOWUP_COMPLETED','{"followup_id":"${other}"}');`);
    const result = await report();
    expect(result.kpis.followups_completed).toBe(1);
    expect(result.daily.reduce((n, d) => n + d.followups_completed, 0)).toBe(1);
  });

  it('excludes other actors, tenants, branches, future and out-of-period activity', async () => {
    await db.exec(`insert into calls(lead_id,assigned_user_id) values('${lead}','${other}');
      insert into calls(organization_id) values('${other}');
      insert into calls(branch_id) values('${other}');
      insert into calls(started_at) values(now()-interval '40 days'),(now()+interval '1 hour');
      insert into lead_stage_history(lead_id,to_status,changed_by) values('${lead}','Transferred to Sales','${other}');
      insert into activities(lead_id,activity_type,actor_id) values('${lead}','TELECALLER_CONTACTED','${other}');`);
    expect((await report()).kpis).toMatchObject({ calls: 0, contacted: 0, transferred: 0 });
  });

  it('uses IST calendar boundaries and excludes non-connected duration', async () => {
    await db.exec(`insert into calls(lead_id,started_at) values
      ('${lead}',(timezone('Asia/Kolkata',now())::date-6)::timestamp at time zone 'Asia/Kolkata'),
      ('${lead}',((timezone('Asia/Kolkata',now())::date-6)::timestamp at time zone 'Asia/Kolkata')-interval '1 second');
      insert into calls(lead_id,outcome,duration_seconds) values('${lead}','NO_ANSWER',30);`);
    const result = await report();
    expect(result.kpis).toMatchObject({ calls: 2, connected_calls: 1, talk_seconds: 60 });
    expect(result.daily[0].calls).toBe(1);
  });

  it('compares only targets with matching dates and permitted scope', async () => {
    await db.exec(`insert into targets(metric,target_value,period_start,period_end) values
      ('calls',10,timezone('Asia/Kolkata',now())::date-6,timezone('Asia/Kolkata',now())::date),
      ('contacted',300,timezone('Asia/Kolkata',now())::date-29,timezone('Asia/Kolkata',now())::date);
      insert into targets(metric,target_value,period_start,period_end,branch_id) values
      ('transferred',99,timezone('Asia/Kolkata',now())::date-6,timezone('Asia/Kolkata',now())::date,'${other}');`);
    expect((await report()).targets).toEqual({ calls: 10 });
    expect((await report(30)).targets).toEqual({ contacted: 300 });
  });

  it('fails closed for invalid roles, missing lead permission and invalid parameters', async () => {
    await db.exec("select set_config('test.role','sales-consultant',false)");
    await expect(report()).rejects.toThrow('PERSONAL_PERFORMANCE_ACCESS_REQUIRED');
    await db.exec(
      "select set_config('test.role','',false),set_config('test.denied','lead.view',false)",
    );
    await expect(report()).rejects.toThrow('LEAD_VIEW_PERMISSION_REQUIRED');
    await expect(report(8)).rejects.toThrow('INVALID_PERFORMANCE_QUERY');
    await expect(report(7, 'invalid')).rejects.toThrow('INVALID_PERFORMANCE_QUERY');
  });
});
