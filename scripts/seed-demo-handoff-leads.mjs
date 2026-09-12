// Creates ten fresh demo enquiries and transfers two through the real RPC.
// Re-running the same --batch is idempotent. Existing unrelated data is untouched.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const env = Object.fromEntries(
  fs
    .readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]),
);
const batch = process.argv.find((arg) => arg.startsWith('--batch='))?.slice(8);
assert.ok(batch && /^[a-zA-Z0-9-]{1,32}$/.test(batch), 'Pass a stable --batch identifier.');
assert.ok(process.argv.includes('--apply'), 'Pass --apply to seed the isolated demo tenant.');
assert.equal(env.DEMO_ALLOW_REMOTE_SEED, 'true', 'Remote demo seeding must be configured.');
const url = env.SUPABASE_URL.replace(/\/$/, '');
assert.equal(new URL(url).hostname, `${env.DEMO_ALLOWED_SUPABASE_PROJECT_REF}.supabase.co`);
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY && env.DEMO_TEST_PASSWORD);
const adminHeaders = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};
async function request(path, options) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `Demo request failed: ${response.status} ${data.code ?? data.error_code ?? ''}`,
    );
  return data;
}
const rows = (table, query) =>
  request(`/rest/v1/${table}?${new URLSearchParams(query)}`, { headers: adminHeaders });
async function login(role) {
  const session = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${role}@demo.go-digital.invalid`,
      password: env.DEMO_TEST_PASSWORD,
    }),
  });
  return {
    id: session.user.id,
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    },
  };
}
const rpc = (session, name, args) =>
  request(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: session.headers,
    body: JSON.stringify(args),
  });

const [organization] = await rows('organizations', {
  select: 'id',
  slug: 'eq.go-digital-demo-test',
  deleted_at: 'is.null',
});
assert.ok(organization, 'The isolated demo tenant must exist.');
const [branch] = await rows('branches', {
  select: 'id',
  organization_id: `eq.${organization.id}`,
  code: 'eq.BLR-01',
  active: 'eq.true',
});
assert.ok(branch, 'The demo branch must be active.');
const caller = await login('telecaller-bdc');
const sales = await login('sales-consultant');
const search = `Fresh Handoff ${batch}`;
const existing = await rows('leads', {
  select: 'id,customer_name,lifecycle_status,assigned_user_id',
  organization_id: `eq.${organization.id}`,
  campaign: `eq.${search}`,
  deleted_at: 'is.null',
  limit: '25',
});
let created = 0;
let transferred = 0;
for (let index = 1; index <= 10; index++) {
  const customerName = `${search} ${String(index).padStart(2, '0')}`;
  let lead = existing.find((row) => row.customer_name === customerName);
  if (!lead) {
    // Reserved fictional North American numbers; no real customers are contacted.
    const phone = `+120255501${String(index).padStart(2, '0')}`;
    const matches = await rows('customers', {
      select: 'id',
      organization_id: `eq.${organization.id}`,
      normalized_phone: `eq.${phone}`,
      deleted_at: 'is.null',
      limit: '1',
    });
    assert.equal(
      matches.length,
      0,
      'Fixture phone already exists; stop rather than link an existing customer.',
    );
    const id = await rpc(caller, 'create_lead', {
      target_organization_id: organization.id,
      target_branch_id: branch.id,
      target_team_id: null,
      lead_source: 'Manual',
      lead_customer_name: customerName,
      lead_phone: phone,
      lead_email: `handoff-${batch}-${index}@demo.go-digital.invalid`,
      lead_source_detail: 'Isolated demo handoff verification',
      lead_campaign: search,
      lead_interested_model: 'Nexon EV',
    });
    lead = { id, lifecycle_status: 'New', assigned_user_id: caller.id };
    created++;
  }
  if (index <= 2 && lead.lifecycle_status !== 'Transferred to Sales') {
    assert.equal(lead.assigned_user_id, caller.id);
    await rpc(caller, 'transfer_lead_to_sales', {
      target_lead_id: lead.id,
      target_user_id: sales.id,
      transfer_reason: 'Fresh demo handoff verification; Telecaller retains read-only view.',
    });
    transferred++;
  }
}
const query = {
  target_page: 1,
  target_page_size: 25,
  target_search: search,
  target_status: 'all',
  target_sort: 'created:desc',
  target_model: null,
  target_source: null,
  target_stage: 'all',
  target_temperature: 'all',
  target_followup_from: null,
  target_followup_to: null,
  target_include_records: true,
  target_include_kpis: false,
};
const callerPage = await rpc(caller, 'get_lead_workspace_page_v2', query);
const salesPage = await rpc(sales, 'get_lead_workspace_page_v2', query);
// The workspace groups leads by phone and may also surface an older enquiry
// with the same search text. Verify only this batch rather than treating that
// surrounding demo history as a seeding failure.
const seeded = await rows('leads', {
  select: 'id,lifecycle_status,assigned_user_id',
  organization_id: `eq.${organization.id}`,
  campaign: `eq.${search}`,
  deleted_at: 'is.null',
  limit: '25',
});
assert.equal(seeded.length, 10);
const seededLeadIds = new Set(seeded.map((lead) => lead.id));
const callerBatch = callerPage.records.filter((lead) => seededLeadIds.has(lead.id));
const salesBatch = salesPage.records.filter((lead) => seededLeadIds.has(lead.id));
assert.equal(callerBatch.length, 10);
assert.equal(callerBatch.filter((lead) => lead.read_only).length, 2);
assert.equal(salesBatch.length, 2);
assert.equal(salesBatch.filter((lead) => lead.read_only).length, 0);
console.log(
  JSON.stringify(
    {
      created,
      transferred,
      search,
      telecallerEditable: 8,
      telecallerReadOnly: 2,
      salesConsultantEditable: 2,
      handoffVerified: true,
    },
    null,
    2,
  ),
);
