import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const org = randomUUID(),
  owner = randomUUID(),
  manager = randomUUID(),
  branch = randomUUID(),
  team = randomUUID(),
  customer = randomUUID(),
  lead = randomUUID(),
  role = randomUUID(),
  field = randomUUID();
const now = '2026-09-07T04:30:00Z';
let db: PGlite;
async function dispatch(batch = 200, at = now) {
  return (
    await db.query<{ result: { lead_sla: number; customer_dates: number } }>(
      'select public.dispatch_crm_alerts($1,$2) as result',
      [batch, at],
    )
  ).rows[0].result;
}
async function claims(user = owner, role = 'service_role') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role }),
  ]);
}

describe('scheduled customer date and five-minute lead alerts', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    // Identity helpers are fixtures; the dispatch, permission predicate, indexes,
    // notification inserts and configuration RPC below run unchanged PostgreSQL.
    await db.exec(`
      alter table leads add column first_contacted_at timestamptz;
      create table calls(id uuid primary key default gen_random_uuid(),organization_id uuid,lead_id uuid,started_at timestamptz,deleted_at timestamptz);
      create table teams(id uuid primary key,organization_id uuid,branch_id uuid,manager_id uuid,active boolean default true);
      create table team_members(organization_id uuid,team_id uuid,user_id uuid,member_type text,active boolean default true);
      create table roles(id uuid primary key,organization_id uuid);
      create table permissions(id uuid primary key default gen_random_uuid(),permission_key text);
      create table role_permissions(role_id uuid,permission_id uuid);
      create table user_role_assignments(organization_id uuid,user_id uuid,role_id uuid,data_scope text,scope_branch_id uuid,selected_branch_ids uuid[] default '{}',active boolean default true);
      create function app_private.has_organization_wide_scope(org uuid) returns boolean language sql stable as $$select true$$;
    `);
    const core = source('supabase/migrations/202608140001_core.sql');
    for (const table of ['custom_field_definitions', 'custom_field_values']) {
      await db.exec(
        core.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`))![0],
      );
    }
    const modules = source('supabase/migrations/202608140002_business_modules.sql');
    await db.exec(modules.match(/create table public\.notifications \([\s\S]*?\n\);/)![0]);
    await db.exec(source('supabase/migrations/202608220023_custom_field_administration.sql'));
    await db.exec(source('supabase/migrations/202609070103_customer_date_and_lead_sla_alerts.sql'));
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$3),($2,$3)', [
      owner,
      manager,
      org,
    ]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query(
      'insert into teams(id,organization_id,branch_id,manager_id) values($1,$2,$3,$4)',
      [team, org, branch, manager],
    );
    await db.query(
      "insert into team_members(organization_id,team_id,user_id,member_type) values($1,$2,$3,'TELECALLER_BDC'),($1,$2,$4,'TEAM_MANAGER')",
      [org, team, owner, manager],
    );
    await db.query('insert into roles(id,organization_id) values($1,$2)', [role, org]);
    await db.exec("insert into permissions(permission_key) values('lead.view'),('customer.view')");
    await db.query(
      'insert into role_permissions(role_id,permission_id) select $1,id from permissions',
      [role],
    );
    await db.query(
      "insert into user_role_assignments(organization_id,user_id,role_id,data_scope) values($1,$2,$4,'OWN_RECORDS'),($1,$3,$4,'OWN_TEAM')",
      [org, owner, manager, role],
    );
    await db.query(
      "insert into customers(id,organization_id,full_name) values($1,$2,'Test customer')",
      [customer, org],
    );
    await db.query(
      "insert into leads(id,organization_id,branch_id,team_id,customer_id,assigned_user_id,created_at) values($1,$2,$3,$4,$5,$6,'2026-09-07T04:24:00Z')",
      [lead, org, branch, team, customer, owner],
    );
    await db.query(
      "insert into custom_field_definitions(id,organization_id,module,field_key,label,field_type) values($1,$2,'CUSTOMERS','date_of_birth','Birthday','DATE')",
      [field, org],
    );
    await db.query(
      "insert into custom_field_values(organization_id,definition_id,resource_type,resource_id,value) values($1,$2,'CUSTOMER',$3,'\"1990-09-07\"')",
      [org, field, customer],
    );
  }, 30000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims();
  });
  afterEach(async () => {
    await db.exec('rollback;reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('alerts the lead owner and manager at five minutes, and the customer owner on their birthday', async () => {
    expect(await dispatch()).toEqual({ lead_sla: 2, customer_dates: 1 });
    const rows = await db.query<{ user_id: string }>(
      "select user_id from notifications where event_type='LEAD_FIVE_MINUTE_SLA'",
    );
    expect(rows.rows.map((row) => row.user_id).sort()).toEqual([owner, manager].sort());
  });
  it('is idempotent across worker retries and marking a notification read', async () => {
    await dispatch();
    await db.exec('update notifications set read_at=now()');
    expect(await dispatch()).toEqual({ lead_sla: 0, customer_dates: 0 });
  });
  it('does not alert before five minutes', async () => {
    expect((await dispatch(200, '2026-09-07T04:28:59Z')).lead_sla).toBe(0);
  });
  it('suppresses the lead alert after a logged call', async () => {
    await db.query('insert into calls(organization_id,lead_id,started_at) values($1,$2,$3)', [
      org,
      lead,
      now,
    ]);
    expect((await dispatch()).lead_sla).toBe(0);
  });
  it('suppresses the lead alert after contact or lifecycle progress', async () => {
    await db.query(
      "update leads set first_contacted_at=$1,lifecycle_status='Contacted' where id=$2",
      [now, lead],
    );
    expect((await dispatch()).lead_sla).toBe(0);
  });
  it('sends no notifications after recipient permissions are revoked', async () => {
    await db.exec('delete from role_permissions');
    expect(await dispatch()).toEqual({ lead_sla: 0, customer_dates: 0 });
  });
  it('sends no notifications to inactive users or suspended tenants', async () => {
    await db.query("update organizations set status='SUSPENDED' where id=$1", [org]);
    expect(await dispatch()).toEqual({ lead_sla: 0, customer_dates: 0 });
  });
  it('respects branch scope even for a team member', async () => {
    await db.query("update user_role_assignments set data_scope='ONE_BRANCH',scope_branch_id=$1", [
      randomUUID(),
    ]);
    expect(await dispatch()).toEqual({ lead_sla: 0, customer_dates: 0 });
  });
  it('does not leak a reminder through a foreign-tenant role assignment', async () => {
    await db.query('update user_role_assignments set organization_id=$1', [randomUUID()]);
    expect(await dispatch()).toEqual({ lead_sla: 0, customer_dates: 0 });
  });
  it('ignores malformed and future date values', async () => {
    await db.query('update custom_field_values set value=\'"2026-02-30"\'');
    expect((await dispatch(200, '2026-02-28T04:30:00Z')).customer_dates).toBe(0);
  });
  it('handles leap-day dates only on leap day', async () => {
    await db.query('update custom_field_values set value=\'"2000-02-29"\'');
    expect((await dispatch(200, '2028-02-29T04:30:00Z')).customer_dates).toBe(1);
  });
  it('uses the dealership day in India at the UTC day boundary', async () => {
    expect((await dispatch(200, '2026-09-06T19:00:00Z')).customer_dates).toBe(1);
  });
  it('honours per-field disable and accepts custom annual date fields', async () => {
    await db.query(
      "update custom_field_definitions set field_key='ownership_anniversary',label='Ownership anniversary' where id=$1",
      [field],
    );
    await claims(owner, 'authenticated');
    await db.query('select public.set_customer_date_reminder($1,false,1)', [field]);
    await claims();
    expect((await dispatch()).customer_dates).toBe(0);
    await claims(owner, 'authenticated');
    await db.query('select public.set_customer_date_reminder($1,true,2)', [field]);
    await claims();
    expect((await dispatch()).customer_dates).toBe(1);
  });
  it('bounds each pass and makes progress on the next pass', async () => {
    expect((await dispatch(1)).lead_sla).toBe(1);
    expect((await dispatch(1)).lead_sla).toBe(1);
    expect((await dispatch(1)).lead_sla).toBe(0);
  });
  it('denies worker dispatch to signed-in users', async () => {
    await claims(owner, 'authenticated');
    await expect(dispatch()).rejects.toThrow('SERVICE_ROLE_REQUIRED');
  });

  it('does not change the lifecycle while reporting an SLA breach', async () => {
    await dispatch();
    expect((await db.query('select lifecycle_status from leads where id=$1', [lead])).rows).toEqual(
      [{ lifecycle_status: 'New' }],
    );
  });
  it('does not treat a future call time as an already completed call attempt', async () => {
    await db.query(
      "insert into calls(organization_id,lead_id,started_at) values($1,$2,'2026-09-08T04:30:00Z')",
      [org, lead],
    );
    expect((await dispatch()).lead_sla).toBe(2);
  });
  it('does not notify for dates that have not happened yet', async () => {
    await db.query('update custom_field_values set value=\'"2027-09-07"\'');
    expect((await dispatch()).customer_dates).toBe(0);
  });
  it('ignores deactivated customer date fields', async () => {
    await db.query('update custom_field_definitions set active=false where id=$1', [field]);
    expect((await dispatch()).customer_dates).toBe(0);
  });
  it('suppresses recipients whose account has been deactivated', async () => {
    await db.query('update profiles set active=false where id=$1', [owner]);
    expect(await dispatch()).toEqual({ lead_sla: 1, customer_dates: 0 });
  });
  it('rejects a stale reminder-setting edit', async () => {
    await claims(owner, 'authenticated');
    await expect(
      db.query('select public.set_customer_date_reminder($1,false,2)', [field]),
    ).rejects.toThrow('CUSTOM_FIELD_VERSION_CONFLICT');
  });
  it('rejects a foreign-tenant reminder-setting edit', async () => {
    const otherOrg = randomUUID(),
      otherActor = randomUUID();
    await db.query('insert into organizations(id) values($1)', [otherOrg]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [
      otherActor,
      otherOrg,
    ]);
    await claims(otherActor, 'authenticated');
    await expect(
      db.query('select public.set_customer_date_reminder($1,false,1)', [field]),
    ).rejects.toThrow('CUSTOM_FIELD_NOT_FOUND');
  });
});
