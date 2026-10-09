/*
 * Seed one showcase customer whose lead has every field the CRM can hold filled
 * in, so a demo walk-through can open Customer 360 and the lead detail and see
 * what each section looks like populated rather than empty.
 *
 * The customer carries: contacts, two addresses, two owned vehicles, every
 * CUSTOMER_PERSONAL / CUSTOMER_FAMILY / CUSTOMER_FINANCE custom field, and the
 * vehicle-requirement / budget / exchange details as additional fields (those
 * have no dedicated columns, so they live where Edit customer writes them).
 *
 * The current lead walks the whole sales journey: intake, telecaller contact,
 * qualification, handoff to the demo Sales Consultant, calls with an AI
 * summary, a completed showroom visit, a completed test drive with feedback, a
 * revised quotation, a confirmed booking with an accepted exchange, an open
 * follow-up and task, notes, and the matching timeline. An earlier lost
 * enquiry on the same customer shows the one-customer, many-leads model.
 *
 * Not seeded: conversations (need a connected WhatsApp/Meta account, which
 * the demo tenant deliberately has none of) and documents (need a real Tigris
 * object behind the metadata row).
 *
 * The showcase is keyed on its external lead id. Re-running reports the
 * existing records instead of creating a second copy.
 *
 * Run: pnpm seed:demo:full-profile-lead
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEMO_SLUG = 'go-digital-demo-test';
const DEMO_DOMAIN = 'demo.go-digital.invalid';
const SALES_CONSULTANT_EMAIL = `sales-consultant@${DEMO_DOMAIN}`;
const TELECALLER_EMAIL = `telecaller-bdc@${DEMO_DOMAIN}`;
const CLIENT_ADMIN_EMAIL = `client-admin@${DEMO_DOMAIN}`;
const EXCHANGE_EMAIL = `exchange-executive@${DEMO_DOMAIN}`;
const BRANCH_CODE = 'BLR-01';
const TEAM_NAME = 'Demo Sales Team';
const SHOWCASE_LEAD_ID = 'demo-full-profile-showcase-current';
const PREVIOUS_LEAD_ID = 'demo-full-profile-showcase-previous';
const QUOTATION_NUMBER = 'DEMO-Q-FULL-0001';
const BOOKING_NUMBER = 'DEMO-B-FULL-0001';
const FIXTURE_MARKER = 'Full-profile showcase lead';

const customerProfile = {
  fullName: 'Amit Sharma',
  phone: '+91 9845012345',
  normalizedPhone: '+919845012345',
  alternatePhone: '+91 9999912345',
  email: `amit.sharma@${DEMO_DOMAIN}`,
  workEmail: `amit.sharma.work@${DEMO_DOMAIN}`,
};

/** Mirrors `app_private.customer_field_template`; see seed-demo-customer-personalisation.mjs. */
const fieldTemplates = [
  ['date_of_birth', 'Date of birth', 'DATE', []],
  ['wedding_anniversary', 'Wedding anniversary', 'DATE', []],
  ['spouse_name', 'Spouse name', 'TEXT', []],
  ['occupation', 'Occupation', 'TEXT', []],
  [
    'preferred_language',
    'Preferred language',
    'SELECT',
    ['English', 'Hindi', 'Kannada', 'Tamil', 'Telugu', 'Malayalam', 'Marathi'],
  ],
  [
    'preferred_contact_time',
    'Best time to call',
    'SELECT',
    ['Morning', 'Afternoon', 'Evening', 'Weekend only'],
  ],
  ['family_size', 'Family size', 'NUMBER', []],
  ['children_count', 'Children', 'NUMBER', []],
  ['household_vehicles', 'Vehicles in household', 'NUMBER', []],
  [
    'primary_use',
    'Primary use',
    'SELECT',
    ['Family', 'Personal commute', 'Business', 'Commercial'],
  ],
  [
    'income_band',
    'Annual income band',
    'SELECT',
    ['Under 5L', '5L - 10L', '10L - 20L', '20L - 50L', 'Above 50L'],
  ],
  ['preferred_bank', 'Preferred bank', 'TEXT', []],
  ['existing_loan', 'Has an existing vehicle loan', 'BOOLEAN', []],
  ['gst_number', 'GST number', 'TEXT', []],
];

const customFieldValues = {
  date_of_birth: '1987-06-18',
  wedding_anniversary: '2014-02-09',
  spouse_name: 'Neha Sharma',
  occupation: 'Product manager, IT services',
  preferred_language: 'Hindi',
  preferred_contact_time: 'Evening',
  family_size: 4,
  children_count: 2,
  household_vehicles: 2,
  primary_use: 'Family',
  income_band: '20L - 50L',
  preferred_bank: 'HDFC Bank',
  existing_loan: false,
  gst_number: '29ABCPS1234K1Z5',
};

