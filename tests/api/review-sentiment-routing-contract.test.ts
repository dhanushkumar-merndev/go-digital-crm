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
  });
});
