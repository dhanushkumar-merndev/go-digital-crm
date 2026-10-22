import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

const source = (file: string) => readFileSync(file, 'utf8');
const org = randomUUID();
const quotation = randomUUID();
const lead = randomUUID();
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
  await db.exec(`
    create table public.quotations (
      id uuid primary key, organization_id uuid, branch_id uuid, team_id uuid,
      customer_id uuid, lead_id uuid, assigned_user_id uuid, version bigint,
      status text, total_amount numeric, updated_at timestamptz
    );
    create table public.bookings (
      id uuid primary key default gen_random_uuid(), organization_id uuid,
      branch_id uuid, team_id uuid, customer_id uuid, lead_id uuid, quotation_id uuid,
      assigned_user_id uuid, booking_number text, status text, booking_amount numeric,
      total_value numeric, finance_required boolean, exchange_required boolean,
      expected_delivery_date date, version bigint, deleted_at timestamptz
    );
    create table public.booking_status_history (
      organization_id uuid, booking_id uuid, from_status text, to_status text,
      changed_by uuid, reason text
    );
    create table public.lead_stage_history (
      organization_id uuid, lead_id uuid, from_status text, to_status text,
      changed_by uuid, reason text
    );
    create function app_private.sales_request_fingerprint(jsonb) returns text
      language sql as $$ select $1::text $$;
    create function app_private.replay_sales_request(uuid,text,uuid,text) returns jsonb
      language sql as $$ select null::jsonb $$;
  `);
  const workspace = source('supabase/migrations/202608150024_quotation_booking_workspace.sql');
  const bookingFunction = workspace.match(
    /create or replace function public\.create_booking_from_quotation\([\s\S]*?\n\$\$;/,
  )![0];
  const lostMigration = source(
    'supabase/migrations/202609280002_lost_lead_blocks_quotation_and_booking.sql',
  );
  // Evaluate the deployed migration's own anchor and guard, then apply them to
  // the real booking function. Only identity/replay helpers are test fixtures.
  const anchor = lostMigration.match(/booking_anchor constant text :=([\s\S]*?);\n/)![1];
  const guard = lostMigration.match(/booking_guard constant text :=([\s\S]*?);\n/)![1];
  const patch = await db.query<{ anchor: string; guard: string }>(
    `select ${anchor} as anchor, ${guard} as guard`,
  );
  await db.exec(
    bookingFunction.replace(patch.rows[0].anchor, patch.rows[0].anchor + patch.rows[0].guard),
  );
  await db.exec(source('supabase/migrations/202610221900_booking_lost_guard_alias.sql'));
  await db.query('insert into organizations(id) values($1)', [org]);
  const actor = randomUUID();
  await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: actor, role: 'authenticated' }),
  ]);
  await db.query(
    "insert into leads(id,organization_id,assigned_user_id,lifecycle_status) values($1,$2,$3,'Lost')",
    [lead, org, actor],
  );
  await db.query(
    `insert into quotations(id,organization_id,lead_id,assigned_user_id,version,status,total_amount)
     values($1,$2,$3,$4,1,'ACCEPTED',100000)`,
    [quotation, org, lead, actor],
  );
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('begin');
});

afterEach(async () => {
  await db.exec('rollback');
});

const book = () =>
  db.query('select public.create_booking_from_quotation($1,1,1000,false,false,null,$2)', [
    quotation,
    randomUUID(),
  ]);

it('refuses a lost lead with the domain error before writing a booking', async () => {
  await db.exec('savepoint lost_booking');
  await expect(book()).rejects.toMatchObject({ code: '23514', message: 'LEAD_IS_LOST' });
  await db.exec('rollback to savepoint lost_booking');
  expect((await db.query('select id from bookings')).rows).toEqual([]);
});

it('books an active lead and records its quotation conversion and audit', async () => {
  await db.query("update leads set lifecycle_status='Transferred to Sales' where id=$1", [lead]);
  await book();
  expect((await db.query('select status from quotations where id=$1', [quotation])).rows).toEqual([
    { status: 'CONVERTED' },
  ]);
  expect((await db.query('select action from audit_logs')).rows).toEqual([
    { action: 'booking.created' },
  ]);
});