/**
 * Genuinely ad-hoc facts. Vehicle requirement, budget and exchange details have
 * structured homes (`lead_requirements`, `customer_vehicles`), written by
 * `ensureStructuredProfile`.
 */
const additionalFields = [['Referral', 'Colleague who bought a Nexon from this showroom']].map(
  ([label, value]) => ({ label, value }),
);

/** The labels an earlier version of this script wrote into additional fields. */
const legacyAdditionalLabels = new Set([
  'Interested variant',
  'Fuel type',
  'Transmission',
  'Colour preference',
  'Delivery timeline',
  'Usage',
  'Budget range',
  'Preferred brand',
  'Purchase type',
  'Financing',
  'Exchange preference',
  'Insurance preference',
  'RTO preference',
  'Preferred dealer services',
  'Test drive required',
  'Competitors considered',
  'Exchange vehicle KMs driven',
  'Exchange expected value',
]);

const showcaseRequirements = {
  variant: 'Creative S DCA',
  fuel_type: 'Petrol',
  transmission: 'DCA / DCT',
  colour_preference: 'Pristine White / Daytona Grey',
  usage: 'Family use, weekend highway trips',
  delivery_timeline: 'Within 1 month',
  purchase_timeline: 'Within 1 month',
  budget_min: 1_800_000,
  budget_max: 2_000_000,
  preferred_brand: 'Tata',
  purchase_type: 'Personal',
  finance_required: true,
  finance_note: 'Loan for 80% of on-road, 5 years',
  exchange_required: true,
  expected_exchange_value: 480_000,
  insurance_preference: 'Comprehensive with zero depreciation',
  rto_preference: 'Bengaluru (Indiranagar RTO)',
  preferred_services: ['Home delivery', 'Extended warranty'],
  test_drive_required: true,
  competitors: ['Hyundai Creta', 'Kia Seltos'],
};

const showcaseVehicleDetails = {
  KA03MN4521: {
    fuel_type: 'Petrol',
    transmission: 'Manual',
    odometer_km: 48_500,
    ownership: 'First owner',
    purchase_year: 2018,
  },
  KA51AB9087: {
    fuel_type: 'Petrol',
    transmission: 'CVT',
    odometer_km: 21_000,
    ownership: 'First owner',
    purchase_year: 2021,
  },
};

function readEnv() {
  const values = new Map();
  for (const line of fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const env = readEnv();
const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
const remoteSeedAllowed = env.get('DEMO_ALLOW_REMOTE_SEED') === 'true';
const allowedProjectRef = env.get('DEMO_ALLOWED_SUPABASE_PROJECT_REF')?.trim();

if (!process.argv.includes('--apply')) {
  console.error(
    'Refusing to write the showcase lead. Re-run with --apply after confirming the isolated demo project.',
  );
  process.exit(1);
}
if (!projectUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
let projectHostname;
try {
  projectHostname = new URL(projectUrl).hostname;
} catch {
  projectHostname = undefined;
}
if (
  !remoteSeedAllowed ||
  !allowedProjectRef ||
  !/^[a-z]{20}$/.test(allowedProjectRef) ||
  projectHostname !== `${allowedProjectRef}.supabase.co`
) {
  console.error(
    'Remote demo seed blocked. Set DEMO_ALLOW_REMOTE_SEED=true and make DEMO_ALLOWED_SUPABASE_PROJECT_REF match SUPABASE_URL for an isolated dev/staging project.',
  );
  process.exit(1);
}

const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  'content-type': 'application/json',
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok)
    throw new Error(
      `${options.method ?? 'GET'} ${url.slice(0, 200)}: ${response.status} ${JSON.stringify(payload)}`,
    );
  return payload;
}

function restUrl(table, query = {}) {
  const search = new URLSearchParams(query);
  return `${projectUrl}/rest/v1/${table}${search.size ? `?${search}` : ''}`;
}

const select = (table, query) => request(restUrl(table, query));

async function insert(table, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return [];
  return request(restUrl(table), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(list),
  });
}

