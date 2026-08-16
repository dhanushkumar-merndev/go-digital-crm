import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEMO_SLUG = 'go-digital-demo-test';
const DEMO_DOMAIN = 'demo.go-digital.invalid';

const moduleCatalog = [
  ['customers', 'Customers'],
  ['leads', 'Leads'],
  ['calls', 'Calls'],
  ['appointments', 'Appointments'],
  ['test-drives', 'Test Drives'],
  ['quotations', 'Quotations'],
  ['bookings', 'Bookings'],
  ['inventory', 'Inventory'],
  ['finance', 'Finance'],
  ['insurance', 'Insurance'],
  ['rto', 'RTO'],
  ['exchange', 'Exchange'],
  ['delivery', 'Delivery'],
  ['customer-care', 'Customer Care'],
  ['marketing', 'Digital Marketing'],
  ['integrations', 'Integrations'],
  ['ai', 'AI Features'],
].map(([module_key, name]) => ({ module_key, name }));

const roleAccounts = [
  ['system_administrator', 'System Administrator', 'ORGANIZATION'],
  ['gm_sales', 'GM Sales Executive', 'ALL_BRANCHES'],
  ['showroom_manager', 'Showroom Manager', 'ALL_BRANCHES'],
  ['team_manager', 'Team Manager', 'OWN_TEAM'],
  ['sales_consultant', 'Sales Consultant', 'OWN_RECORDS'],
  ['telecaller_bdc', 'Telecaller / BDC Executive', 'OWN_RECORDS'],
  ['inventory_manager', 'Inventory Manager', 'ONE_BRANCH'],
  ['finance_manager', 'Finance Manager', 'ONE_BRANCH'],
  ['insurance_manager', 'Insurance Manager', 'ONE_BRANCH'],
  ['rto_manager', 'RTO Manager', 'ONE_BRANCH'],
  ['exchange_manager', 'Used Car / Exchange Manager', 'ONE_BRANCH'],
  ['delivery_manager', 'Delivery Manager', 'ONE_BRANCH'],
  ['customer_relationship_manager', 'Customer Relationship Manager', 'ONE_BRANCH'],
  ['digital_marketing_manager', 'Digital Marketing Manager', 'ONE_BRANCH'],
];

const rolePresets = [
  ['business_owner', 'Business Owner', 900, true],
  ['client_admin', 'Client Admin', 850, true],
  ['system_administrator', 'System Administrator', 800, true],
  ['gm_sales', 'GM Sales Executive', 700, true],
  ['showroom_manager', 'Showroom Manager', 600, false],
  ['team_manager', 'Team Manager', 500, false],
  ['inventory_manager', 'Inventory Manager', 450, false],
  ['finance_manager', 'Finance Manager', 450, false],
  ['insurance_manager', 'Insurance Manager', 450, false],
  ['rto_manager', 'RTO Manager', 450, false],
  ['exchange_manager', 'Used Car / Exchange Manager', 450, false],
  ['delivery_manager', 'Delivery Manager', 450, false],
  ['customer_relationship_manager', 'Customer Relationship Manager', 450, false],
  ['digital_marketing_manager', 'Digital Marketing Manager', 450, false],
  ['sales_consultant', 'Sales Consultant', 300, false],
  ['telecaller_bdc', 'Telecaller / BDC Executive', 300, false],
];

// These are the foundational permission rows from supabase/seed.sql. A hosted
// `db push` intentionally applies migrations only, so the demo command makes
// its own test fixture self-sufficient when the optional seed file has not yet
// been applied to the linked project.
const corePermissionCatalog = [
  ['customer.view', 'customers', 'View customers in authorized context'],
  ['customer.create', 'customers', 'Create a customer after reviewing possible matches'],
  ['customer.link', 'customers', 'Link a reviewed possible customer match'],
  ['lead.view', 'leads', 'View leads within data scope'],
  ['lead.create', 'leads', 'Create a lead'],
  ['lead.update', 'leads', 'Update a lead'],
  ['lead.assign', 'leads', 'Assign or reassign a lead'],
  ['call.view', 'calls', 'View calls within data scope'],
  ['call.create', 'calls', 'Create or sync a call'],
  ['message.view', 'communications', 'View tracked provider conversations within scope'],
  ['message.send', 'communications', 'Send an approved provider message within channel policy'],
  ['task.view', 'appointments', 'View tasks within authorized data scope'],
  ['task.create', 'appointments', 'Create lead-linked tasks within authorized data scope'],
  ['task.update', 'appointments', 'Update open tasks within authorized data scope'],
  ['task.complete', 'appointments', 'Complete authorized tasks'],
  ['task.cancel', 'appointments', 'Cancel authorized tasks'],
  ['task.assign', 'appointments', 'Assign tasks within authorized data scope'],
  ['test_drive.view', 'test-drives', 'View test drives within authorized data scope'],
  ['test_drive.manage', 'test-drives', 'Manage test drives'],
  ['quotation.view', 'quotations', 'View quotations within authorized data scope'],
  ['quotation.manage', 'quotations', 'Manage quotations'],
  ['booking.view', 'bookings', 'View bookings within authorized data scope'],
  ['booking.manage', 'bookings', 'Manage bookings'],
  ['user.manage', 'administration', 'Manage users within authority ceiling'],
  ['role.manage', 'administration', 'Manage delegated roles and permissions'],
  ['integration.view', 'integrations', 'View tenant provider connection health and events'],
  ['integration.manage', 'integrations', 'Manage tenant provider connections'],
  [
    'data.directory.view',
    'administration',
    'View branch and team directory during approved support',
  ],
  ['document.upload', 'documents', 'Upload a validated private document'],
  ['document.download', 'documents', 'Download an authorized private document'],
  ['email.send', 'communications', 'Send an approved transactional email'],
  ['approval.decide', 'approvals', 'Decide approvals within authority limit'],
  ['credit.consume', 'credits', 'Consume credits for an eligible feature'],
  ['credit.allocate', 'credits', 'Allocate or adjust credits'],
  ['audit.view', 'audit', 'View audit events within scope'],
  ['support.request', 'support', 'Request time-limited support access'],
  ['support.approve', 'support', 'Approve or terminate support access'],
].map(([permission_key, module, description]) => ({ permission_key, module, description }));

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
const demoPassword = env.get('DEMO_TEST_PASSWORD');

