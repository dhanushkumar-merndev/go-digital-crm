import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const org = randomUUID(),
  actor = randomUUID();
let db: PGlite;
async function begin(
  agentId = '601_33338826',
  phone: string | null = '919876543219',
  request = randomUUID(),
) {
  const result = await db.query<{
    result: { claimed: boolean; status: string; request_id: string };
  }>('select public.begin_telecmi_agent_removal($1,$2,$3,$4,$5,$6) as result', [
    org,
    '33338826',
    agentId,
    phone,
    actor,
    request,
  ]);
  return result.rows[0].result;
}
async function finish(request: string, status: string) {
  await db.query('select public.finish_telecmi_agent_removal($1,$2,$3,$4,$5)', [
    org,
    request,
    actor,
    status,
    null,
  ]);
}
async function save(agentId: string, phone: string) {
  return db.query(
    `insert into connected_accounts(organization_id,provider_key,external_account_id,connection_config)
    values($1,'telecmi','33338826',$2::jsonb)`,
    [org, JSON.stringify({ parallel_agents: [{ user_id: agentId, phone }] })],
  );
}
describe('TeleCMI agent removal claims', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema app_private;
      create function auth.role() returns text language sql as $$select current_setting('request.test_role',true)$$;
      create function app_private.telecmi_actor_is_client_admin(uuid,uuid) returns boolean language sql as
        $$select current_setting('request.test_allowed',true) = 'true'$$;
      create table organizations(id uuid primary key);
      create table connected_accounts(id uuid primary key default gen_random_uuid(),organization_id uuid not null,
        provider_key text not null,external_account_id text,connection_config jsonb not null,deleted_at timestamptz);
      create table audit_logs(organization_id uuid,actor_id uuid,action text,resource_type text,
        resource_id text,request_id uuid,metadata jsonb);
    `);
    await db.exec(
      readFileSync('supabase/migrations/202610080601_telecmi_agent_availability.sql', 'utf8'),
    );
    await db.exec(
      readFileSync('supabase/migrations/202610080701_telecmi_agent_removal.sql', 'utf8'),
    );
    await db.query('insert into organizations(id) values($1)', [org]);
  }, 30_000);
  beforeEach(async () => {
    await db.exec(
      "begin; select set_config('request.test_role','service_role',false); select set_config('request.test_allowed','true',false)",
    );
  });
  afterEach(async () => {
    await db.exec('rollback');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('refuses removal of an agent mapped by ID or normalized phone', async () => {
    await save('101_33338826', '919876543210');
    await expect(begin('101_33338826', null)).rejects.toThrow('TELECMI_AGENT_IN_USE');
  });
  it('refuses removal when the mobile is already mapped under a different agent', async () => {
    await save('101_33338826', '919876543210');
    await expect(begin('601_33338826', '+91 98765 43210')).rejects.toThrow('TELECMI_AGENT_IN_USE');
  });
  it('protects an agent used as the account default', async () => {
    await db.query(
      `insert into connected_accounts(organization_id,provider_key,external_account_id,connection_config)
      values($1,'telecmi','33338826','{"default_user_id":"601_33338826"}')`,
      [org],
    );
    await expect(begin()).rejects.toThrow('TELECMI_AGENT_IN_USE');
  });
  it('blocks assignments while a removal is pending', async () => {
    const claim = await begin();
    expect(claim.claimed).toBe(true);
    await expect(save('601_33338826', '919876543219')).rejects.toThrow(
      'TELECMI_AGENT_REMOVAL_IN_PROGRESS',
    );
  });
  it('blocks a stale assignment after removal completes and records the actor and outcome', async () => {
    const claim = await begin();
    await finish(claim.request_id, 'COMPLETED');
    const audits = await db.query<{ action: string; actor_id: string }>(
      'select action,actor_id from audit_logs order by action',
    );
    expect(audits.rows).toEqual([
      { action: 'integration.telecmi_agent_removal_completed', actor_id: actor },
      { action: 'integration.telecmi_agent_removal_started', actor_id: actor },
    ]);
    await expect(save('601_33338826', '919876543219')).rejects.toThrow(
      'TELECMI_AGENT_REMOVAL_IN_PROGRESS',
    );
  });
  it('releases the claim if the provider rejects the removal', async () => {
    const claim = await begin();
    await finish(claim.request_id, 'FAILED');
    await save('601_33338826', '919876543219');
  });
  it('allows mapping an extension that was successfully recreated in TeleCMI', async () => {
    const claim = await begin();
    await finish(claim.request_id, 'COMPLETED');
    await db.query('select public.record_telecmi_agent_recreated($1,$2,$3)', [
      org,
      '601_33338826',
      actor,
    ]);
    await save('601_33338826', '919876543219');
  });
  it('keeps completed removal protection after the request lease expires', async () => {
    const claim = await begin();
    await finish(claim.request_id, 'COMPLETED');
    await db.query(
      "update telecmi_agent_removal_requests set lease_expires_at=now()-interval '1 hour' where id=$1",
      [claim.request_id],
    );
    await expect(save('601_33338826', '919876543219')).rejects.toThrow(
      'TELECMI_AGENT_REMOVAL_IN_PROGRESS',
    );
  });
  it('does not reserve a new agent if creation succeeds before the old removal completion write', async () => {
    const claim = await begin();
    await db.query('select public.record_telecmi_agent_recreated($1,$2,$3)', [
      org,
      '601_33338826',
      actor,
    ]);
    await finish(claim.request_id, 'COMPLETED');
    await save('601_33338826', '919876543219');
  });
  it.each([true, false])(
    'reconciles an uncertain expired request from a fresh provider list (exists=%s)',
    async (exists) => {
      const claim = await begin();
      await db.query(
        "update telecmi_agent_removal_requests set lease_expires_at=now()-interval '1 minute' where id=$1",
        [claim.request_id],
      );
      await db.query('select public.reconcile_telecmi_agent_removals($1,$2,$3,$4,now())', [
        org,
        '33338826',
        exists ? ['601_33338826'] : [],
        actor,
      ]);
      const outcome = await db.query<{ status: string }>(
        'select status from telecmi_agent_removal_requests where id=$1',
        [claim.request_id],
      );
      expect(outcome.rows[0].status).toBe(exists ? 'FAILED' : 'COMPLETED');
      if (exists) await save('601_33338826', '919876543219');
      else
        await expect(save('601_33338826', '919876543219')).rejects.toThrow(
          'TELECMI_AGENT_REMOVAL_IN_PROGRESS',
        );
    },
  );
  it('does not reconcile an operation while its request lease is active', async () => {
    const claim = await begin();
    await db.query('select public.reconcile_telecmi_agent_removals($1,$2,$3,$4,now())', [
      org,
      '33338826',
      [],
      actor,
    ]);
    const outcome = await db.query<{ status: string }>(
      'select status from telecmi_agent_removal_requests where id=$1',
      [claim.request_id],
    );
    expect(outcome.rows[0].status).toBe('PENDING');
  });
  it('rejects mapping an agent reserved as another connection default', async () => {
    await db.query(
      `insert into connected_accounts(organization_id,provider_key,external_account_id,connection_config)
      values($1,'telecmi','33338826','{"default_user_id":"601_33338826"}')`,
      [org],
    );
    await expect(save('601_33338826', '919876543219')).rejects.toThrow(
      'TELECMI_AGENT_MAPPING_CONFLICT',
    );
  });
  it('allows a replacement agent on a new extension with the removed agent mobile', async () => {
    const claim = await begin();
    await finish(claim.request_id, 'COMPLETED');
    await save('602_33338826', '919876543219');
  });
  it('does not reconcile from an observation that started before the lease expired', async () => {
    const claim = await begin();
    await db.query(
      "update telecmi_agent_removal_requests set lease_expires_at=now()-interval '1 minute' where id=$1",
      [claim.request_id],
    );
    await db.query(
      "select public.reconcile_telecmi_agent_removals($1,$2,$3,$4,now()-interval '2 minutes')",
      [org, '33338826', ['601_33338826'], actor],
    );
    const outcome = await db.query<{ status: string }>(
      'select status from telecmi_agent_removal_requests where id=$1',
      [claim.request_id],
    );
    expect(outcome.rows[0].status).toBe('PENDING');
  });
  it('replays a completed request without deleting another agent', async () => {
    const request = randomUUID();
    await begin(undefined, undefined, request);
    await finish(request, 'COMPLETED');
    expect(await begin(undefined, undefined, request)).toMatchObject({
      claimed: false,
      status: 'COMPLETED',
    });
    await expect(begin('602_33338826', '919876543218', request)).rejects.toThrow(
      'REQUEST_ID_CONFLICT',
    );
  });
  it('refuses an agent from a different app', async () => {
    await expect(begin('601_2223012')).rejects.toThrow('INVALID_TELECMI_AGENT_REMOVAL');
  });
  it('rechecks Client Admin authority in the database', async () => {
    await db.exec("select set_config('request.test_allowed','false',false)");
    await expect(begin()).rejects.toThrow('CLIENT_ADMIN_REQUIRED');
  });
});
