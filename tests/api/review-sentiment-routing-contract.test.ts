import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const org = randomUUID();
const actor = randomUUID();
const branch = randomUUID();
const customer = randomUUID();
const booking = randomUUID();
const delivery = randomUUID();
let db: PGlite;

async function claims(user: string, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, role, aal: 'aal2' }),
  ]);
}

async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []) {
  const result = await db.query<{ result: T }>(
    `select public.${name}(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`,
    values,
  );
  return result.rows[0].result;
}

describe('review sentiment routing contract', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(source('tests/api/fixtures/drip-dispatch-base.sql'));
    await db.exec(`
      create table if not exists public.bookings (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        customer_id uuid not null references public.customers(id)
      );
      create table if not exists public.delivery_cases (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        branch_id uuid not null references public.branches(id),
        booking_id uuid not null references public.bookings(id),
        customer_id uuid not null references public.customers(id),
        status text not null default 'DELIVERED'
      );
      create table if not exists public.feedback_requests (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        branch_id uuid not null references public.branches(id),
        customer_id uuid not null references public.customers(id),
        booking_id uuid references public.bookings(id),
        channel text not null default 'WHATSAPP',
        status text not null default 'PENDING',
        sent_at timestamptz,
        completed_at timestamptz,
        rating smallint check (rating between 1 and 5),
        comments text,
        created_at timestamptz not null default now()
      );
      create table if not exists public.complaints (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        branch_id uuid not null references public.branches(id),
        customer_id uuid not null references public.customers(id),
        booking_id uuid references public.bookings(id),
        assigned_user_id uuid references public.profiles(id),
        category text not null,
        description text not null,
        priority text not null,
        status text not null default 'OPEN',
        resolution text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await db.exec(source('supabase/migrations/202609060014_review_sentiment_routing.sql'));
    await db.exec(`
      alter table public.delivery_cases add column assigned_user_id uuid, add column deleted_at timestamptz;
      alter table public.feedback_requests add column delivery_case_id uuid,
        add column customer_case_id uuid, add column version bigint not null default 1,
        add column updated_at timestamptz not null default now();
      alter table public.complaints add column customer_case_id uuid;
      create table public.customer_care_cases (
        id uuid primary key, organization_id uuid not null references organizations(id),
        branch_id uuid not null references branches(id), customer_id uuid not null references customers(id),
        booking_id uuid references bookings(id), case_number text not null, case_type text not null,
        priority text not null, status text not null, subject text not null, description text not null,
        sla_due_at timestamptz not null, created_by uuid not null references profiles(id),
        assigned_user_id uuid references profiles(id), deleted_at timestamptz
      );
    `);
    await db.exec(source('supabase/migrations/202609070102_feedback_access_and_completion.sql'));

    await db.query('insert into organizations(id) values($1)', [org]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [actor, org]);
    await db.query('insert into branches(id,organization_id) values($1,$2)', [branch, org]);
    await db.query('insert into customers(id,organization_id,full_name) values($1,$2,$3)', [
      customer,
      org,
      'Feedback Customer',
    ]);
    await db.query('insert into bookings(id,organization_id,customer_id) values($1,$2,$3)', [
      booking,
      org,
      customer,
    ]);
    await db.query(
      'insert into delivery_cases(id,organization_id,branch_id,booking_id,customer_id) values($1,$2,$3,$4,$5)',
      [delivery, org, branch, booking, customer],
    );
    await db.query('update delivery_cases set assigned_user_id=$1 where id=$2', [actor, delivery]);
    await db.query(
      'insert into leads(id,organization_id,branch_id,customer_id,assigned_user_id) values($1,$2,$3,$4,$5)',
      [randomUUID(), org, branch, customer, actor],
    );
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

  it('routes 5-star positive review to configured Google review URL', async () => {
    await rpc('set_organization_google_review_url', ['https://g.page/r/dealership-test/review']);

    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'WHATSAPP',
    ]);

    expect(req.feedback_id).toBeDefined();

    const response = await rpc<{
      outcome: string;
      redirect_review_url: string;
      rating: number;
    }>('submit_customer_feedback', [req.feedback_id, 5, 'Superb delivery experience!']);

    expect(response.outcome).toBe('POSITIVE_REVIEW');
    expect(response.rating).toBe(5);
    expect(response.redirect_review_url).toBe('https://g.page/r/dealership-test/review');
  });

  it('automatically creates a high-priority complaint ticket for ratings 3 or lower', async () => {
    const fbId = randomUUID();
    await db.query(
      'insert into feedback_requests(id,organization_id,branch_id,customer_id,booking_id,channel) values($1,$2,$3,$4,$5,$6)',
      [fbId, org, branch, customer, booking, 'SMS'],
    );

    const response = await rpc<{
      outcome: string;
      complaint_id: string;
      rating: number;
    }>('submit_customer_feedback', [
      fbId,
      2,
      'Car delivered with dirty mats and delayed by 2 hours',
    ]);

    expect(response.outcome).toBe('DETRACTOR_ESCALATED');
    expect(response.rating).toBe(2);
    expect(response.complaint_id).toBeDefined();

    const complaint = await db.query<{ priority: string; status: string; category: string }>(
      'select priority, status, category from complaints where id = $1',
      [response.complaint_id],
    );

    expect(complaint.rows).toHaveLength(1);
    expect(complaint.rows[0].priority).toBe('HIGH');
    expect(complaint.rows[0].status).toBe('OPEN');
    expect(complaint.rows[0].category).toBe('DELIVERY_FEEDBACK');
    const cases = await db.query('select case_type, status, priority from customer_care_cases');
    expect(cases.rows).toEqual([{ case_type: 'COMPLAINT', status: 'NEW', priority: 'HIGH' }]);
  });

  it('keeps unsent requests pending and repeats the request without creating another one', async () => {
    const first = await rpc<{ feedback_id: string; status: string }>(
      'trigger_delivery_feedback_request',
      [delivery, 'WHATSAPP'],
    );
    const second = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'WHATSAPP',
    ]);
    expect(first.status).toBe('PENDING');
    expect(second.feedback_id).toBe(first.feedback_id);
    expect((await db.query('select sent_at from feedback_requests')).rows).toEqual([
      { sent_at: null },
    ]);
  });

  it('routes the table transition used by delivery capture even without the standalone RPC', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    await db.query(
      "update feedback_requests set rating=1,status='COMPLETED',comments='Damaged seat' where id=$1",
      [req.feedback_id],
    );
    expect((await db.query('select id from customer_care_cases')).rows).toHaveLength(1);
    expect((await db.query('select source_feedback_id from complaints')).rows).toEqual([
      { source_feedback_id: req.feedback_id },
    ]);
    expect(
      (await db.query("select id from activities where activity_type='FEEDBACK_COMPLAINT_CREATED'"))
        .rows,
    ).toHaveLength(1);
  });

  it('does not duplicate complaints when a response is submitted twice', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    const first = await rpc<{ complaint_id: string }>('submit_customer_feedback', [
      req.feedback_id,
      2,
      'Late handover',
    ]);
    const second = await rpc<{ complaint_id: string }>('submit_customer_feedback', [
      req.feedback_id,
      2,
      'Late handover',
    ]);
    expect(second.complaint_id).toBe(first.complaint_id);
    expect((await db.query('select id from complaints')).rows).toHaveLength(1);
  });

  it('rejects rewriting a completed rating', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    await rpc('submit_customer_feedback', [req.feedback_id, 5, 'Good']);
    await expect(rpc('submit_customer_feedback', [req.feedback_id, 1, 'Changed'])).rejects.toThrow(
      'FEEDBACK_ALREADY_COMPLETED',
    );
  });

  it('rejects null ratings', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    await expect(rpc('submit_customer_feedback', [req.feedback_id, null, 'Null'])).rejects.toThrow(
      'INVALID_RATING_VALUE',
    );
  });

  it('denies another dealership access to a known feedback UUID', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    const foreignOrg = randomUUID(),
      foreignActor = randomUUID();
    await db.query('insert into organizations(id) values($1)', [foreignOrg]);
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [
      foreignActor,
      foreignOrg,
    ]);
    await claims(foreignActor);
    await expect(rpc('submit_customer_feedback', [req.feedback_id, 1, 'Foreign'])).rejects.toThrow(
      'FEEDBACK_REQUEST_NOT_FOUND',
    );
  });

  it('denies a user outside the customer scope', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    const other = randomUUID();
    await db.query('insert into profiles(id,organization_id) values($1,$2)', [other, org]);
    await claims(other);
    await expect(
      rpc('submit_customer_feedback', [req.feedback_id, 1, 'Outside scope']),
    ).rejects.toThrow('FEEDBACK_SCOPE_DENIED');
  });

  it('denies anonymous submission even when a feedback UUID is known', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    await db.exec('set role anon');
    await expect(
      rpc('submit_customer_feedback', [req.feedback_id, 1, 'Anonymous']),
    ).rejects.toThrow(/permission denied/);
  });

  it('denies branch access when permission is revoked', async () => {
    const req = await rpc<{ feedback_id: string }>('trigger_delivery_feedback_request', [
      delivery,
      'MANUAL',
    ]);
    await db.exec(
      'create or replace function app_private.can_access_branch(org uuid,branch uuid) returns boolean language sql stable as $$select false$$',
    );
    await expect(
      rpc('submit_customer_feedback', [req.feedback_id, 1, 'Wrong branch']),
    ).rejects.toThrow('FEEDBACK_SCOPE_DENIED');
  });
});