if (!process.argv.includes('--apply')) {
  console.error('Refusing to write remote demo data. Re-run with: pnpm seed:demo:remote');
  process.exit(1);
}
if (!projectUrl || !serviceRoleKey || !demoPassword || demoPassword.length < 16) {
  console.error(
    'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and a 16+ character DEMO_TEST_PASSWORD are required.',
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

async function select(table, query) {
  return request(restUrl(table, query));
}

async function insert(table, rows, { onConflict } = {}) {
  const query = onConflict ? { on_conflict: onConflict } : undefined;
  return request(restUrl(table, query), {
    method: 'POST',
    headers: { Prefer: `return=representation${onConflict ? ',resolution=merge-duplicates' : ''}` },
    body: JSON.stringify(rows),
  });
}

async function patch(table, query, row) {
  return request(restUrl(table, query), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
}

async function rpc(name, args) {
  return request(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

function emailFor(roleKey) {
  return `${roleKey.replaceAll('_', '-')}@${DEMO_DOMAIN}`;
}

async function findAuthUser(email) {
  const payload = await request(`${projectUrl}/auth/v1/admin/users?per_page=1000`);
  return payload.users?.find((user) => user.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

async function ensureAuthUser(email, fullName) {
  const existing = await findAuthUser(email);
  if (existing) return existing;
  return request(`${projectUrl}/auth/v1/admin/users`, {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: demoPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, demo_fixture: true },
    }),
  });
}

async function ensureProfile({
  userId,
  organizationId,
  fullName,
  email,
  mfaRequired = false,
  employeeId = null,
}) {
  const existing = await select('profiles', { select: 'id', id: `eq.${userId}`, limit: '1' });
  if (existing.length > 0) return existing[0];
  const [profile] = await insert('profiles', {
    id: userId,
    organization_id: organizationId,
    full_name: fullName,
    email,
    phone: '+919000000000',
    normalized_phone: '+919000000000',
    employee_id: employeeId,
    active: true,
    mfa_required: mfaRequired,
  });
  return profile;
}

async function ensureRoleAssignment({
  organizationId,
  userId,
  roleId,
  scope,
  scopeBranchId = null,
  grantedBy,
}) {
  const existing = await select('user_role_assignments', {
    select: 'id',
    user_id: `eq.${userId}`,
    role_id: `eq.${roleId}`,
    active: 'eq.true',
    limit: '1',
  });
  if (existing.length > 0) return existing[0];
  const [assignment] = await insert('user_role_assignments', {
    organization_id: organizationId,
    user_id: userId,
    role_id: roleId,
    data_scope: scope,
    scope_branch_id: scopeBranchId,
    selected_branch_ids: [],
    active: true,
    granted_by: grantedBy,
  });
  return assignment;
}

async function ensureTenantUser({
  actorId,
  organizationId,
  role,
  fullName,
  scope,
  branchId = null,
  teamIds = [],
  emailKey = role,
  scopeBranchId = scope === 'ONE_BRANCH' ? branchId : null,
}) {
  const email = emailFor(emailKey);
  const authUser = await ensureAuthUser(email, fullName);
  const roleRows = await select('roles', {
    select: 'id,mfa_required',
    organization_id: `eq.${organizationId}`,
    role_key: `eq.${role}`,
    limit: '1',
  });
  if (roleRows.length !== 1) throw new Error(`Role ${role} is not available for the demo tenant.`);

  await ensureProfile({
    userId: authUser.id,
    organizationId,
    fullName,
    email,
    mfaRequired: roleRows[0].mfa_required,
    employeeId: `DEMO-${emailKey.toUpperCase().replaceAll('_', '-')}`,
  });
  await ensureRoleAssignment({
    organizationId,
    userId: authUser.id,
    roleId: roleRows[0].id,
    scope,
    scopeBranchId,
    grantedBy: actorId,
  });
  if (branchId) {
    await insert(
      'user_branch_access',
      {
        organization_id: organizationId,
        user_id: authUser.id,
        branch_id: branchId,
        granted_by: actorId,
        active: true,
      },
      { onConflict: 'user_id,branch_id' },
    );
  }
  if (teamIds.length > 0) {
    const memberType =
      role === 'team_manager'
        ? 'TEAM_MANAGER'
        : role === 'sales_consultant'
          ? 'SALES_CONSULTANT'
          : 'TELECALLER_BDC';
    await insert(
      'team_members',
      teamIds.map((teamId) => ({
        organization_id: organizationId,
        team_id: teamId,
        user_id: authUser.id,
        member_type: memberType,
        eligible_for_fresh_leads: role !== 'team_manager',
        eligible_for_qualified_leads: role !== 'team_manager',
        active: true,
      })),
      { onConflict: 'team_id,user_id' },
    );
    if (role === 'team_manager') {
      for (const teamId of teamIds)
        await patch('teams', { id: `eq.${teamId}` }, { manager_id: authUser.id });
    }
  }
  return authUser.id;
}

async function first(table, query, errorLabel) {
  const rows = await select(table, { ...query, limit: '1' });
  if (rows.length === 0) throw new Error(errorLabel);
  return rows[0];
}

async function ensureRecord(table, query, row) {
  // A few join tables intentionally use a composite primary key and have no
  // surrogate `id`, so this must not assume one exists.
  const existing = await select(table, { select: '*', ...query, limit: '1' });
  if (existing.length > 0) return existing[0];
  const [created] = await insert(table, row);
  return created;
}

function demoPayloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function seedDemoRecords({ organizationId, branchId, teamId, users }) {
  // The foundational journey is created once. The richer demo experience below
  // is independently idempotent, so it can be expanded without duplicating
  // quotations, bookings, or operational cases on every run.
  const existingFixture = await select('activities', {
    select: 'id',
    organization_id: `eq.${organizationId}`,
    activity_type: 'eq.demo.seeded',
    limit: '1',
  });
  if (existingFixture.length > 0) {
    const [customerCount, leadCount] = await Promise.all([
      select('customers', { select: 'id', organization_id: `eq.${organizationId}` }),
      select('leads', { select: 'id', organization_id: `eq.${organizationId}` }),
    ]);
    return { seeded: false, customers: customerCount.length, leads: leadCount.length };
  }

  const existingStock = await select('stock_units', {
    select: 'id',
    organization_id: `eq.${organizationId}`,
    vin: 'eq.TSTAA123456789012',
    limit: '1',
  });

  let customers = await select('customers', {
    select: 'id,full_name,primary_phone,normalized_phone,primary_email',
    organization_id: `eq.${organizationId}`,
    order: 'created_at.asc',
    limit: '20',
  });
  if (customers.length < 6)
    customers = await insert(
      'customers',
      [
        ['Aarav Sharma', '+919100000001', 'aarav.sharma@example.test'],
        ['Diya Nair', '+919100000002', 'diya.nair@example.test'],
        ['Kabir Singh', '+919100000003', 'kabir.singh@example.test'],
        ['Meera Iyer', '+919100000004', 'meera.iyer@example.test'],
        ['Rohan Patel', '+919100000005', 'rohan.patel@example.test'],
        ['Ananya Rao', '+919100000006', 'ananya.rao@example.test'],
      ].map(([full_name, primary_phone, primary_email]) => ({
        organization_id: organizationId,
        full_name,
        primary_phone,
        normalized_phone: primary_phone,
        primary_email,
        created_by: users.clientAdmin,
      })),
    );

  let leads = await select('leads', {
    select: 'id,customer_id',
    organization_id: `eq.${organizationId}`,
    source_detail: 'eq.Demo fixture',
    order: 'created_at.asc',
    limit: '20',
  });
  if (leads.length < 6)
    leads = await insert(
      'leads',
      customers.map((customer, index) => ({
        organization_id: organizationId,
        branch_id: branchId,
        team_id: teamId,
        customer_id: customer.id,
        source: ['Facebook', 'Google Ads', 'Website', 'WhatsApp Business', 'CarWale', 'Manual'][
          index
        ],
        source_detail: 'Demo fixture',
        campaign: index % 2 === 0 ? 'Monsoon SUV Campaign' : 'Premium Sedan Test Drive',
        customer_name: customer.full_name,
        phone: customer.primary_phone,
        normalized_phone: customer.normalized_phone,
        email: customer.primary_email,
        interested_model: index % 2 === 0 ? 'Nexon EV' : 'Harrier',
        lifecycle_status: [
          'New',
          'Contacted',
          'Qualified',
          'Appointment Scheduled',
          'Transferred to Sales',
          'Lost',
        ][index],
        temperature: ['HOT', 'WARM', 'HOT', 'WARM', 'COLD', 'COLD'][index],
        assigned_user_id: index % 2 === 0 ? users.salesConsultant : users.telecaller,
        first_contacted_at:
          index === 0 ? null : new Date(Date.now() - index * 86_400_000).toISOString(),
        next_followup_at: new Date(Date.now() + (index + 1) * 86_400_000).toISOString(),
        sla_due_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        lost_reason: index === 5 ? 'Purchased another vehicle' : null,
      })),
    );
  const customerByName = new Map(customers.map((customer) => [customer.full_name, customer]));
  const leadByCustomerId = new Map(leads.map((lead) => [lead.customer_id, lead]));
  const demoCustomer = (name) => {
    const customer = customerByName.get(name);
    if (!customer) throw new Error(`Demo customer ${name} is missing.`);
    return customer;
  };
  const demoLead = (name) => {
    const lead = leadByCustomerId.get(demoCustomer(name).id);
    if (!lead) throw new Error(`Demo lead for ${name} is missing.`);
    return lead;
  };

  const brandRows = await select('vehicle_brands', {
    select: 'id',
    organization_id: `eq.${organizationId}`,
    name: 'eq.Demo Motors',
    limit: '1',
  });
  const brand =
    brandRows[0] ??
    (
      await insert('vehicle_brands', {
        organization_id: organizationId,
        name: 'Demo Motors',
      })
    )[0];
  const modelRows = await select('vehicle_models', {
    select: 'id',
    organization_id: `eq.${organizationId}`,
    brand_id: `eq.${brand.id}`,
    name: 'eq.Demo SUV',
    limit: '1',
  });
  const model =
    modelRows[0] ??
    (
      await insert('vehicle_models', {
        organization_id: organizationId,
        brand_id: brand.id,
        name: 'Demo SUV',
      })
    )[0];
  const variantRows = await select('vehicle_variants', {
    select: 'id',
    organization_id: `eq.${organizationId}`,
    model_id: `eq.${model.id}`,
    name: 'eq.Demo SUV Premium',
    limit: '1',
  });
  const variant =
    variantRows[0] ??
    (
      await insert('vehicle_variants', {
        organization_id: organizationId,
        model_id: model.id,
        name: 'Demo SUV Premium',
        specifications: { fuel: 'EV', range_km: 420 },
      })
    )[0];
  const stock =
    existingStock[0] ??
    (
      await insert('stock_units', {
        organization_id: organizationId,
        branch_id: branchId,
        variant_id: variant.id,
        vin: 'TSTAA123456789012',
        chassis_number: 'TSTCHASSIS000001',
        color: 'Ocean Blue',
        status: 'AVAILABLE',
        received_at: new Date().toISOString(),
      })
    )[0];

  const appointment = (
    await insert('appointments', {
      organization_id: organizationId,
      branch_id: branchId,
      team_id: teamId,
      lead_id: demoLead('Kabir Singh').id,
      customer_id: demoCustomer('Kabir Singh').id,
      assigned_user_id: users.salesConsultant,
      appointment_type: 'Showroom Visit',
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'SCHEDULED',
      notes: 'Demo appointment for acceptance testing.',
    })
  )[0];
  await insert('followups', {
    organization_id: organizationId,
    branch_id: branchId,
    team_id: teamId,
    lead_id: demoLead('Diya Nair').id,
    customer_id: demoCustomer('Diya Nair').id,
    assigned_user_id: users.telecaller,
    reason: 'Confirm showroom visit',
    due_at: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'OPEN',
    created_by: users.clientAdmin,
  });
  await insert('tasks', {
    organization_id: organizationId,
    branch_id: branchId,
    team_id: teamId,
    assigned_user_id: users.salesConsultant,
    resource_type: 'lead',
    resource_id: demoLead('Kabir Singh').id,
    title: 'Send quotation follow-up',
    description: 'Demo task for the qualified lead.',
    priority: 'HIGH',
    due_at: new Date(Date.now() + 7_200_000).toISOString(),
    created_by: users.clientAdmin,
  });
  await insert('calls', {
    organization_id: organizationId,
    branch_id: branchId,
    team_id: teamId,
    lead_id: demoLead('Diya Nair').id,
    customer_id: demoCustomer('Diya Nair').id,
    assigned_user_id: users.telecaller,
    direction: 'OUTBOUND',
    call_source: 'PERSONAL_MANUAL',
    started_at: new Date(Date.now() - 1_800_000).toISOString(),
    ended_at: new Date(Date.now() - 1_620_000).toISOString(),
    duration_seconds: 180,
    outcome: 'Interested in weekend test drive',
    status: 'COMPLETED',
  });
  const testDriveAppointment = (
    await insert('test_drive_appointments', {
      organization_id: organizationId,
      branch_id: branchId,
      team_id: teamId,
      customer_id: demoCustomer('Kabir Singh').id,
      lead_id: demoLead('Kabir Singh').id,
      assigned_user_id: users.salesConsultant,
      stock_unit_id: stock.id,
      scheduled_at: new Date(Date.now() + 172_800_000).toISOString(),
      status: 'SCHEDULED',
      destination: { latitude: 12.9716, longitude: 77.5946, label: 'Demo route' },
    })
  )[0];
  await insert('test_drives', {
    organization_id: organizationId,
    branch_id: branchId,
    team_id: teamId,
    appointment_id: testDriveAppointment.id,
    customer_id: demoCustomer('Kabir Singh').id,
    lead_id: demoLead('Kabir Singh').id,
    assigned_user_id: users.salesConsultant,
    status: 'READY',
  });
  const quotation = (
    await insert('quotations', {
      organization_id: organizationId,
      branch_id: branchId,
      team_id: teamId,
      customer_id: demoCustomer('Rohan Patel').id,
      lead_id: demoLead('Rohan Patel').id,
      assigned_user_id: users.salesConsultant,
      quotation_number: 'DEMO-Q-0001',
      status: 'DRAFT',
      current_version: 1,
      total_amount: 1850000,
    })
  )[0];
  await insert('quotation_items', {
    organization_id: organizationId,
    quotation_id: quotation.id,
    item_type: 'VEHICLE',
    description: 'Demo SUV Premium',
    quantity: 1,
    unit_price: 1850000,
  });
  const booking = (
    await insert('bookings', {
      organization_id: organizationId,
      branch_id: branchId,
      team_id: teamId,
      customer_id: demoCustomer('Rohan Patel').id,
      lead_id: demoLead('Rohan Patel').id,
      quotation_id: quotation.id,
      assigned_user_id: users.salesConsultant,
      booking_number: 'DEMO-B-0001',
      status: 'CONFIRMED',
      booking_amount: 50000,
      total_value: 1850000,
      finance_required: true,
      expected_delivery_date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    })
  )[0];
  await insert('finance_cases', {
    organization_id: organizationId,
    branch_id: branchId,
    booking_id: booking.id,
    customer_id: demoCustomer('Rohan Patel').id,
    assigned_user_id: users.financeManager,
    status: 'DOCUMENTS_PENDING',
    lender: 'Demo Finance Bank',
    application_reference: 'DEMO-FIN-0001',
  });
  await insert('insurance_cases', {
    organization_id: organizationId,
    branch_id: branchId,
    booking_id: booking.id,
    customer_id: demoCustomer('Rohan Patel').id,
    assigned_user_id: users.insuranceManager,
    status: 'QUOTE_PENDING',
    insurer: 'Demo Insurance',
  });
  await insert('rto_cases', {
    organization_id: organizationId,
    branch_id: branchId,
    booking_id: booking.id,
    customer_id: demoCustomer('Rohan Patel').id,
    assigned_user_id: users.rtoManager,
    status: 'NEW',
  });
  await insert('delivery_cases', {
    organization_id: organizationId,
    branch_id: branchId,
    booking_id: booking.id,
    customer_id: demoCustomer('Rohan Patel').id,
    assigned_user_id: users.deliveryManager,
    status: 'PLANNING',
    scheduled_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });
  await insert('complaints', {
    organization_id: organizationId,
    branch_id: branchId,
    customer_id: demoCustomer('Ananya Rao').id,
    assigned_user_id: users.customerRelationshipManager,
    category: 'Follow-up delay',
    description: 'Demo customer-care case for workflow testing.',
    priority: 'MEDIUM',
    status: 'OPEN',
  });
  await insert('feedback_requests', {
    organization_id: organizationId,
    branch_id: branchId,
    customer_id: demoCustomer('Rohan Patel').id,
    booking_id: booking.id,
    channel: 'EMAIL',
    status: 'PENDING',
  });
  await insert(
    'activities',
    leads.map((lead) => ({
      organization_id: organizationId,
      customer_id: lead.customer_id,
      lead_id: lead.id,
      activity_type: 'demo.seeded',
      actor_id: users.clientAdmin,
      metadata: { fixture: true },
    })),
  );

  return { seeded: true, customers: customers.length, leads: leads.length };
}

async function seedDemoTeamExperience({ organizationId, branchId, teamId, users }) {
  // Extra colleagues make the demo behave like a real sales team: each
  // consultant/telecaller owns distinct work, while the Team Manager can see
  // the combined team queue. This stays separate from the core fixture so a
  // rerun can safely extend an already-seeded tenant.
  const fixtures = [
    {
      key: 'sales-2',
      fullName: 'Ishaan Verma',
      phone: '+919100000007',
      email: 'ishaan.verma@example.test',
      source: 'Instagram',
      model: 'Punch EV',
      lifecycle: 'New',
      temperature: 'HOT',
      assignedUserId: users.salesConsultantTwo,
      workKind: 'FOLLOWUP',
    },
    {
      key: 'sales-3',
      fullName: 'Nisha Kapoor',
      phone: '+919100000008',
      email: 'nisha.kapoor@example.test',
      source: 'Website',
      model: 'Safari',
      lifecycle: 'Qualified',
      temperature: 'WARM',
      assignedUserId: users.salesConsultantThree,
      workKind: 'APPOINTMENT',
    },
    {
      key: 'telecaller-2',
      fullName: 'Arjun Menon',
      phone: '+919100000009',
      email: 'arjun.menon@example.test',
      source: 'Google Ads',
      model: 'Nexon EV',
      lifecycle: 'Contacted',
      temperature: 'WARM',
      assignedUserId: users.telecallerTwo,
      workKind: 'CALLBACK',
    },
  ];

  for (const fixture of fixtures) {
    const customer = await ensureRecord(
      'customers',
      {
        organization_id: `eq.${organizationId}`,
        normalized_phone: `eq.${fixture.phone}`,
        deleted_at: 'is.null',
      },
      {
        organization_id: organizationId,
        full_name: fixture.fullName,
        primary_phone: fixture.phone,
        normalized_phone: fixture.phone,
        primary_email: fixture.email,
        created_by: users.clientAdmin,
      },
    );
    const lead = await ensureRecord(
      'leads',
      {
        organization_id: `eq.${organizationId}`,
        external_lead_id: `eq.demo-team-${fixture.key}`,
        deleted_at: 'is.null',
      },
      {
        organization_id: organizationId,
        branch_id: branchId,
        team_id: teamId,
        customer_id: customer.id,
        source: fixture.source,
        source_detail: 'Demo team fixture',
        external_lead_id: `demo-team-${fixture.key}`,
        campaign: 'Demo multi-user sales queue',
        customer_name: fixture.fullName,
        phone: fixture.phone,
        normalized_phone: fixture.phone,
        email: fixture.email,
        interested_model: fixture.model,
        lifecycle_status: fixture.lifecycle,
        temperature: fixture.temperature,
        assigned_user_id: fixture.assignedUserId,
        first_contacted_at:
          fixture.lifecycle === 'New' ? null : new Date(Date.now() - 90 * 60_000).toISOString(),
        next_followup_at: new Date(Date.now() + 90 * 60_000).toISOString(),
        sla_due_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      },
    );

    if (fixture.workKind === 'APPOINTMENT') {
      await ensureRecord(
        'appointments',
        {
          organization_id: `eq.${organizationId}`,
          lead_id: `eq.${lead.id}`,
          appointment_type: 'eq.Demo team appointment',
        },
        {
          organization_id: organizationId,
          branch_id: branchId,
          team_id: teamId,
          lead_id: lead.id,
          customer_id: customer.id,
          assigned_user_id: fixture.assignedUserId,
          appointment_type: 'Demo team appointment',
          scheduled_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          status: 'SCHEDULED',
          notes: 'Demo appointment owned by the second Sales Consultant.',
        },
      );
    } else {
      await ensureRecord(
        'followups',
        {
          organization_id: `eq.${organizationId}`,
          lead_id: `eq.${lead.id}`,
          reason: `eq.Demo ${fixture.workKind.toLowerCase()} for ${fixture.key}`,
        },
        {
          organization_id: organizationId,
          branch_id: branchId,
          team_id: teamId,
          lead_id: lead.id,
          customer_id: customer.id,
          assigned_user_id: fixture.assignedUserId,
          reason: `Demo ${fixture.workKind.toLowerCase()} for ${fixture.key}`,
          due_at: new Date(Date.now() + 90 * 60_000).toISOString(),
          status: 'OPEN',
          created_by: users.clientAdmin,
        },
      );
    }

    if (fixture.workKind === 'CALLBACK') {
      await ensureRecord(
        'calls',
        {
          organization_id: `eq.${organizationId}`,
          lead_id: `eq.${lead.id}`,
          outcome: 'eq.Demo callback arranged',
        },
        {
          organization_id: organizationId,
          branch_id: branchId,
          team_id: teamId,
          lead_id: lead.id,
          customer_id: customer.id,
          assigned_user_id: fixture.assignedUserId,
          direction: 'OUTBOUND',
          call_source: 'PERSONAL_MANUAL',
          started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
          ended_at: new Date(Date.now() - 55 * 60_000).toISOString(),
          duration_seconds: 300,
          outcome: 'Demo callback arranged',
          status: 'COMPLETED',
        },
      );
    }
  }

  return { extra_team_users: 3, extra_team_leads: fixtures.length };
}

async function seedDemoAdditionalTeamExperience({ organizationId, branchId, teams, users }) {
  const fixtures = [
    {
      key: 'bravo-sales-1',
      teamId: teams.bravo,
      assignedUserId: users.salesConsultantFour,
      fullName: 'Kavya Reddy',
      phone: '+919100000010',
      email: 'kavya.reddy@example.test',
      source: 'Facebook',
      model: 'Curvv EV',
      lifecycle: 'New',
      temperature: 'HOT',
    },
    {
      key: 'bravo-sales-2',
      teamId: teams.bravo,
      assignedUserId: users.salesConsultantFive,
      fullName: 'Dev Malhotra',
      phone: '+919100000011',
      email: 'dev.malhotra@example.test',
      source: 'CarDekho',
      model: 'Harrier',
      lifecycle: 'Qualified',
      temperature: 'WARM',
    },
    {
      key: 'bravo-telecaller-1',
      teamId: teams.bravo,
      assignedUserId: users.telecallerThree,
      fullName: 'Sana Khan',
      phone: '+919100000012',
      email: 'sana.khan@example.test',
      source: 'Google Ads',
      model: 'Nexon EV',
      lifecycle: 'Contacted',
      temperature: 'WARM',
    },
    {
      key: 'charlie-sales-1',
      teamId: teams.charlie,
      assignedUserId: users.salesConsultantSix,
      fullName: 'Varun Shah',
      phone: '+919100000013',
      email: 'varun.shah@example.test',
      source: 'Instagram',
      model: 'Punch EV',
      lifecycle: 'New',
      temperature: 'HOT',
    },
    {
      key: 'charlie-sales-2',
      teamId: teams.charlie,
      assignedUserId: users.salesConsultantSeven,
      fullName: 'Priya Das',
      phone: '+919100000014',
      email: 'priya.das@example.test',
      source: 'Website',
      model: 'Safari',
      lifecycle: 'Appointment Scheduled',
      temperature: 'WARM',
    },
    {
      key: 'charlie-telecaller-1',
      teamId: teams.charlie,
      assignedUserId: users.telecallerFour,
      fullName: 'Aditya Bose',
      phone: '+919100000015',
      email: 'aditya.bose@example.test',
      source: 'WhatsApp Business',
      model: 'Altroz',
      lifecycle: 'Contacted',
      temperature: 'COLD',
    },
  ];

  for (const fixture of fixtures) {
    const customer = await ensureRecord(
      'customers',
      {
        organization_id: `eq.${organizationId}`,
        normalized_phone: `eq.${fixture.phone}`,
        deleted_at: 'is.null',
      },
      {
        organization_id: organizationId,
        full_name: fixture.fullName,
        primary_phone: fixture.phone,
        normalized_phone: fixture.phone,
        primary_email: fixture.email,
        created_by: users.clientAdmin,
      },
    );
    const lead = await ensureRecord(
      'leads',
      {
        organization_id: `eq.${organizationId}`,
        external_lead_id: `eq.demo-${fixture.key}`,
        deleted_at: 'is.null',
      },
      {
        organization_id: organizationId,
        branch_id: branchId,
        team_id: fixture.teamId,
        customer_id: customer.id,
        source: fixture.source,
        source_detail: 'Demo multi-team fixture',
        external_lead_id: `demo-${fixture.key}`,
        campaign: 'Demo three-team sales queue',
        customer_name: fixture.fullName,
        phone: fixture.phone,
        normalized_phone: fixture.phone,
        email: fixture.email,
        interested_model: fixture.model,
        lifecycle_status: fixture.lifecycle,
        temperature: fixture.temperature,
        assigned_user_id: fixture.assignedUserId,
        first_contacted_at:
          fixture.lifecycle === 'New' ? null : new Date(Date.now() - 2 * 3_600_000).toISOString(),
        next_followup_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        sla_due_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      },
    );
    await ensureRecord(
      'followups',
      {
        organization_id: `eq.${organizationId}`,
        lead_id: `eq.${lead.id}`,
        reason: `eq.Demo ${fixture.key} follow-up`,
      },
      {
        organization_id: organizationId,
        branch_id: branchId,
        team_id: fixture.teamId,
        lead_id: lead.id,
        customer_id: customer.id,
        assigned_user_id: fixture.assignedUserId,
        reason: `Demo ${fixture.key} follow-up`,
        due_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        status: 'OPEN',
        created_by: users.clientAdmin,
      },
    );
  }

  return { additional_sales_teams: 2, additional_team_leads: fixtures.length };
}

async function seedDemoNotifications({ organizationId, users }) {
  const fixtures = [
    {
      userId: users.sales_consultant,
      eventType: 'demo.lead_assigned',
      title: 'New lead assigned',
      body: 'Aarav Sharma is waiting for your first contact.',
      minutesAgo: 4,
    },
    {
      userId: users.sales_consultant,
      eventType: 'demo.followup_due',
      title: 'Follow-up due today',
      body: 'Confirm the preferred model and showroom visit time.',
      minutesAgo: 42,
    },
    {
      userId: users.sales_consultant,
      eventType: 'demo.booking_ready',
      title: 'Booking is ready for review',
      body: 'Rohan Patel has a confirmed demo booking.',
      minutesAgo: 125,
    },
    {
      userId: users.team_manager,
      eventType: 'demo.team_queue',
      title: 'Team queue updated',
      body: 'Three new leads were distributed across your sales team.',
      minutesAgo: 10,
    },
    {
      userId: users.telecaller_bdc,
      eventType: 'demo.callback_due',
      title: 'Callback due soon',
      body: 'A customer callback is scheduled within the next hour.',
      minutesAgo: 20,
    },
  ];

  for (const fixture of fixtures) {
    await ensureRecord(
      'notifications',
      {
        organization_id: `eq.${organizationId}`,
        user_id: `eq.${fixture.userId}`,
        event_type: `eq.${fixture.eventType}`,
      },
      {
        organization_id: organizationId,
        user_id: fixture.userId,
        event_type: fixture.eventType,
        title: fixture.title,
        body: fixture.body,
        created_at: new Date(Date.now() - fixture.minutesAgo * 60_000).toISOString(),
      },
    );
  }
  return { notifications: fixtures.length };
}

async function seedDemoConnectedExperience({ organizationId, branchId, teamId, users }) {
  const [customers, leads, bookingRows, complaintRows] = await Promise.all([
    select('customers', {
      select: 'id,full_name,primary_phone',
      organization_id: `eq.${organizationId}`,
      order: 'created_at.asc',
      limit: '20',
    }),
    select('leads', {
      select: 'id,customer_id,branch_id,team_id',
      organization_id: `eq.${organizationId}`,
      source_detail: 'eq.Demo fixture',
      order: 'created_at.asc',
      limit: '20',
    }),
    select('bookings', {
      select: 'id,customer_id,lead_id',
      organization_id: `eq.${organizationId}`,
      booking_number: 'eq.DEMO-B-0001',
      limit: '1',
    }),
    select('complaints', {
      select: 'id',
      organization_id: `eq.${organizationId}`,
      category: 'eq.Follow-up delay',
      limit: '1',
    }),
  ]);
  const customerByName = new Map(customers.map((customer) => [customer.full_name, customer]));
  const leadByCustomerId = new Map(leads.map((lead) => [lead.customer_id, lead]));
  const customer = (name) => {
    const row = customerByName.get(name);
    if (!row) throw new Error(`Demo customer ${name} is missing.`);
    return row;
  };
  const lead = (name) => {
    const row = leadByCustomerId.get(customer(name).id);
    if (!row) throw new Error(`Demo lead for ${name} is missing.`);
    return row;
  };

  const now = new Date();
  const recent = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const demoConnections = [
    {
      providerKey: 'meta',
      externalAccountId: 'demo-meta-lead-ads-account',
      displayName: 'Demo simulation — Meta Lead Ads',
      authType: 'OAUTH2',
      assetType: 'META_PAGE',
      assetId: 'demo-meta-page-1001',
      assetLabel: 'Demo Motors Facebook Page',
    },
    {
      providerKey: 'google_ads',
      externalAccountId: 'demo-google-ads-account',
      displayName: 'Demo simulation — Google Ads',
      authType: 'OAUTH2',
      assetType: 'GOOGLE_ADS_CUSTOMER',
      assetId: 'demo-google-customer-1001',
      assetLabel: 'Demo Motors Google Ads account',
    },
    {
      providerKey: 'google_business_profile',
      externalAccountId: 'demo-google-business-profile',
      displayName: 'Demo simulation — Google Business Profile',
      authType: 'OAUTH2',
      assetType: 'GBP_LOCATION',
      assetId: 'demo-gbp-location-1001',
      assetLabel: 'Bengaluru Demo Showroom',
    },
    {
      providerKey: 'whatsapp_cloud',
      externalAccountId: 'demo-whatsapp-business-account',
      displayName: 'Demo simulation — WhatsApp Business',
      authType: 'WEBHOOK_SECRET',
      assetType: 'WHATSAPP_PHONE_NUMBER',
      assetId: 'demo-whatsapp-number-1001',
      assetLabel: '+91 80000 00001 (simulation)',
    },
  ];

  const connections = new Map();
  for (const config of demoConnections) {
    const connection = await ensureRecord(
      'connected_accounts',
      {
        organization_id: `eq.${organizationId}`,
        provider_key: `eq.${config.providerKey}`,
        external_account_id: `eq.${config.externalAccountId}`,
        deleted_at: 'is.null',
      },
      {
        organization_id: organizationId,
        provider_key: config.providerKey,
        display_name: config.displayName,
        scope_mode: 'ONE_BRANCH',
        // This status is deliberately only a UI fixture. No credential row is
        // created and no provider call is ever made by this seed script.
        status: 'CONNECTED',
        external_account_id: config.externalAccountId,
        auth_type: config.authType,
        connection_config: {
          demo_fixture: true,
          simulation_notice: 'No live credentials or external provider account is connected.',
        },
        connected_at: recent(180),
        last_tested_at: recent(90),
        last_sync_at: recent(15),
        default_team_id: teamId,
        created_by: users.clientAdmin,
      },
    );
    connections.set(config.providerKey, connection);
    await ensureRecord(
      'integration_branch_mappings',
      {
        connected_account_id: `eq.${connection.id}`,
        branch_id: `eq.${branchId}`,
        external_resource_type: 'eq.CONNECTION_SCOPE',
        external_resource_id: `eq.scope-${branchId}`,
      },
      {
        organization_id: organizationId,
        connected_account_id: connection.id,
        branch_id: branchId,
        team_id: teamId,
        external_resource_type: 'CONNECTION_SCOPE',
        external_resource_id: `scope-${branchId}`,
        external_resource_label: 'Bengaluru Demo Showroom scope',
        mapping_metadata: { demo_fixture: true },
      },
    );
    await ensureRecord(
      'integration_branch_mappings',
      {
        connected_account_id: `eq.${connection.id}`,
        branch_id: `eq.${branchId}`,
        external_resource_type: `eq.${config.assetType}`,
        external_resource_id: `eq.${config.assetId}`,
      },
      {
        organization_id: organizationId,
        connected_account_id: connection.id,
        branch_id: branchId,
        team_id: teamId,
        external_resource_type: config.assetType,
        external_resource_id: config.assetId,
        external_resource_label: config.assetLabel,
        mapping_metadata: { demo_fixture: true, simulated: true },
      },
    );

    const eventId = `demo-${config.providerKey}-receipt-001`;
    const payload = { demo_fixture: true, provider: config.providerKey, received: 'simulated' };
    await ensureRecord(
      'provider_events',
      {
        organization_id: `eq.${organizationId}`,
        connected_account_id: `eq.${connection.id}`,
        provider_event_id: `eq.${eventId}`,
      },
      {
        organization_id: organizationId,
        connected_account_id: connection.id,
        provider_event_id: eventId,
        event_type: 'DEMO_CONNECTION_VALIDATED',
        payload_hash: demoPayloadHash(payload),
        payload,
        status: 'TEST_VALIDATED',
        received_at: recent(20),
        processed_at: recent(19),
      },
    );
    await ensureRecord(
      'sync_runs',
      {
        organization_id: `eq.${organizationId}`,
        connected_account_id: `eq.${connection.id}`,
        sync_type: 'eq.DEMO_SIMULATION',
      },
      {
        organization_id: organizationId,
        connected_account_id: connection.id,
        sync_type: 'DEMO_SIMULATION',
        status: 'COMPLETED',
        records_processed: config.providerKey === 'whatsapp_cloud' ? 2 : 1,
        started_at: recent(30),
        completed_at: recent(29),
      },
    );
  }

  const whatsapp = connections.get('whatsapp_cloud');
  const meta = connections.get('meta');
  const googleAds = connections.get('google_ads');
  if (!whatsapp || !meta || !googleAds) throw new Error('Demo connections were not created.');

  const diya = customer('Diya Nair');
  const diyaLead = lead('Diya Nair');
  const conversation = await ensureRecord(
    'conversations',
    {
      organization_id: `eq.${organizationId}`,
      connection_id: `eq.${whatsapp.id}`,
      external_thread_id: 'eq.demo-wa-thread-diya-001',
    },
    {
      organization_id: organizationId,
      branch_id: branchId,
      lead_id: diyaLead.id,
      customer_id: diya.id,
      connection_id: whatsapp.id,
      channel: 'WHATSAPP_BUSINESS',
      external_thread_id: 'demo-wa-thread-diya-001',
      external_contact: diya.primary_phone,
      normalized_contact: diya.primary_phone,
      assigned_user_id: users.telecaller,
      status: 'OPEN',
      last_message_at: recent(12),
      service_window_expires_at: new Date(now.getTime() + 23 * 60 * 60_000).toISOString(),
    },
  );
  for (const message of [
    {
      provider_message_id: 'demo-wa-in-001',
      direction: 'INBOUND',
      body: 'Hi, I would like a weekend test-drive slot for the Demo SUV.',
      delivery_status: 'DELIVERED',
      sent_by: null,
      sent_at: recent(16),
    },
    {
      provider_message_id: 'demo-wa-out-001',
      direction: 'OUTBOUND',
      body: 'Thanks, Diya. We have reserved a slot and will call you shortly.',
      delivery_status: 'READ',
      sent_by: users.telecaller,
      sent_at: recent(12),
    },
  ]) {
    await ensureRecord(
      'conversation_messages',
      {
        organization_id: `eq.${organizationId}`,
        conversation_id: `eq.${conversation.id}`,
        provider_message_id: `eq.${message.provider_message_id}`,
      },
      {
        organization_id: organizationId,
        conversation_id: conversation.id,
        metadata: { demo_fixture: true },
        ...message,
      },
    );
  }

  const marketingActor = users.digitalMarketingManager ?? users.clientAdmin;
  const metaCampaign = await ensureRecord(
    'marketing_campaigns',
    {
      organization_id: `eq.${organizationId}`,
      connected_account_id: `eq.${meta.id}`,
      external_campaign_id: 'eq.demo-meta-monsoon-suv-001',
    },
    {
      organization_id: organizationId,
      branch_id: branchId,
      connected_account_id: meta.id,
      name: 'Demo Monsoon SUV Lead Campaign',
      platform: 'META',
      canonical_source: 'Facebook',
      external_campaign_id: 'demo-meta-monsoon-suv-001',
      status: 'ACTIVE',
      starts_on: now.toISOString().slice(0, 10),
      budget_amount: 75000,
      notes: 'Demo simulation only. No external campaign is connected.',
      created_by: marketingActor,
    },
  );
  const googleCampaign = await ensureRecord(
    'marketing_campaigns',
    {
      organization_id: `eq.${organizationId}`,
      connected_account_id: `eq.${googleAds.id}`,
      external_campaign_id: 'eq.demo-google-test-drive-001',
    },
    {
      organization_id: organizationId,
      branch_id: branchId,
      connected_account_id: googleAds.id,
      name: 'Demo Search — Test Drive Enquiries',
      platform: 'GOOGLE_ADS',
      canonical_source: 'Google Ads',
      external_campaign_id: 'demo-google-test-drive-001',
      status: 'ACTIVE',
      starts_on: now.toISOString().slice(0, 10),
      budget_amount: 60000,
      notes: 'Demo simulation only. No external campaign is connected.',
      created_by: marketingActor,
    },
  );
  for (const post of [
    {
      platform: 'FACEBOOK',
      campaign_id: metaCampaign.id,
      connected_account_id: meta.id,
      content: 'Demo post: Experience the new electric SUV at our Bengaluru showroom this weekend.',
      status: 'PUBLISHED',
      provider_post_id: 'demo-fb-post-001',
      published_at: recent(60),
    },
    {
      platform: 'OTHER',
      campaign_id: googleCampaign.id,
      connected_account_id: googleAds.id,
      content: 'Demo draft: Book a test drive and discover our latest showroom offers.',
      status: 'SCHEDULED',
      provider_post_id: null,
      scheduled_for: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    },
  ]) {
    await ensureRecord(
      'social_posts',
      {
        organization_id: `eq.${organizationId}`,
        content: `eq.${post.content}`,
      },
      {
        organization_id: organizationId,
        branch_id: branchId,
        created_by: marketingActor,
        media_object_file_ids: [],
        ...post,
      },
    );
  }

  const booking = bookingRows[0];
  if (booking) {
    await ensureRecord(
      'exchange_cases',
      {
        organization_id: `eq.${organizationId}`,
        booking_id: `eq.${booking.id}`,
      },
      {
        organization_id: organizationId,
        branch_id: branchId,
        booking_id: booking.id,
        customer_id: booking.customer_id,
        assigned_user_id: users.exchangeManager,
        status: 'REQUESTED',
        estimated_value: 420000,
      },
    );
  }
  if (complaintRows[0]) {
    await ensureRecord(
      'escalations',
      {
        organization_id: `eq.${organizationId}`,
        resource_type: 'eq.complaint',
        resource_id: `eq.${complaintRows[0].id}`,
      },
      {
        organization_id: organizationId,
        branch_id: branchId,
        resource_type: 'complaint',
        resource_id: complaintRows[0].id,
        assigned_user_id: users.customerRelationshipManager,
        reason: 'Demo escalation: customer requested a manager callback.',
        severity: 'MEDIUM',
        status: 'OPEN',
      },
    );
  }

  return {
    simulated_connections: connections.size,
    simulated_provider_events: demoConnections.length,
    simulated_campaigns: 2,
    simulated_messages: 2,
  };
}

async function main() {
  await insert('modules', moduleCatalog, { onConflict: 'module_key' });
  await insert('permissions', corePermissionCatalog, { onConflict: 'permission_key' });

  const superAdminEmail = emailFor('super_admin');
  const superAdminAuth = await ensureAuthUser(superAdminEmail, 'Demo Platform Super Admin');
  await ensureProfile({
    userId: superAdminAuth.id,
    organizationId: null,
    fullName: 'Demo Platform Super Admin',
    email: superAdminEmail,
    mfaRequired: true,
    employeeId: 'DEMO-SUPER-ADMIN',
  });
  const platformRole = await first(
    'roles',
    {
      select: 'id',
      organization_id: 'is.null',
      role_key: 'eq.super_admin',
    },
    'Global Super Admin role is missing.',
  );
  await ensureRoleAssignment({
    organizationId: null,
    userId: superAdminAuth.id,
    roleId: platformRole.id,
    scope: 'PLATFORM',
    grantedBy: null,
  });

  let organization = await select('organizations', {
    select: 'id,status,primary_owner_id',
    slug: `eq.${DEMO_SLUG}`,
    limit: '1',
  });
  let ownerId;
  if (organization.length === 0) {
    const ownerEmail = emailFor('business_owner');
    const ownerAuth = await ensureAuthUser(ownerEmail, 'Demo Business Owner');
    const [createdOrganization] = await insert('organizations', {
      name: 'Go Digital Demo Motors (Test Only)',
      slug: DEMO_SLUG,
      legal_name: 'Go Digital Demo Motors Private Limited',
      gst_number: '29ABCDE1234F1Z5',
      status: 'ACTIVE',
    });
    await ensureProfile({
      userId: ownerAuth.id,
      organizationId: createdOrganization.id,
      fullName: 'Demo Business Owner',
      email: ownerEmail,
      mfaRequired: true,
      employeeId: 'DEMO-BUSINESS-OWNER',
    });
    organization = [
      { id: createdOrganization.id, status: 'ACTIVE', primary_owner_id: ownerAuth.id },
    ];
    ownerId = ownerAuth.id;
  } else {
    ownerId = organization[0].primary_owner_id;
  }
  const organizationId = organization[0].id;
  await insert(
    'roles',
    rolePresets.map(([role_key, name, authority_level, mfa_required]) => ({
      organization_id: organizationId,
      role_key,
      name,
      authority_level,
      system_role: true,
      mfa_required,
    })),
    { onConflict: 'organization_id,role_key' },
  );
  const ownerRole = await first(
    'roles',
    {
      select: 'id',
      organization_id: `eq.${organizationId}`,
      role_key: 'eq.business_owner',
    },
    'Business Owner role is missing.',
  );
  await ensureRoleAssignment({
    organizationId,
    userId: ownerId,
    roleId: ownerRole.id,
    scope: 'ORGANIZATION',
    grantedBy: superAdminAuth.id,
  });
  await patch(
    'organizations',
    { id: `eq.${organizationId}` },
    { primary_owner_id: ownerId, status: 'ACTIVE' },
  );

  const permissionRows = await select('permissions', { select: 'id,permission_key' });
  const permissionIdByKey = new Map(
    permissionRows.map((permission) => [permission.permission_key, permission.id]),
  );
  const tenantRoles = await select('roles', {
    select: 'id,role_key',
    organization_id: `eq.${organizationId}`,
  });
  const broadRoles = new Set(['client_admin', 'system_administrator']);
  const salesRoles = new Set([
    'gm_sales',
    'showroom_manager',
    'team_manager',
    'sales_consultant',
    'telecaller_bdc',
  ]);
  const rolePermissionPrefixes = {
    business_owner: [
      'customer.',
      'lead.',
      'quotation.',
      'booking.',
      'inventory.',
      'finance.',
      'insurance.',
      'rto.',
      'exchange.',
      'delivery.',
      'customer_care.',
      'marketing.',
      'call.',
      'message.',
      'document.',
      'audit.',
      'credit.',
      'support.',
    ],
    inventory_manager: ['inventory.', 'customer.', 'booking.', 'quotation.', 'document.'],
    finance_manager: ['finance.', 'customer.', 'booking.', 'quotation.', 'document.'],
    insurance_manager: ['insurance.', 'customer.', 'booking.', 'quotation.', 'document.'],
    rto_manager: ['rto.', 'customer.', 'booking.', 'document.'],
    exchange_manager: ['exchange.', 'customer.', 'booking.', 'inventory.', 'document.'],
    delivery_manager: ['delivery.', 'customer.', 'booking.', 'inventory.', 'document.'],
    customer_relationship_manager: [
      'customer_care.',
      'customer.',
      'lead.',
      'call.',
      'message.',
      'document.',
    ],
    digital_marketing_manager: [
      'marketing.',
      'lead.',
      'customer.',
      'integration.view',
      'document.',
    ],
  };
  const rolePermissionRows = [];
  for (const tenantRole of tenantRoles) {
    const allowedKeys = broadRoles.has(tenantRole.role_key)
      ? [...permissionIdByKey.keys()]
      : salesRoles.has(tenantRole.role_key)
        ? [...permissionIdByKey.keys()].filter((key) =>
            /^(customer|lead|call|message|task|test_drive|quotation|booking|document|email|approval)\./.test(
              key,
            ),
          )
        : [...permissionIdByKey.keys()].filter((key) =>
            (rolePermissionPrefixes[tenantRole.role_key] ?? ['customer.', 'document.']).some(
              (prefix) => key === prefix || key.startsWith(prefix),
            ),
          );
    for (const permissionKey of allowedKeys) {
      rolePermissionRows.push({
        role_id: tenantRole.id,
        permission_id: permissionIdByKey.get(permissionKey),
      });
    }
  }
  await insert('role_permissions', rolePermissionRows, { onConflict: 'role_id,permission_id' });

  const moduleRows = await select('modules', { select: 'id,module_key', order: 'module_key.asc' });
  await insert(
    'organization_module_entitlements',
    moduleRows.map((module) => ({
      organization_id: organizationId,
      module_id: module.id,
      enabled: true,
      limits: { demo_fixture: true },
    })),
    { onConflict: 'organization_id,module_id' },
  );

  const [branch] = await insert(
    'branches',
    {
      organization_id: organizationId,
      code: 'BLR-01',
      name: 'Bengaluru Demo Showroom',
      address: { city: 'Bengaluru', state: 'Karnataka', country: 'India' },
      contact_phone: '+918000000001',
      contact_email: `showroom@${DEMO_DOMAIN}`,
      timezone: 'Asia/Kolkata',
      working_hours: { mon_sat: '09:00-19:00' },
      showroom_category: 'Flagship',
      latitude: 12.9716,
      longitude: 77.5946,
    },
    { onConflict: 'organization_id,code' },
  );

  const [team] = await insert(
    'teams',
    {
      organization_id: organizationId,
      branch_id: branch.id,
      name: 'Demo Sales Team',
      fresh_assignment_mode: 'ROUND_ROBIN',
      qualified_assignment_mode: 'MANUAL_ASSIGNMENT',
    },
    { onConflict: 'organization_id,branch_id,name' },
  );
  const [teamBravo] = await insert(
    'teams',
    {
      organization_id: organizationId,
      branch_id: branch.id,
      name: 'Demo Sales Team Bravo',
      fresh_assignment_mode: 'ROUND_ROBIN',
      qualified_assignment_mode: 'MANUAL_ASSIGNMENT',
    },
    { onConflict: 'organization_id,branch_id,name' },
  );
  const [teamCharlie] = await insert(
    'teams',
    {
      organization_id: organizationId,
      branch_id: branch.id,
      name: 'Demo Sales Team Charlie',
      fresh_assignment_mode: 'ROUND_ROBIN',
      qualified_assignment_mode: 'MANUAL_ASSIGNMENT',
    },
    { onConflict: 'organization_id,branch_id,name' },
  );

  const clientAdminId = await ensureTenantUser({
    actorId: ownerId,
    organizationId,
    role: 'client_admin',
    fullName: 'Demo Client Admin',
    scope: 'ORGANIZATION',
  });
  const users = { clientAdmin: clientAdminId };
  for (const [role, fullName, scope] of roleAccounts) {
    const isTeamRole = ['team_manager', 'sales_consultant', 'telecaller_bdc'].includes(role);
    users[role] = await ensureTenantUser({
      actorId: clientAdminId,
      organizationId,
      role,
      fullName: `Demo ${fullName}`,
      scope,
      branchId: scope === 'ONE_BRANCH' ? branch.id : null,
      teamIds: isTeamRole ? [team.id] : [],
    });
  }
  users.sales_consultant_two = await ensureTenantUser({
    actorId: clientAdminId,
    organizationId,
    role: 'sales_consultant',
    emailKey: 'sales_consultant_2',
    fullName: 'Demo Sales Consultant 2',
    scope: 'OWN_RECORDS',
    branchId: branch.id,
    teamIds: [team.id],
  });
  users.sales_consultant_three = await ensureTenantUser({
    actorId: clientAdminId,
    organizationId,
    role: 'sales_consultant',
    emailKey: 'sales_consultant_3',
    fullName: 'Demo Sales Consultant 3',
    scope: 'OWN_RECORDS',
    branchId: branch.id,
    teamIds: [team.id],
  });
  users.telecaller_bdc_two = await ensureTenantUser({
    actorId: clientAdminId,
    organizationId,
    role: 'telecaller_bdc',
    emailKey: 'telecaller_bdc_2',
    fullName: 'Demo Telecaller 2',
    scope: 'OWN_RECORDS',
    branchId: branch.id,
    teamIds: [team.id],
  });
  users.team_manager_two = await ensureTenantUser({
    actorId: clientAdminId,
    organizationId,
    role: 'team_manager',
    emailKey: 'team_manager_2',
    fullName: 'Demo Team Manager 2',
    scope: 'OWN_TEAM',
    branchId: branch.id,
    teamIds: [teamBravo.id],
  });
  users.team_manager_three = await ensureTenantUser({
    actorId: clientAdminId,
    organizationId,
    role: 'team_manager',
    emailKey: 'team_manager_3',
    fullName: 'Demo Team Manager 3',
    scope: 'OWN_TEAM',
    branchId: branch.id,
    teamIds: [teamCharlie.id],
  });
  for (const [key, fullName, teamId] of [
    ['sales_consultant_4', 'Demo Sales Consultant 4', teamBravo.id],
    ['sales_consultant_5', 'Demo Sales Consultant 5', teamBravo.id],
    ['sales_consultant_6', 'Demo Sales Consultant 6', teamCharlie.id],
    ['sales_consultant_7', 'Demo Sales Consultant 7', teamCharlie.id],
  ]) {
    users[key] = await ensureTenantUser({
      actorId: clientAdminId,
      organizationId,
      role: 'sales_consultant',
      emailKey: key,
      fullName,
      scope: 'OWN_RECORDS',
      branchId: branch.id,
      teamIds: [teamId],
    });
  }
  for (const [key, fullName, teamId] of [
    ['telecaller_bdc_3', 'Demo Telecaller 3', teamBravo.id],
    ['telecaller_bdc_4', 'Demo Telecaller 4', teamCharlie.id],
  ]) {
    users[key] = await ensureTenantUser({
      actorId: clientAdminId,
      organizationId,
      role: 'telecaller_bdc',
      emailKey: key,
      fullName,
      scope: 'OWN_RECORDS',
      branchId: branch.id,
      teamIds: [teamId],
    });
  }

  const summary = await seedDemoRecords({
    organizationId,
    branchId: branch.id,
    teamId: team.id,
    users: {
      ...users,
      salesConsultant: users.sales_consultant,
      telecaller: users.telecaller_bdc,
      financeManager: users.finance_manager,
      insuranceManager: users.insurance_manager,
      rtoManager: users.rto_manager,
      deliveryManager: users.delivery_manager,
      customerRelationshipManager: users.customer_relationship_manager,
      exchangeManager: users.exchange_manager,
      digitalMarketingManager: users.digital_marketing_manager,
    },
  });
  const connectedExperience = await seedDemoConnectedExperience({
    organizationId,
    branchId: branch.id,
    teamId: team.id,
    users: {
      ...users,
      salesConsultant: users.sales_consultant,
      telecaller: users.telecaller_bdc,
      customerRelationshipManager: users.customer_relationship_manager,
      exchangeManager: users.exchange_manager,
      digitalMarketingManager: users.digital_marketing_manager,
    },
  });
  const teamExperience = await seedDemoTeamExperience({
    organizationId,
    branchId: branch.id,
    teamId: team.id,
    users: {
      clientAdmin: users.clientAdmin,
      salesConsultantTwo: users.sales_consultant_two,
      salesConsultantThree: users.sales_consultant_three,
      telecallerTwo: users.telecaller_bdc_two,
    },
  });
  const additionalTeamExperience = await seedDemoAdditionalTeamExperience({
    organizationId,
    branchId: branch.id,
    teams: { bravo: teamBravo.id, charlie: teamCharlie.id },
    users: {
      clientAdmin: users.clientAdmin,
      salesConsultantFour: users.sales_consultant_4,
      salesConsultantFive: users.sales_consultant_5,
      salesConsultantSix: users.sales_consultant_6,
      salesConsultantSeven: users.sales_consultant_7,
      telecallerThree: users.telecaller_bdc_3,
      telecallerFour: users.telecaller_bdc_4,
    },
  });
  const notificationExperience = await seedDemoNotifications({ organizationId, users });

  console.log(
    JSON.stringify(
      {
        organization_slug: DEMO_SLUG,
        organization_id: organizationId,
        test_account_count: 28,
        seeded_records: {
          ...summary,
          ...connectedExperience,
          ...teamExperience,
          ...additionalTeamExperience,
          ...notificationExperience,
        },
        credential_location: '.env → DEMO_TEST_PASSWORD',
        account_email_pattern: `role-key-with-dashes@${DEMO_DOMAIN}`,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
