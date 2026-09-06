import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
let db: PGlite;

async function claims(user: string, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role, aal: 'aal2' }),
  ]);
}
async function grant(amount: number, kind = 'AI') {
  await db.query(
    `insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id,reason)
     values($1,$2::public.credit_ledger_kind,'GRANT',$3,$4,'seed')`,
    [org, kind, amount, `grant:${randomUUID()}`],
  );
}
async function balance(kind = 'AI') {
  const row = await db.query<{ balance: string }>(
    'select balance from credit_balances where organization_id=$1 and ledger_kind=$2::public.credit_ledger_kind',
    [org, kind],
  );
  return row.rows.length ? Number(row.rows[0].balance) : null;
}
function consume(amount: number, key: string, kind = 'AI') {
  return db.query<{ ledger_id: string; balance: string }>(
    `select * from public.consume_credits($1,$2::public.credit_ledger_kind,$3,'bulk_send',$4,'test')`,
    [org, kind, amount, key],
  );
}
async function ledgerSum(kind = 'AI') {
  const row = await db.query<{ total: string }>(
    'select coalesce(sum(amount),0) as total from credit_ledger where organization_id=$1 and ledger_kind=$2::public.credit_ledger_kind',
    [org, kind],
  );
  return Number(row.rows[0].total);
}

describe('credit balance rollup', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/credit-balance-base.sql'));
    // Pre-existing history must survive the migration that introduces the rollup.
    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query(
      "insert into credit_ledger(organization_id,ledger_kind,transaction_type,amount,reference_id,reason) values($1,'AI','GRANT',500,'legacy','seeded before rollup')",
      [org],
    );
    await db.exec(source('supabase/migrations/202609060007_credit_balance_rollup.sql'));
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
    await claims(actor);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('backfills the balance from ledger history that predates it', async () => {
    expect(await balance()).toBe(500);
  });

  it('keeps the maintained total equal to the ledger it derives from', async () => {
    await grant(250);
    await consume(100, `k:${randomUUID()}`);
    expect(await balance()).toBe(await ledgerSum());
  });

  it('returns the balance after the consumption, not before it', async () => {
    const result = await consume(120, `k:${randomUUID()}`);
    expect(Number(result.rows[0].balance)).toBe(380);
    expect(await balance()).toBe(380);
  });

  it('still refuses to overspend', async () => {
    await expect(consume(10_000, `k:${randomUUID()}`)).rejects.toThrow(/INSUFFICIENT_CREDITS/);
  });

  it('keeps idempotency: a repeated key neither double-charges nor errors', async () => {
    const key = `k:${randomUUID()}`;
    const first = await consume(50, key);
    const second = await consume(50, key);
    expect(second.rows[0].ledger_id).toBe(first.rows[0].ledger_id);
    expect(await balance()).toBe(450);
    expect(await balance()).toBe(await ledgerSum());
  });

  it('rejects a reused key carrying a different amount', async () => {
    const key = `k:${randomUUID()}`;
    await consume(50, key);
    await expect(consume(75, key)).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
  });

  it('tracks each ledger kind separately', async () => {
    await grant(90, 'TRACKING');
    await consume(40, `k:${randomUUID()}`, 'TRACKING');
    expect(await balance('TRACKING')).toBe(50);
    expect(await balance('AI')).toBe(500);
  });

  it('serves reservations from the same maintained total', async () => {
    await claims(actor, 'service_role');
    const reservation = await db.query<{ reserve_ai_credits: string }>(
      "select public.reserve_ai_credits($1,$2,'ai_image_generation',$3)",
      [org, 200, `ref:${randomUUID()}`],
    );
    expect(reservation.rows[0].reserve_ai_credits).toBeTruthy();
    expect(await balance()).toBe(300);
    expect(await balance()).toBe(await ledgerSum());
  });

  it('refuses a reservation larger than the balance', async () => {
    await claims(actor, 'service_role');
    await expect(
      db.query("select public.reserve_ai_credits($1,$2,'f',$3)", [org, 9_999, `r:${randomUUID()}`]),
    ).rejects.toThrow(/INSUFFICIENT_CREDITS/);
  });

  it('can rebuild itself from the ledger if it ever drifts', async () => {
    await db.query('update credit_balances set balance=-1 where organization_id=$1', [org]);
    await claims(actor, 'service_role');
    await db.query('select public.rebuild_credit_balances()');
    expect(await balance()).toBe(await ledgerSum());
  });

  it('keeps the rebuild off limits to ordinary callers', async () => {
    await expect(db.query('select public.rebuild_credit_balances()')).rejects.toThrow(
      /SERVICE_ROLE_REQUIRED/,
    );
  });
});
