/*
 * Exercises every way a Sales lead can reach a booking against the isolated
 * `go-digital-demo-test` tenant, through `quick_book_lead`:
 *
 *   no quotation -> book   (priced in the same save)
 *   DRAFT        -> book   (as saved, and re-priced in the same save)
 *   SENT         -> book
 *   ACCEPTED     -> book
 *
 * plus the refusals that must hold on every path: a discount that needs
 * approval, a quotation already booked, a quotation from another lead, a
 * booking amount above the quotation total, and a role without booking rights.
 * Refusals are checked to leave nothing behind, and a repeated request id is
 * checked to replay the same booking rather than create a second one.
 *
 * Run: pnpm test:demo:combinations
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEMO_DOMAIN = 'demo.go-digital.invalid';
const MARKER = 'Automated lead-flow combination check';

function readEnv() {
  const values = new Map();
  for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const env = readEnv();
const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const anonKey = env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const demoPassword = env.get('DEMO_TEST_PASSWORD');
if (!projectUrl || !anonKey || !demoPassword) {
  throw new Error(
    'SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and DEMO_TEST_PASSWORD are required.',
  );
}

class RpcError extends Error {
  constructor(status, payload) {
    super(`${status} ${JSON.stringify(payload)}`);
    this.code = payload?.message;
  }
}

async function json(response) {
  const body = await response.text();
  const payload = body ? JSON.parse(body) : null;
  if (!response.ok) throw new RpcError(response.status, payload);
  return payload;
}

async function sessionFor(roleKey) {
  const email = `${roleKey.replaceAll('_', '-')}@${DEMO_DOMAIN}`;
  const session = await json(
    await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: demoPassword }),
    }),
  );
  return session.access_token;
}

async function rpc(accessToken, name, body) {
  return json(
    await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

async function rows(accessToken, table, query) {
  return json(
    await fetch(`${projectUrl}/rest/v1/${table}?${new URLSearchParams(query)}`, {
      headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
    }),
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRefusal(code, action) {
  try {
    await action();
  } catch (error) {
    if (error instanceof RpcError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function stage(name, action) {
  await action();
  console.log(`passed: ${name}`);
}

// 5% discount: inside the 10% threshold, so no approval is required.
const pricedItems = (discount = 50_000) => [
  { item_type: 'VEHICLE', description: MARKER, quantity: 1, unit_price: 1_000_000, adjustment: 0 },
  {
    item_type: 'DISCOUNT',
    description: 'Dealer discount',
    quantity: 1,
    unit_price: 0,
    adjustment: -discount,
  },
];

function deliveryDate() {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + 30);
  return value.toISOString().slice(0, 10);
}

async function main() {
  const salesToken = await sessionFor('sales_consultant');
  const telecallerToken = await sessionFor('telecaller_bdc');
  const approverToken = await sessionFor('showroom_manager');
  const salesContext = await rpc(salesToken, 'get_workspace_bootstrap', {});
  assert(salesContext.user_id && salesContext.organization_id, 'sales access context missing');

  const leads = await rows(salesToken, 'leads', {
    select: 'id,customer_id',
    organization_id: `eq.${salesContext.organization_id}`,
    assigned_user_id: `eq.${salesContext.user_id}`,
    customer_id: 'not.is.null',
    deleted_at: 'is.null',
    lifecycle_status: 'neq.Lost',
    order: 'updated_at.desc',
    limit: '2',
  });
  assert(leads.length === 2, 'two customer-linked Sales Consultant demo leads are required');
  const [lead, otherLead] = leads;

  const quotationCount = async () =>
    (
      await rows(salesToken, 'quotations', {
        select: 'id',
        lead_id: `eq.${lead.id}`,
        deleted_at: 'is.null',
      })
    ).length;
  const quickBook = (input) =>
    rpc(salesToken, 'quick_book_lead', {
      target_lead_id: lead.id,
      target_quotation_id: null,
      expected_quotation_version: null,
      target_items: null,
      target_booking_amount: 25_000,
      target_finance_required: false,
      target_exchange_required: false,
      target_expected_delivery_date: deliveryDate(),
      target_request_id: crypto.randomUUID(),
      ...input,
    });
  const saveDraft = (items = pricedItems()) =>
    rpc(salesToken, 'save_quotation', {
      target_quotation_id: null,
      expected_version: null,
      target_lead_id: lead.id,
      target_items: items,
      target_request_id: crypto.randomUUID(),
    });
  const transition = (quotation, status) =>
    rpc(salesToken, 'transition_quotation_status', {
      target_quotation_id: quotation.id,
      expected_version: quotation.version,
      target_status: status,
      change_reason: null,
      target_request_id: crypto.randomUUID(),
    });
  const expectBooked = async (booking) => {
    assert(booking.status === 'CONFIRMED', `booking status was ${booking.status}`);
    const [quotation] = await rows(salesToken, 'quotations', {
      select: 'status',
      id: `eq.${booking.quotation_id}`,
    });
    assert(quotation?.status === 'CONVERTED', `quotation status was ${quotation?.status}`);
  };

  let firstBooking;
  const firstRequestId = crypto.randomUUID();
  await stage('contacted lead -> price and book in one save', async () => {
    firstBooking = await quickBook({
      target_items: pricedItems(),
      target_request_id: firstRequestId,
    });
    await expectBooked(firstBooking);
  });

  await stage('repeated request id replays the same booking', async () => {
    const replay = await quickBook({
      target_items: pricedItems(),
      target_request_id: firstRequestId,
    });
    assert(replay.id === firstBooking.id, 'a repeated request created a second booking');
  });

  await stage('DRAFT quotation -> book as saved', async () => {
    const draft = await saveDraft();
    await expectBooked(
      await quickBook({ target_quotation_id: draft.id, expected_quotation_version: draft.version }),
    );
  });

  await stage('DRAFT quotation -> re-price and book in one save', async () => {
    const draft = await saveDraft();
    await expectBooked(
      await quickBook({
        target_quotation_id: draft.id,
        expected_quotation_version: draft.version,
        target_items: pricedItems(80_000),
      }),
    );
  });

  await stage('SENT quotation -> book', async () => {
    const sent = await transition(await saveDraft(), 'SENT');
    await expectBooked(
      await quickBook({ target_quotation_id: sent.id, expected_quotation_version: sent.version }),
    );
  });

  await stage('ACCEPTED quotation -> book', async () => {
    const accepted = await transition(await transition(await saveDraft(), 'SENT'), 'ACCEPTED');
    await expectBooked(
      await quickBook({
        target_quotation_id: accepted.id,
        expected_quotation_version: accepted.version,
      }),
    );
  });

  await stage('discount above approval threshold is refused and leaves nothing', async () => {
    const before = await quotationCount();
    await expectRefusal('QUOTATION_APPROVAL_REQUIRED', () =>
      quickBook({ target_items: pricedItems(200_000) }),
    );
    assert((await quotationCount()) === before, 'a refused quick booking left a quotation behind');
  });

  await stage(
    'booking amount above the quotation total is refused and leaves nothing',
    async () => {
      const before = await quotationCount();
      await expectRefusal('QUOTATION_NOT_BOOKABLE', () =>
        quickBook({ target_items: pricedItems(), target_booking_amount: 5_000_000 }),
      );
      assert(
        (await quotationCount()) === before,
        'a refused quick booking left a quotation behind',
      );
    },
  );

  await stage('an already booked quotation cannot be booked again', async () => {
    const [quotation] = await rows(salesToken, 'quotations', {
      select: 'id,version',
      id: `eq.${firstBooking.quotation_id}`,
    });
    await expectRefusal('QUOTATION_ALREADY_BOOKED', () =>
      quickBook({
        target_quotation_id: quotation.id,
        expected_quotation_version: quotation.version,
      }),
    );
  });

  await stage("another lead's quotation is refused", async () => {
    const draft = await saveDraft();
    await expectRefusal('QUOTATION_NOT_FOUND', () =>
      rpc(salesToken, 'quick_book_lead', {
        target_lead_id: otherLead.id,
        target_quotation_id: draft.id,
        expected_quotation_version: draft.version,
        target_items: null,
        target_booking_amount: 25_000,
        target_finance_required: false,
        target_exchange_required: false,
        target_expected_delivery_date: deliveryDate(),
        target_request_id: crypto.randomUUID(),
      }),
    );
  });

  await stage('a role without booking rights is refused', async () => {
    await expectRefusal('QUICK_BOOKING_PERMISSION_REQUIRED', () =>
      rpc(telecallerToken, 'quick_book_lead', {
        target_lead_id: lead.id,
        target_quotation_id: null,
        expected_quotation_version: null,
        target_items: pricedItems(),
        target_booking_amount: 25_000,
        target_finance_required: false,
        target_exchange_required: false,
        target_expected_delivery_date: deliveryDate(),
        target_request_id: crypto.randomUUID(),
      }),
    );
  });

  await stage('Lost lead cannot be quoted or booked', async () => {
    const [lostLead] = await rows(salesToken, 'leads', {
      select: 'id',
      organization_id: `eq.${salesContext.organization_id}`,
      assigned_user_id: `eq.${salesContext.user_id}`,
      customer_id: 'not.is.null',
      deleted_at: 'is.null',
      lifecycle_status: 'eq.Lost',
      limit: '1',
    });
    assert(lostLead, 'a customer-linked Lost demo lead is required');
    await expectRefusal('LEAD_IS_LOST', () =>
      rpc(salesToken, 'save_quotation', {
        target_quotation_id: null,
        expected_version: null,
        target_lead_id: lostLead.id,
        target_items: pricedItems(),
        target_request_id: crypto.randomUUID(),
      }),
    );
    await expectRefusal('LEAD_IS_LOST', () =>
      quickBook({ target_lead_id: lostLead.id, target_items: pricedItems() }),
    );
  });

  await stage('rejected and expired quotations cannot be booked', async () => {
    const sent = await transition(await saveDraft(), 'SENT');
    const rejected = await rpc(salesToken, 'transition_quotation_status', {
      target_quotation_id: sent.id,
      expected_version: sent.version,
      target_status: 'REJECTED',
      change_reason: 'Customer chose another vehicle.',
      target_request_id: crypto.randomUUID(),
    });
    await expectRefusal('QUOTATION_NOT_BOOKABLE', () =>
      quickBook({ target_quotation_id: rejected.id, expected_quotation_version: rejected.version }),
    );
    const draft = await saveDraft();
    const expired = await rpc(salesToken, 'transition_quotation_status', {
      target_quotation_id: draft.id,
      expected_version: draft.version,
      target_status: 'EXPIRED',
      change_reason: 'Validity lapsed.',
      target_request_id: crypto.randomUUID(),
    });
    await expectRefusal('QUOTATION_NOT_BOOKABLE', () =>
      quickBook({ target_quotation_id: expired.id, expected_quotation_version: expired.version }),
    );
  });

  await stage('a stale quotation version is refused', async () => {
    const draft = await saveDraft();
    await transition(draft, 'SENT');
    await expectRefusal('QUOTATION_VERSION_CONFLICT', () =>
      quickBook({ target_quotation_id: draft.id, expected_quotation_version: draft.version }),
    );
  });

  await stage('discount approved by a manager can then be booked', async () => {
    const pending = await saveDraft(pricedItems(200_000));
    assert(pending.approval_status === 'PENDING', `approval was ${pending.approval_status}`);
    await expectRefusal('QUOTATION_APPROVAL_REQUIRED', () =>
      quickBook({ target_quotation_id: pending.id, expected_quotation_version: pending.version }),
    );
    await expectRefusal('DISTINCT_APPROVER_REQUIRED', () =>
      rpc(salesToken, 'decide_quotation_approval', {
        target_quotation_id: pending.id,
        expected_version: pending.version,
        target_decision: 'APPROVED',
        decision_comment: null,
        target_request_id: crypto.randomUUID(),
      }),
    );
    const approved = await rpc(approverToken, 'decide_quotation_approval', {
      target_quotation_id: pending.id,
      expected_version: pending.version,
      target_decision: 'APPROVED',
      decision_comment: 'Within showroom authority.',
      target_request_id: crypto.randomUUID(),
    });
    await expectBooked(
      await quickBook({
        target_quotation_id: approved.id,
        expected_quotation_version: approved.version,
      }),
    );
  });

  await stage('simultaneous bookings of one quotation create exactly one booking', async () => {
    const accepted = await transition(await transition(await saveDraft(), 'SENT'), 'ACCEPTED');
    const attempts = await Promise.allSettled(
      [0, 1, 2].map(() =>
        quickBook({
          target_quotation_id: accepted.id,
          expected_quotation_version: accepted.version,
        }),
      ),
    );
    const booked = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const refused = attempts.filter((attempt) => attempt.status === 'rejected');
    assert(booked.length === 1, `${booked.length} concurrent bookings succeeded`);
    for (const attempt of refused)
      assert(
        ['QUOTATION_ALREADY_BOOKED', 'QUOTATION_VERSION_CONFLICT'].includes(attempt.reason.code),
        `unexpected concurrent refusal ${attempt.reason.message}`,
      );
    const bookings = await rows(salesToken, 'bookings', {
      select: 'id',
      quotation_id: `eq.${accepted.id}`,
      deleted_at: 'is.null',
    });
    assert(bookings.length === 1, `${bookings.length} bookings exist for one quotation`);
  });

  await stage('a cancelled booking keeps its quotation from being booked again', async () => {
    const booking = await quickBook({ target_items: pricedItems() });
    // Cancelling needs a reason.
    await expectRefusal('INVALID_BOOKING_TRANSITION', () =>
      rpc(salesToken, 'transition_booking_status', {
        target_booking_id: booking.id,
        expected_version: booking.version,
        target_status: 'CANCELLED',
        change_reason: null,
        target_expected_delivery_date: null,
        target_request_id: crypto.randomUUID(),
      }),
    );
    const cancelled = await rpc(salesToken, 'transition_booking_status', {
      target_booking_id: booking.id,
      expected_version: booking.version,
      target_status: 'CANCELLED',
      change_reason: 'Customer withdrew.',
      target_expected_delivery_date: null,
      target_request_id: crypto.randomUUID(),
    });
    assert(cancelled.status === 'CANCELLED', `booking status was ${cancelled.status}`);
    const [quotation] = await rows(salesToken, 'quotations', {
      select: 'id,version',
      id: `eq.${booking.quotation_id}`,
    });
    await expectRefusal('QUOTATION_ALREADY_BOOKED', () =>
      quickBook({
        target_quotation_id: quotation.id,
        expected_quotation_version: quotation.version,
      }),
    );
  });

  console.log(
    JSON.stringify({ passed: 'lead-flow-combinations', demo_tenant: 'go-digital-demo-test' }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
