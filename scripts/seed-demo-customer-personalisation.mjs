/*
 * Seed the two customer-personalisation features with data a demo can actually
 * be shown with:
 *
 *   1. The CUSTOMER_PERSONAL and CUSTOMER_FAMILY field sets, plus filled values
 *      (date of birth, anniversary, spouse, occupation) on the demo customers,
 *      so Edit customer opens with something in it rather than an empty section.
 *   2. Two ACTIVE marketing drip campaigns to act as sequence templates, and one
 *      live enrolment on a demo customer with a sent step, a due step and a
 *      future step, so every message state is visible at once.
 *
 * Definitions and campaigns are matched on their natural keys, so re-running
 * this updates rather than duplicates.
 *
 * Run: pnpm seed:demo:customer-personalisation
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEMO_SLUG = 'go-digital-demo-test';
const DEMO_DOMAIN = 'demo.go-digital.invalid';
const SALES_CONSULTANT_EMAIL = `sales-consultant@${DEMO_DOMAIN}`;
const CLIENT_ADMIN_EMAIL = `client-admin@${DEMO_DOMAIN}`;
const BRANCH_CODE = 'BLR-01';

/**
 * Mirrors `app_private.customer_field_template` exactly. The RPC is the real
 * source of truth; a drift here would seed fields the product does not know
 * about, so the checked list below is asserted against nothing but itself and
 * must be updated together with the migration.
 */
const fieldSets = {
  CUSTOMER_PERSONAL: [
    { field_key: 'date_of_birth', label: 'Date of birth', field_type: 'DATE', options: [] },
    {
      field_key: 'wedding_anniversary',
      label: 'Wedding anniversary',
      field_type: 'DATE',
      options: [],
    },
    { field_key: 'spouse_name', label: 'Spouse name', field_type: 'TEXT', options: [] },
    { field_key: 'occupation', label: 'Occupation', field_type: 'TEXT', options: [] },
    {
      field_key: 'preferred_language',
      label: 'Preferred language',
      field_type: 'SELECT',
      options: ['English', 'Hindi', 'Kannada', 'Tamil', 'Telugu', 'Malayalam', 'Marathi'],
    },
    {
      field_key: 'preferred_contact_time',
      label: 'Best time to call',
      field_type: 'SELECT',
      options: ['Morning', 'Afternoon', 'Evening', 'Weekend only'],
    },
  ],
  CUSTOMER_FAMILY: [
    { field_key: 'family_size', label: 'Family size', field_type: 'NUMBER', options: [] },
    { field_key: 'children_count', label: 'Children', field_type: 'NUMBER', options: [] },
    {
      field_key: 'household_vehicles',
      label: 'Vehicles in household',
      field_type: 'NUMBER',
      options: [],
    },
    {
      field_key: 'primary_use',
      label: 'Primary use',
      field_type: 'SELECT',
      options: ['Family', 'Personal commute', 'Business', 'Commercial'],
    },
  ],
};

/** Keyed by customer name so the values read as real people, not filler. */
const personalProfiles = {
  'Aarav Sharma': {
    date_of_birth: '1988-03-14',
    wedding_anniversary: '2015-11-22',
    spouse_name: 'Ishita Sharma',
    occupation: 'Software architect',
    preferred_language: 'English',
    preferred_contact_time: 'Evening',
    family_size: 4,
    children_count: 2,
    household_vehicles: 1,
    primary_use: 'Family',
  },
  'Diya Nair': {
    date_of_birth: '1993-07-02',
    spouse_name: null,
    occupation: 'Dentist',
    preferred_language: 'Malayalam',
    preferred_contact_time: 'Morning',
    family_size: 2,
    children_count: 0,
    household_vehicles: 1,
    primary_use: 'Personal commute',
  },
  'Kabir Singh': {
    date_of_birth: '1979-12-30',
    wedding_anniversary: '2009-02-08',
    spouse_name: 'Simran Kaur',
    occupation: 'Logistics business owner',
    preferred_language: 'Hindi',
    preferred_contact_time: 'Afternoon',
    family_size: 5,
    children_count: 3,
    household_vehicles: 3,
    primary_use: 'Business',
  },
  'Meera Iyer': {
    date_of_birth: '1991-09-19',
    wedding_anniversary: '2019-05-30',
    spouse_name: 'Karthik Iyer',
    occupation: 'Chartered accountant',
    preferred_language: 'Tamil',
    preferred_contact_time: 'Weekend only',
    family_size: 3,
    children_count: 1,
    household_vehicles: 2,
    primary_use: 'Family',
  },
  'Rohan Patel': {
    date_of_birth: '1985-01-26',
    wedding_anniversary: '2013-12-11',
    spouse_name: 'Nidhi Patel',
    occupation: 'Pharmaceutical sales lead',
    preferred_language: 'Kannada',
    preferred_contact_time: 'Evening',
    family_size: 4,
    children_count: 2,
    household_vehicles: 2,
    primary_use: 'Family',
  },
  'Ananya Rao': {
    date_of_birth: '1996-06-05',
    occupation: 'Product designer',
    preferred_language: 'Telugu',
    preferred_contact_time: 'Morning',
    family_size: 1,
    children_count: 0,
    household_vehicles: 0,
    primary_use: 'Personal commute',
  },
};