async function patch(table, query, body) {
  return request(restUrl(table, query), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
}

async function insertOne(table, row) {
  const [created] = await insert(table, row);
  return created;
}

async function first(table, query, errorMessage) {
  const rows = await select(table, { ...query, limit: '1' });
  if (rows.length !== 1) throw new Error(errorMessage);
  return rows[0];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
/** A timestamp `days` before now, offset by `hours`. */
const ago = (days, hours = 0) => new Date(now - days * DAY + hours * HOUR).toISOString();
/** Tomorrow at a fixed India time, so the open follow-up always reads as upcoming. */
function tomorrowIst(hour, minute = 0) {
  const ist = new Date(now + 5.5 * HOUR + DAY);
  ist.setUTCHours(hour, minute, 0, 0);
  return new Date(ist.getTime() - 5.5 * HOUR).toISOString();
}

async function profileId(organizationId, email, { optional = false } = {}) {
  const rows = await select('profiles', {
    select: 'id',
    organization_id: `eq.${organizationId}`,
    email: `eq.${email}`,
    active: 'eq.true',
    deleted_at: 'is.null',
    limit: '1',
  });
  if (rows.length === 1) return rows[0].id;
  if (optional) return null;
  throw new Error(`Demo user ${email} is missing or inactive. Run pnpm seed:demo:remote first.`);
}

async function resolveTarget() {
  const organization = await first(
    'organizations',
    { select: 'id', slug: `eq.${DEMO_SLUG}` },
    'The isolated demo tenant is missing. Run pnpm seed:demo:remote first.',
  );
  const organizationId = organization.id;
  const branch = await first(
    'branches',
    { select: 'id', organization_id: `eq.${organizationId}`, code: `eq.${BRANCH_CODE}` },
    'The demo branch is missing.',
  );
  const team = await first(
    'teams',
    {
      select: 'id',
      organization_id: `eq.${organizationId}`,
      branch_id: `eq.${branch.id}`,
      name: `eq.${TEAM_NAME}`,
      active: 'eq.true',
    },
    'The demo sales team is missing or inactive.',
  );
  const salesConsultantId = await profileId(organizationId, SALES_CONSULTANT_EMAIL);
  const clientAdminId = await profileId(organizationId, CLIENT_ADMIN_EMAIL);
  // The intake call and fresh assignment read best under a Telecaller, but the
  // showcase still works if that demo user was removed.
  const telecallerId =
    (await profileId(organizationId, TELECALLER_EMAIL, { optional: true })) ?? salesConsultantId;
  const exchangeUserId = await profileId(organizationId, EXCHANGE_EMAIL, { optional: true });
  return {
    organizationId,
    branchId: branch.id,
    teamId: team.id,
    salesConsultantId,
    clientAdminId,
    telecallerId,
    exchangeUserId,
  };
}

async function ensureFieldDefinitions(target) {
  const existing = await select('custom_field_definitions', {
    select: 'id,field_key',
    organization_id: `eq.${target.organizationId}`,
    module: 'eq.CUSTOMERS',
  });
  const byKey = new Map(existing.map((row) => [row.field_key, row.id]));
  const created = await insert(
    'custom_field_definitions',
    fieldTemplates
      .filter(([key]) => !byKey.has(key))
      .map(([field_key, label, field_type, options]) => ({
        organization_id: target.organizationId,
        module: 'CUSTOMERS',
        field_key,
        label,
        field_type,
        options,
        required: false,
        active: true,
        version: 1,
      })),
  );
  for (const row of created) byKey.set(row.field_key, row.id);
  return { byKey, created: created.length };
}

async function findExisting(target) {
  const [lead] = await select('leads', {
    select: 'id,customer_id,created_at,next_followup_at',
    organization_id: `eq.${target.organizationId}`,
    external_lead_id: `eq.${SHOWCASE_LEAD_ID}`,
    deleted_at: 'is.null',
    limit: '1',
  });
  if (lead) return lead;
  // The REST inserts are not one transaction. A customer without its lead means
  // an earlier run stopped part-way; recreating would leave two Amit Sharmas.
  const customers = await select('customers', {
    select: 'id',
    organization_id: `eq.${target.organizationId}`,
    primary_email: `eq.${customerProfile.email}`,
    deleted_at: 'is.null',
  });
  if (customers.length > 0)
    throw new Error(
      `Showcase customer ${customers[0].id} exists without its lead — an earlier run stopped part-way. Soft-delete it before re-running.`,
    );
  return null;
}

async function main() {
  const target = await resolveTarget();
  const existing = await findExisting(target);
  if (existing) return resumeOrReport(target, existing);

  const definitions = await ensureFieldDefinitions(target);
  const { organizationId: org, branchId, teamId } = target;
  const sc = target.salesConsultantId;
  const tc = target.telecallerId;
  const scope = { organization_id: org, branch_id: branchId, team_id: teamId };

  // --- Customer and profile ------------------------------------------------
  const createdAt = ago(9, -2);
  const customer = await insertOne('customers', {
    organization_id: org,
    full_name: customerProfile.fullName,
    primary_phone: customerProfile.phone,
    normalized_phone: customerProfile.normalizedPhone,
    primary_email: customerProfile.email,
    additional_fields: additionalFields,
    created_by: target.clientAdminId,
    created_at: ago(400),
    updated_at: ago(1),
  });
  const customerId = customer.id;

  await insert(
    'customer_contacts',
    [
      ['PHONE', customerProfile.phone, true],
      ['PHONE', customerProfile.alternatePhone, false],
      ['EMAIL', customerProfile.email, true],
      ['EMAIL', customerProfile.workEmail, false],
    ].map(([type, value, is_primary]) => ({
      organization_id: org,
      customer_id: customerId,
      type,
      value,
      // Phone identifiers are matched on digits only, emails on lower case.
      normalized_value: type === 'PHONE' ? value.replace(/\D/g, '') : value.toLowerCase(),
      is_primary,
    })),
  );

  await insert('customer_addresses', [
    {
      organization_id: org,
      customer_id: customerId,
      address_type: 'HOME',
      address: {
        line1: 'Flat 1204, Prestige Shantiniketan',
        line2: 'Whitefield Main Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postal_code: '560048',
        country: 'India',
      },
    },
    {
      organization_id: org,
      customer_id: customerId,
      address_type: 'OFFICE',
      address: {
        line1: 'Tower B, Embassy Tech Village',
        line2: 'Outer Ring Road, Devarabisanahalli',
        city: 'Bengaluru',
        state: 'Karnataka',
        postal_code: '560103',
        country: 'India',
      },
    },
  ]);

  const [swift] = await insert('customer_vehicles', [
    {
      organization_id: org,
      customer_id: customerId,
      registration: 'KA03MN4521',
      normalized_registration: 'KA03MN4521',
      brand: 'Maruti Suzuki',
      model: 'Swift',
      variant: 'ZXi',
      model_year: 2018,
    },
    {
      organization_id: org,
      customer_id: customerId,
      registration: 'KA51AB9087',
      normalized_registration: 'KA51AB9087',
      brand: 'Honda',
      model: 'Amaze',
      variant: 'VX CVT',
      model_year: 2021,
    },
  ]);

  await insert(
    'custom_field_values',
    Object.entries(customFieldValues).map(([key, value]) => ({
      organization_id: org,
      definition_id: definitions.byKey.get(key),
      resource_type: 'CUSTOMER',
      resource_id: customerId,
      value,
    })),
  );

  // --- Earlier lost enquiry on the same customer -----------------------------
  const previousLead = await insertOne('leads', {
    ...scope,
    customer_id: customerId,
    source: 'Website',
    source_detail: `${FIXTURE_MARKER} — earlier enquiry`,
    campaign: 'Nexon EV website enquiry form',
    external_lead_id: PREVIOUS_LEAD_ID,
    raw_payload: { demo_fixture: true, fixture: PREVIOUS_LEAD_ID },
    customer_name: customerProfile.fullName,
    phone: customerProfile.phone,
    normalized_phone: customerProfile.normalizedPhone,
    email: customerProfile.email,
    interested_model: 'Nexon EV',
    lifecycle_status: 'Lost',
    temperature: 'COLD',
    assigned_user_id: tc,
    first_contacted_at: ago(399),
    sla_due_at: ago(399),
    lost_reason: 'Purchase deferred — customer postponed buying by a year',
    created_at: ago(400),
    updated_at: ago(392),
  });
  await insert(
    'lead_stage_history',
    [
      ['New', 'Contacted', ago(399), 'First call connected'],
      ['Contacted', 'Lost', ago(392), 'Customer postponed the purchase'],
    ].map(([from_status, to_status, created_at, reason]) => ({
      organization_id: org,
      lead_id: previousLead.id,
      from_status,
      to_status,
      changed_by: tc,
      reason,
      created_at,
    })),
  );

  // --- Current lead ----------------------------------------------------------
  const followupDueAt = tomorrowIst(11);
  const lead = await insertOne('leads', {
    ...scope,
    customer_id: customerId,
    source: 'Facebook',
    source_detail: `${FIXTURE_MARKER} — Meta Lead Ads form`,
    campaign: 'Curvv Festive Offer — Bengaluru',
    external_lead_id: SHOWCASE_LEAD_ID,
    raw_payload: {
      demo_fixture: true,
      fixture: SHOWCASE_LEAD_ID,
      full_name: customerProfile.fullName,
      phone_number: customerProfile.phone,
      vehicle_model: 'Curvv',
      city: 'Bengaluru',
    },
    customer_name: customerProfile.fullName,
    phone: customerProfile.phone,
    normalized_phone: customerProfile.normalizedPhone,
    email: customerProfile.email,
    interested_model: 'Curvv',
    lifecycle_status: 'Transferred to Sales',
    temperature: 'HOT',
    assigned_user_id: sc,
    first_contacted_at: ago(9, -1.6),
    next_followup_at: followupDueAt,
    sla_due_at: ago(8, -2),
    created_at: createdAt,
    updated_at: ago(1),
  });
  const leadId = lead.id;
  const leadRef = { lead_id: leadId, customer_id: customerId };

  await insert(
    'lead_temperature_history',
    [
      { from_temperature: null, to_temperature: 'WARM', changed_by: tc, created_at: ago(9, -1.5) },
      { from_temperature: 'WARM', to_temperature: 'HOT', changed_by: sc, created_at: ago(5, 1) },
    ].map((row) => ({ organization_id: org, lead_id: leadId, ...row })),
  );

  await insert(
    'lead_assignment_history',
    [
      {
        previous_owner_id: null,
        new_owner_id: tc,
        method: 'ROUND_ROBIN',
        reason: 'Fresh lead routed to the Telecaller queue',
        created_at: createdAt,
      },
      {
        previous_owner_id: tc,
        new_owner_id: sc,
        method: 'MANUAL_ASSIGNMENT',
        reason: 'Qualified — Telecaller selected the Sales Consultant',
        created_at: ago(8, 0.1),
      },
    ].map((row) => ({
      organization_id: org,
      lead_id: leadId,
      branch_id: branchId,
      team_id: teamId,
      assigned_by: row.new_owner_id === tc ? null : tc,
      ...row,
    })),
  );

  // The handoff history must exist before the QUALIFIED assignment, which the
  // assignment trigger checks for.
  await insert(
    'lead_stage_history',
    [
      ['New', 'Contacted', ago(9, -1.6), 'First call connected'],
      ['Contacted', 'Qualified', ago(8), 'Budget, timeline and model confirmed'],
      ['Qualified', 'Transferred to Sales', ago(8, 0.1), 'Handed to Sales Consultant'],
    ].map(([from_status, to_status, created_at, reason]) => ({
      organization_id: org,
      lead_id: leadId,
      from_status,
      to_status,
      changed_by: tc,
      reason,
      created_at,
    })),
  );

  await insertOne('lead_assignments', {
    organization_id: org,
    lead_id: leadId,
    branch_id: branchId,
    team_id: teamId,
    assigned_user_id: sc,
    assignment_type: 'QUALIFIED',
    method: 'MANUAL_ASSIGNMENT',
    assigned_by: tc,
    reason: 'Qualified — Telecaller selected the Sales Consultant',
    active: true,
    created_at: ago(8, 0.1),
  });

  // --- Calls -----------------------------------------------------------------
  const callRow = (user, direction, startedAt, seconds, outcome, notes) => ({
    ...scope,
    ...leadRef,
    assigned_user_id: user,
    direction,
    call_source: 'PERSONAL_MANUAL',
    call_mode: 'HUMAN',
    started_at: startedAt,
    ended_at: new Date(new Date(startedAt).getTime() + seconds * 1000).toISOString(),
    duration_seconds: seconds,
    answered_at: seconds > 0 ? startedAt : null,
    outcome,
    status: 'COMPLETED',
    notes,
    finalized_at: new Date(new Date(startedAt).getTime() + seconds * 1000).toISOString(),
    finalized_by: user,
  });
  const calls = await insert('calls', [
    callRow(
      tc,
      'OUTBOUND',
      ago(9, -1.6),
      252,
      'CONNECTED',
      'Interested in Curvv petrol automatic. Budget ₹18–20L, wants delivery within a month. Will trade in a 2018 Swift.',
    ),
    callRow(
      sc,
      'OUTBOUND',
      ago(7),
      395,
      'CONNECTED',
      'Introduced myself as Sales Consultant. Booked showroom visit for Saturday with spouse.',
    ),
    callRow(sc, 'OUTBOUND', ago(2, 3), 0, 'NO_ANSWER', 'No answer — retried later.'),
    callRow(
      sc,
      'INBOUND',
      ago(1, 2),
      190,
      'CONNECTED',
      'Customer asked which documents the loan needs. Shared the KYC list.',
    ),
  ]);
  await insertOne('ai_call_summaries', {
    organization_id: org,
    call_id: calls[1].id,
    summary:
      'Amit is very interested in the Curvv Creative S DCA (petrol, automatic). Budget is around ₹18–20 lakh on-road with a loan for roughly 80%. He is comparing with the Hyundai Creta and Kia Seltos and will decide after a test drive. He wants to exchange his 2018 Swift ZXi and expects about ₹4.8 lakh. Next step: showroom visit with his wife on Saturday.',
    model_reference: 'demo-fixture',
    generated_by: sc,
    created_at: ago(7, 0.2),
  });

  await seedSalesJourney({ target, leadRef, swiftId: swift.id, followupDueAt, createdAt });
  await ensureStructuredProfile(target, customerId, leadId);
  report('created', {
    customerId,
    leadId,
    previous_lead_id: previousLead.id,
    created_custom_field_definitions: definitions.created,
  });
}

/**
 * Everything from the first follow-up onward. Split out so a run that stopped
 * after the lead and calls were written can resume here instead of leaving a
 * second copy of the customer behind.
 */
async function seedSalesJourney({ target, leadRef, swiftId, followupDueAt, createdAt }) {
  const { organizationId: org, branchId, teamId } = target;
  const sc = target.salesConsultantId;
  const tc = target.telecallerId;
  const scope = { organization_id: org, branch_id: branchId, team_id: teamId };
  const customerId = leadRef.customer_id;

  // --- Follow-ups, appointment, test drive -----------------------------------
  await insert('followups', [
    {
      ...scope,
      ...leadRef,
      assigned_user_id: sc,
      reason: 'Test drive confirmation',
      priority: 'HIGH',
      due_at: ago(6),
      status: 'COMPLETED',
      completed_at: ago(6, 0.5),
      completion_note: 'Confirmed Saturday 11:00 test drive with spouse.',
      outcome: 'APPOINTMENT',
      created_by: sc,
      created_at: ago(7),
      updated_at: ago(6, 0.5),
    },
    {
      ...scope,
      ...leadRef,
      assigned_user_id: sc,
      reason: 'Document collection — loan KYC and exchange RC',
      priority: 'HIGH',
      due_at: followupDueAt,
      status: 'OPEN',
      // PostgREST rejects a bulk insert whose rows carry different keys.
      completed_at: null,
      completion_note: null,
      outcome: null,
      created_by: sc,
      created_at: ago(1, 2.1),
      updated_at: ago(1, 2.1),
    },
  ]);

  await insertOne('appointments', {
    ...scope,
    ...leadRef,
    assigned_user_id: sc,
    appointment_type: 'Showroom Visit',
    scheduled_at: ago(5),
    status: 'COMPLETED',
    attendance_status: 'COMPLETED',
    notes: 'Visiting with spouse to see Curvv colours and do the test drive.',
    created_by: sc,
    confirmed_at: ago(6, 0.5),
    arrived_at: ago(5, 0.1),
    completed_at: ago(5, 1.5),
    created_at: ago(7),
    updated_at: ago(5, 1.5),
  });

  const [stockUnit] = await select('stock_units', {
    select: 'id',
    organization_id: `eq.${org}`,
    branch_id: `eq.${branchId}`,
    status: 'eq.AVAILABLE',
    deleted_at: 'is.null',
    order: 'created_at.asc',
    limit: '1',
  });
  if (!stockUnit) throw new Error('No available demo stock unit at BLR-01 for the test drive.');
  const driveStart = ago(5, 0.5);
  const driveEnd = ago(5, 0.5 + 38 / 60);
  const driveAppointment = await insertOne('test_drive_appointments', {
    ...scope,
    ...leadRef,
    assigned_user_id: sc,
    stock_unit_id: stockUnit.id,
    scheduled_at: driveStart,
    status: 'COMPLETED',
    expected_duration_minutes: 45,
    start_location: { label: 'Showroom', latitude: 12.9716, longitude: 77.5946 },
    destination: { label: 'Old Airport Road loop', latitude: 12.9592, longitude: 77.6484 },
    vehicle_registration: 'KA 01 TD 4521',
    created_by: sc,
    created_at: ago(6, 0.5),
    updated_at: driveEnd,
  });
  const testDrive = await insertOne('test_drives', {
    ...scope,
    ...leadRef,
    appointment_id: driveAppointment.id,
    assigned_user_id: sc,
    status: 'COMPLETED',
    started_at: driveStart,
    completed_at: driveEnd,
    start_anchor: { latitude: 12.9716, longitude: 77.5946, recorded_at: driveStart },
    end_anchor: { latitude: 12.9719, longitude: 77.5949, recorded_at: driveEnd },
    start_odometer: 1840,
    end_odometer: 1852,
    distance_meters: 12400,
    duration_seconds: 38 * 60,
    created_at: driveStart,
    updated_at: driveEnd,
  });
  await insertOne('test_drive_feedback', {
    organization_id: org,
    test_drive_id: testDrive.id,
    vehicle_rating: 5,
    consultant_rating: 5,
    driving_experience_rating: 5,
    comfort_rating: 4,
    features_rating: 5,
    performance_rating: 4,
    price_perception_rating: 3,
    overall_rating: 5,
    competitor_compared: 'Hyundai Creta SX(O) IVT',
    purchase_intent: 'HIGHLY_INTERESTED',
    comments: 'Loved the panoramic sunroof and ride quality. Wants a better price on accessories.',
    created_at: ago(5, 1.2),
  });

  // --- Quotation, booking, exchange -----------------------------------------
  const quotationItems = [
    ['VEHICLE', 'Curvv Creative S DCA (ex-showroom)', 1_799_000, 0],
    ['INSURANCE', 'Comprehensive insurance with zero depreciation, year 1', 62_965, 0],
    ['OTHER', 'RTO / registration', 161_910, 0],
    ['ACCESSORY', 'Accessories pack — mats, mud flaps, dash cam', 25_000, 0],
    ['SERVICE', 'Extended warranty, 5 years', 18_500, 0],
    ['DISCOUNT', 'Festive dealer discount', 0, -30_000],
  ];
  const totalAmount = quotationItems.reduce((sum, [, , price, adjust]) => sum + price + adjust, 0);
  const quotation = await insertOne('quotations', {
    ...scope,
    ...leadRef,
    assigned_user_id: sc,
    quotation_number: QUOTATION_NUMBER,
    status: 'CONVERTED',
    current_version: 2,
    total_amount: totalAmount,
    approval_status: 'NOT_REQUIRED',
    created_at: ago(4),
    updated_at: ago(3),
  });
  await insert(
    'quotation_items',
    quotationItems.map(([item_type, description, unit_price, adjustment]) => ({
      organization_id: org,
      quotation_id: quotation.id,
      item_type,
      description,
      quantity: 1,
      unit_price,
      adjustment,
      created_at: ago(4),
    })),
  );
  await insert(
    'quotation_versions',
    [
      { version: 1, discount: 20_000, created_at: ago(4) },
      { version: 2, discount: 30_000, created_at: ago(3) },
    ].map(({ version, discount, created_at }) => ({
      organization_id: org,
      quotation_id: quotation.id,
      version,
      snapshot: { model: 'Curvv', variant: 'Creative S DCA', ex_showroom: 1_799_000, discount },
      created_by: sc,
      created_at,
    })),
  );

  const booking = await insertOne('bookings', {
    ...scope,
    ...leadRef,
    quotation_id: quotation.id,
    assigned_user_id: sc,
    booking_number: BOOKING_NUMBER,
    status: 'CONFIRMED',
    booking_amount: 25_000,
    total_value: totalAmount,
    finance_required: true,
    exchange_required: true,
    expected_delivery_date: new Date(now + 21 * DAY).toISOString().slice(0, 10),
    created_at: ago(2),
    updated_at: ago(2),
  });

  await insertOne('exchange_cases', {
    organization_id: org,
    branch_id: branchId,
    booking_id: booking.id,
    customer_id: customerId,
    assigned_user_id: target.exchangeUserId,
    vehicle_id: swiftId,
    status: 'ACCEPTED',
    priority: 'NORMAL',
    estimated_value: 450_000,
    accepted_value: 455_000,
    customer_expected_value: 480_000,
    odometer_km: 48_500,
    fuel_type: 'Petrol',
    ownership: 'First owner',
    notes: 'Minor scratch on rear bumper; service history complete at authorised workshop.',
    created_by: sc,
    created_at: ago(4, 2),
    updated_at: ago(2),
  });

  await insertOne('tasks', {
    ...scope,
    ...leadRef,
    assigned_user_id: sc,
    title: 'Collect loan KYC documents and Swift RC from Amit',
    description:
      'PAN, Aadhaar, 3 months salary slips, 6 months bank statement, Swift RC and insurance.',
    priority: 'HIGH',
    status: 'OPEN',
    due_at: followupDueAt,
    created_by: sc,
    created_at: ago(1, 2.1),
    updated_at: ago(1, 2.1),
  });

  await insert(
    'notes',
    [
      [
        'Customer prefers evening calls after 6 PM. Wife Neha is part of the decision — include her in the delivery plan.',
        ago(7, 0.3),
      ],
      [
        'Booking confirmed with ₹25,000. Loan through HDFC; exchange accepted at ₹4.55 lakh. Promised home delivery.',
        ago(2, 0.2),
      ],
    ].map(([body, created_at]) => ({
      organization_id: org,
      resource_type: 'customer',
      resource_id: customerId,
      body,
      created_by: sc,
      created_at,
    })),
  );

  // --- Timeline --------------------------------------------------------------
  const events = [
    ['LEAD_RECEIVED', tc, createdAt, 'Lead received from Meta Lead Ads'],
    ['FIRST_CONTACTED', tc, ago(9, -1.6), 'First call connected'],
    ['LEAD_QUALIFIED', tc, ago(8), 'Lead qualified for Sales'],
    ['LEAD_TRANSFERRED_TO_SALES', tc, ago(8, 0.1), 'Transferred to Sales Consultant'],
    ['FOLLOWUP_SCHEDULED', sc, ago(7), 'Test drive confirmation follow-up'],
    ['APPOINTMENT_SCHEDULED', sc, ago(7), 'Showroom visit scheduled'],
    ['TEST_DRIVE_SCHEDULED', sc, ago(6, 0.5), 'Curvv test drive scheduled'],
    ['FOLLOWUP_COMPLETED', sc, ago(6, 0.5), 'Test drive confirmed'],
    ['APPOINTMENT_COMPLETED', sc, ago(5, 1.5), 'Showroom visit completed'],
    ['TEST_DRIVE_COMPLETED', sc, driveEnd, 'Test drive completed — 12.4 km'],
    ['QUOTATION_CREATED', sc, ago(4), `Quotation ${QUOTATION_NUMBER} created`],
    ['BOOKING_CREATED', sc, ago(2), `Booking ${BOOKING_NUMBER} confirmed`],
    ['FOLLOWUP_SCHEDULED', sc, ago(1, 2.1), 'Document collection follow-up'],
  ];
  await insert(
    'activities',
    events.map(([activity_type, actor_id, occurred_at, title]) => ({
      organization_id: org,
      ...leadRef,
      activity_type,
      actor_id,
      occurred_at,
      metadata: { fixture: SHOWCASE_LEAD_ID, title, dummy: true },
    })),
  );
}

function report(status, { customerId, leadId, ...extra }) {
  console.log(
    JSON.stringify(
      {
        status,
        customer_id: customerId,
        lead_id: leadId,
        ...extra,
        quotation_number: QUOTATION_NUMBER,
        booking_number: BOOKING_NUMBER,
        customer_360: `/sales-consultant/customers/${customerId}`,
        lead_detail: `/sales-consultant/leads/${leadId}`,
      },
      null,
      2,
    ),
  );
}

/**
 * Structured requirement, vehicle and WhatsApp data. Idempotent and gap-filling
 * only: re-running upgrades a showcase seeded before these columns existed but
 * never overwrites what someone has since edited in the UI.
 */
async function ensureStructuredProfile(target, customerId, leadId) {
  const org = target.organizationId;
  const vehicles = await select('customer_vehicles', {
    select: 'id,normalized_registration,fuel_type',
    organization_id: `eq.${org}`,
    customer_id: `eq.${customerId}`,
  });
  for (const vehicle of vehicles) {
    const details = showcaseVehicleDetails[vehicle.normalized_registration];
    if (details && !vehicle.fuel_type)
      await patch('customer_vehicles', { id: `eq.${vehicle.id}` }, details);
  }
  const swift = vehicles.find((vehicle) => vehicle.normalized_registration === 'KA03MN4521');

  const [existing] = await select('lead_requirements', {
    select: 'lead_id',
    lead_id: `eq.${leadId}`,
  });
  if (!existing)
    await insertOne('lead_requirements', {
      lead_id: leadId,
      organization_id: org,
      ...showcaseRequirements,
      exchange_vehicle_id: swift?.id ?? null,
      updated_by: target.salesConsultantId,
    });

  const [customer] = await select('customers', {
    select: 'whatsapp_phone,additional_fields',
    id: `eq.${customerId}`,
  });
  const kept = (customer.additional_fields ?? []).filter(
    (field) => !legacyAdditionalLabels.has(field.label),
  );
  const changes = {};
  if (kept.length !== (customer.additional_fields ?? []).length) changes.additional_fields = kept;
  // A separate WhatsApp number shows the "different number" option in use.
  if (!customer.whatsapp_phone) {
    changes.whatsapp_phone = customerProfile.alternatePhone;
    changes.normalized_whatsapp_phone = customerProfile.alternatePhone.replace(/\D/g, '');
  }
  if (Object.keys(changes).length) await patch('customers', { id: `eq.${customerId}` }, changes);
}

/** Resume a run that wrote the lead but stopped before its booking. */
async function resumeOrReport(target, lead) {
  const org = target.organizationId;
  const ids = { customerId: lead.customer_id, leadId: lead.id };
  const bookings = await select('bookings', {
    select: 'id',
    organization_id: `eq.${org}`,
    booking_number: `eq.${BOOKING_NUMBER}`,
  });
  if (bookings.length > 0) {
    await ensureStructuredProfile(target, lead.customer_id, lead.id);
    return report('already_seeded', ids);
  }
  const followups = await select('followups', {
    select: 'id',
    organization_id: `eq.${org}`,
    lead_id: `eq.${lead.id}`,
  });
  if (followups.length > 0)
    throw new Error(
      `Showcase lead ${lead.id} stopped part-way through its sales journey; it cannot be resumed automatically.`,
    );
  const swift = await first(
    'customer_vehicles',
    {
      select: 'id',
      organization_id: `eq.${org}`,
      customer_id: `eq.${lead.customer_id}`,
      normalized_registration: 'eq.KA03MN4521',
    },
    'The showcase exchange vehicle is missing; cannot resume.',
  );
  await seedSalesJourney({
    target,
    leadRef: { lead_id: lead.id, customer_id: lead.customer_id },
    swiftId: swift.id,
    followupDueAt: lead.next_followup_at,
    createdAt: lead.created_at,
  });
  await ensureStructuredProfile(target, lead.customer_id, lead.id);
  report('resumed', ids);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