const dripTemplates = [
  {
    name: 'Post test-drive follow-up',
    description: 'Three touches over a week after a customer drives the car.',
    default_channel: 'WHATSAPP',
    steps: [
      {
        step_order: 1,
        delay_hours: 2,
        channel: 'WHATSAPP',
        message_body:
          'Hi! Thank you for taking the test drive with us today. How did the car feel on the road? Happy to answer anything that came to mind.',
      },
      {
        step_order: 2,
        delay_hours: 46,
        channel: 'WHATSAPP',
        message_body:
          'Just checking in — I have kept the on-road price breakdown ready for you. Would you like me to send it across?',
      },
      {
        step_order: 3,
        delay_hours: 120,
        channel: 'EMAIL',
        message_body:
          'Sharing the full quotation, finance options and current offers in one place. The exchange valuation is valid for the next 15 days.',
      },
    ],
  },
  {
    name: 'Quotation nudge',
    description: 'Two short reminders while a quotation is still open.',
    default_channel: 'WHATSAPP',
    steps: [
      {
        step_order: 1,
        delay_hours: 24,
        channel: 'WHATSAPP',
        message_body:
          'Hi! Did you get a chance to look at the quotation I sent? I can revise anything on it.',
      },
      {
        step_order: 2,
        delay_hours: 72,
        channel: 'SMS',
        message_body:
          'This month’s offer closes soon. Reply here and I will hold your colour and variant.',
      },
    ],
  },
  {
    name: 'Service due reminder',
    description: 'A single reminder for customers approaching their service window.',
    default_channel: 'SMS',
    steps: [
      {
        step_order: 1,
        delay_hours: 0,
        channel: 'SMS',
        message_body:
          'Your vehicle is approaching its scheduled service. Reply with a preferred date and we will confirm a slot.',
      },
    ],
  },
];

function readEnv() {
  const values = new Map();
  const envPath = path.resolve(process.cwd(), '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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
    'Refusing to write demo personalisation data. Re-run with --apply after confirming the isolated demo project.',
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
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new Error(
      `${options.method ?? 'GET'} ${url}: ${response.status} ${JSON.stringify(payload)}`,
    );
  return payload;
}

function restUrl(table, query = {}) {
  const search = new URLSearchParams(query);
  return `${projectUrl}/rest/v1/${table}${search.size ? `?${search}` : ''}`;
}

function inFilter(values) {
  return `in.(${values
    .map((value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')})`;
}

async function select(table, query) {
  return request(restUrl(table, query));
}

async function insert(table, rows) {
  if (rows.length === 0) return [];
  return request(restUrl(table), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
}

async function patch(table, query, body) {
  return request(restUrl(table, query), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
}

async function first(table, query, errorMessage) {
  const rows = await select(table, { ...query, limit: '1' });
  if (rows.length !== 1) throw new Error(errorMessage);
  return rows[0];
}

async function resolveTarget() {
  const organization = await first(
    'organizations',
    { select: 'id', slug: `eq.${DEMO_SLUG}` },
    'The isolated demo tenant is missing. Run pnpm seed:demo:remote first.',
  );
  const branch = await first(
    'branches',
    { select: 'id', organization_id: `eq.${organization.id}`, code: `eq.${BRANCH_CODE}` },
    'The demo branch is missing. Run pnpm seed:demo:remote first.',
  );
  const salesConsultant = await first(
    'profiles',
    {
      select: 'id',
      organization_id: `eq.${organization.id}`,
      email: `eq.${SALES_CONSULTANT_EMAIL}`,
      active: 'eq.true',
      deleted_at: 'is.null',
    },
    'The primary demo Sales Consultant is missing. Run pnpm seed:demo:remote first.',
  );
  const clientAdmin = await first(
    'profiles',
    {
      select: 'id',
      organization_id: `eq.${organization.id}`,
      email: `eq.${CLIENT_ADMIN_EMAIL}`,
      active: 'eq.true',
      deleted_at: 'is.null',
    },
    'The demo Client Admin is missing. Run pnpm seed:demo:remote first.',
  );
  return {
    organizationId: organization.id,
    branchId: branch.id,
    salesConsultantId: salesConsultant.id,
    clientAdminId: clientAdmin.id,
  };
}

async function ensureFieldDefinitions(target) {
  const wanted = Object.values(fieldSets).flat();
  const existing = await select('custom_field_definitions', {
    select: 'id,field_key,label,field_type,options,active',
    organization_id: `eq.${target.organizationId}`,
    module: 'eq.CUSTOMERS',
    field_key: inFilter(wanted.map((field) => field.field_key)),
  });
  const byKey = new Map(existing.map((row) => [row.field_key, row]));

  const created = await insert(
    'custom_field_definitions',
    wanted
      .filter((field) => !byKey.has(field.field_key))
      .map((field) => ({
        organization_id: target.organizationId,
        module: 'CUSTOMERS',
        field_key: field.field_key,
        label: field.label,
        field_type: field.field_type,
        options: field.options,
        required: false,
        active: true,
      })),
  );
  for (const row of created) byKey.set(row.field_key, row);

  // A definition switched off by hand stays off; only a seeded one that drifted
  // in label or type is corrected back to the template.
  for (const field of wanted) {
    const row = byKey.get(field.field_key);
    if (!row || !row.active) continue;
    if (row.label === field.label && row.field_type === field.field_type) continue;
    await patch(
      'custom_field_definitions',
      { id: `eq.${row.id}` },
      { label: field.label, field_type: field.field_type, options: field.options },
    );
  }
  return { byKey, createdCount: created.length };
}

async function fillCustomerValues(target, definitionsByKey) {
  const names = Object.keys(personalProfiles);
  const customers = await select('customers', {
    select: 'id,full_name',
    organization_id: `eq.${target.organizationId}`,
    full_name: inFilter(names),
    deleted_at: 'is.null',
  });
  if (customers.length === 0)
    throw new Error('No demo fixture customers found. Run pnpm seed:demo:remote first.');

  const definitionIds = [...definitionsByKey.values()].map((row) => row.id);
  const existingValues = await select('custom_field_values', {
    select: 'id,definition_id,resource_id',
    organization_id: `eq.${target.organizationId}`,
    resource_type: 'eq.CUSTOMER',
    definition_id: inFilter(definitionIds),
    resource_id: inFilter(customers.map((customer) => customer.id)),
  });
  const seen = new Set(existingValues.map((row) => `${row.definition_id}:${row.resource_id}`));

  const rows = [];
  for (const customer of customers) {
    const profile = personalProfiles[customer.full_name];
    if (!profile) continue;
    for (const [fieldKey, value] of Object.entries(profile)) {
      if (value === null || value === undefined) continue;
      const definition = definitionsByKey.get(fieldKey);
      if (!definition) continue;
      if (seen.has(`${definition.id}:${customer.id}`)) continue;
      rows.push({
        organization_id: target.organizationId,
        definition_id: definition.id,
        resource_type: 'CUSTOMER',
        resource_id: customer.id,
        // Sent as the raw value, not a stringified one: the column is jsonb, so
        // PostgREST stores whatever JSON the body carries. Stringifying first
        // would store the quotes as part of the value and the field would then
        // render as "\"1988-03-14\"" in Edit customer.
        value,
      });
    }
  }
  await insert('custom_field_values', rows);
  return { customers, valueCount: rows.length };
}

async function ensureDripTemplates(target) {
  const existing = await select('marketing_drip_campaigns', {
    select: 'id,name,status',
    organization_id: `eq.${target.organizationId}`,
    name: inFilter(dripTemplates.map((template) => template.name)),
    deleted_at: 'is.null',
  });
  const byName = new Map(existing.map((row) => [row.name, row]));

  const created = await insert(
    'marketing_drip_campaigns',
    dripTemplates
      .filter((template) => !byName.has(template.name))
      .map((template) => ({
        organization_id: target.organizationId,
        branch_id: target.branchId,
        name: template.name,
        description: template.description,
        audience_filter: {},
        default_channel: template.default_channel,
        status: 'ACTIVE',
        starts_at: new Date().toISOString(),
        created_by: target.clientAdminId,
      })),
  );
  for (const row of created) byName.set(row.name, row);

  // A template only works as a starting point while the campaign is ACTIVE.
  for (const template of dripTemplates) {
    const campaign = byName.get(template.name);
    if (campaign && campaign.status !== 'ACTIVE') {
      await patch('marketing_drip_campaigns', { id: `eq.${campaign.id}` }, { status: 'ACTIVE' });
    }
  }

  const campaignIds = [...byName.values()].map((row) => row.id);
  const existingSteps = await select('marketing_drip_steps', {
    select: 'campaign_id,step_order',
    organization_id: `eq.${target.organizationId}`,
    campaign_id: inFilter(campaignIds),
  });
  const stepSeen = new Set(existingSteps.map((row) => `${row.campaign_id}:${row.step_order}`));

  const stepRows = [];
  for (const template of dripTemplates) {
    const campaign = byName.get(template.name);
    if (!campaign) continue;
    for (const step of template.steps) {
      if (stepSeen.has(`${campaign.id}:${step.step_order}`)) continue;
      stepRows.push({
        organization_id: target.organizationId,
        campaign_id: campaign.id,
        step_order: step.step_order,
        delay_hours: step.delay_hours,
        channel: step.channel,
        message_body: step.message_body,
        active: true,
      });
    }
  }
  await insert('marketing_drip_steps', stepRows);
  return { campaigns: byName, createdCampaigns: created.length, createdSteps: stepRows.length };
}

async function ensureLiveEnrollment(target, campaigns, customers) {
  const campaign = campaigns.get('Post test-drive follow-up');
  const customer = customers.find((row) => row.full_name === 'Rohan Patel') ?? customers[0];
  if (!campaign || !customer) return { created: false };

  const existing = await select('customer_drip_enrollments', {
    select: 'id',
    organization_id: `eq.${target.organizationId}`,
    customer_id: `eq.${customer.id}`,
    source_campaign_id: `eq.${campaign.id}`,
  });
  if (existing.length > 0) return { created: false, customerName: customer.full_name };

  const leadRows = await select('leads', {
    select: 'id',
    organization_id: `eq.${target.organizationId}`,
    customer_id: `eq.${customer.id}`,
    deleted_at: 'is.null',
    order: 'updated_at.desc',
    limit: '1',
  });

  const [enrollment] = await insert('customer_drip_enrollments', [
    {
      organization_id: target.organizationId,
      branch_id: target.branchId,
      customer_id: customer.id,
      lead_id: leadRows[0]?.id ?? null,
      source_campaign_id: campaign.id,
      source_name: 'Post test-drive follow-up',
      status: 'ACTIVE',
      enrolled_by: target.salesConsultantId,
    },
  ]);

  const hour = 3_600_000;
  const now = Date.now();
  // One of each state, so the panel shows a sent step, a step due shortly and a
  // step still days out without anyone having to wait for the clock.
  await insert('customer_drip_messages', [
    {
      organization_id: target.organizationId,
      enrollment_id: enrollment.id,
      step_order: 1,
      channel: 'WHATSAPP',
      message_body: dripTemplates[0].steps[0].message_body,
      scheduled_for: new Date(now - 26 * hour).toISOString(),
      status: 'SENT',
      sent_at: new Date(now - 26 * hour).toISOString(),
      attempts: 1,
    },
    {
      organization_id: target.organizationId,
      enrollment_id: enrollment.id,
      step_order: 2,
      channel: 'WHATSAPP',
      message_body: dripTemplates[0].steps[1].message_body,
      scheduled_for: new Date(now + 4 * hour).toISOString(),
      status: 'QUEUED',
    },
    {
      organization_id: target.organizationId,
      enrollment_id: enrollment.id,
      step_order: 3,
      channel: 'EMAIL',
      message_body: dripTemplates[0].steps[2].message_body,
      scheduled_for: new Date(now + 94 * hour).toISOString(),
      status: 'QUEUED',
    },
  ]);
  return { created: true, customerName: customer.full_name };
}

async function main() {
  const target = await resolveTarget();
  const { byKey, createdCount } = await ensureFieldDefinitions(target);
  const { customers, valueCount } = await fillCustomerValues(target, byKey);
  const { campaigns, createdCampaigns, createdSteps } = await ensureDripTemplates(target);
  const enrollment = await ensureLiveEnrollment(target, campaigns, customers);

  console.log('Demo customer personalisation seeded.');
  console.log(`  custom field definitions created : ${createdCount} (${byKey.size} total in set)`);
  console.log(`  customer field values written    : ${valueCount}`);
  console.log(
    `  drip templates created           : ${createdCampaigns} campaigns, ${createdSteps} steps`,
  );
  console.log(
    `  live drip enrolment              : ${
      enrollment.created ? `created for ${enrollment.customerName}` : 'already present'
    }`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
