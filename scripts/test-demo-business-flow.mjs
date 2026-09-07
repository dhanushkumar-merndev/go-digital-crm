/*
 * Executes a representative, authenticated business flow against the isolated
 * `go-digital-demo-test` tenant. It intentionally creates audit-marked demo
 * records and never uses a production tenant or prints credentials/customer data.
 *
 * Run: pnpm test:demo:flow
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEMO_DOMAIN = 'demo.go-digital.invalid';
const MARKER = 'Automated isolated-demo workflow verification';

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

async function json(response) {
  const body = await response.text();
  const payload = body ? JSON.parse(body) : null;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
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

function requestId() {
  return crypto.randomUUID();
}

function dateAfter(days) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

async function stage(name, action) {
  await action();
  console.log(`passed: ${name}`);
}

async function main() {
  const salesToken = await sessionFor('sales_consultant');
  const inventoryToken = await sessionFor('inventory_manager');
  const financeToken = await sessionFor('finance_manager');
  const insuranceToken = await sessionFor('insurance_manager');
  const rtoToken = await sessionFor('rto_manager');
  const exchangeToken = await sessionFor('exchange_manager');
  const deliveryToken = await sessionFor('delivery_manager');

  const salesContext = await rpc(salesToken, 'get_workspace_bootstrap', {});
  if (!salesContext.user_id || !salesContext.organization_id)
    throw new Error('sales access context missing');

  // A Lost lead is rejected by `create_test_drive` further down, so the flow
  // has to start from a lead every stage will accept.
  const [lead] = await rows(salesToken, 'leads', {
    select: 'id,customer_id,branch_id,team_id,assigned_user_id,updated_at',
    organization_id: `eq.${salesContext.organization_id}`,
    assigned_user_id: `eq.${salesContext.user_id}`,
    customer_id: 'not.is.null',
    deleted_at: 'is.null',
    lifecycle_status: 'neq.Lost',
    order: 'updated_at.desc',
    limit: '1',
  });
  if (!lead) throw new Error('no customer-linked Sales Consultant demo lead is available');
  const testDriveScheduledAt = new Date(
    Date.now() + 10 * 86_400_000 + crypto.randomInt(1, 10_000) * 60_000,
  ).toISOString();

  await stage('sales follow-up', async () => {
    await rpc(salesToken, 'create_followup', {
      target_lead_id: lead.id,
      target_customer_id: lead.customer_id,
      target_branch_id: lead.branch_id,
      target_team_id: lead.team_id,
      target_assigned_user_id: salesContext.user_id,
      followup_reason: MARKER,
      followup_due_at: dateAfter(2).toISOString(),
      followup_priority: 'NORMAL',
      target_request_id: requestId(),
    });
  });

  // Test drives are their own module with their own tables and RPCs, exercised
  // below; `create_appointment` stopped accepting the type in 202608260001.
  let createdAppointment;
  await stage('sales showroom-visit appointment', async () => {
    createdAppointment = await rpc(salesToken, 'create_appointment', {
      target_lead_id: lead.id,
      target_customer_id: lead.customer_id,
      target_branch_id: lead.branch_id,
      target_team_id: lead.team_id,
      target_assigned_user_id: salesContext.user_id,
      target_appointment_type: 'Showroom Visit',
      target_scheduled_at: testDriveScheduledAt,
      target_notes: MARKER,
      target_request_id: requestId(),
    });
  });

  await stage('appointment type filter', async () => {
    const result = await rpc(salesToken, 'get_appointment_workspace_page', {
      target_search: '',
      target_status: 'all',
      target_appointment_type: 'Showroom Visit',
      target_branch_id: null,
      target_team_id: null,
      target_owner_id: null,
      target_page: 1,
      target_page_size: 25,
      target_sort: 'scheduled:desc',
      target_timezone: 'Asia/Kolkata',
    });
    if (!result.records?.some((record) => record.id === createdAppointment?.id))
      throw new Error('appointment type filter did not return the created appointment');
  });

  await stage('appointment selected-day agenda', async () => {
    const scheduledDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(testDriveScheduledAt));
    const result = await rpc(salesToken, 'get_appointment_calendar', {
      target_month: `${scheduledDate.slice(0, 7)}-01`,
      target_day: scheduledDate,
      target_search: '',
      target_status: 'all',
      target_appointment_type: 'all',
      target_branch_id: null,
      target_team_id: null,
      target_owner_id: null,
      target_timezone: 'Asia/Kolkata',
    });
    if (!result.days?.[0]?.items?.some((record) => record.id === createdAppointment?.id))
      throw new Error('selected-day agenda did not return the created appointment');
  });

  const [stockTemplate] = await rows(inventoryToken, 'stock_units', {
    select: 'variant_id',
    organization_id: `eq.${salesContext.organization_id}`,
    branch_id: `eq.${lead.branch_id}`,
    deleted_at: 'is.null',
    limit: '1',
  });
  if (!stockTemplate?.variant_id) throw new Error('no demo vehicle variant is available');

  const createFlowStock = async (label) => {
    const suffix = crypto.randomBytes(7).toString('hex').toUpperCase();
    return rpc(inventoryToken, 'create_stock_unit', {
      target_organization_id: salesContext.organization_id,
      target_branch_id: lead.branch_id,
      target_variant_id: stockTemplate.variant_id,
      target_vin: `TST${suffix}`,
      target_chassis_number: `TSTCH${suffix}`,
      target_engine_number: null,
      target_color: label,
      target_status: 'AVAILABLE',
      target_received_at: new Date().toISOString(),
      target_request_id: requestId(),
    });
  };
  const driveStock = await createFlowStock('Test drive verification');
  const allocationStock = await createFlowStock('Allocation verification');
  const stockUnitId = driveStock.stock_unit_id;

  const vehicleOptions = await rpc(salesToken, 'get_test_drive_vehicle_options', {
    target_branch_id: lead.branch_id,
    target_search: '',
    target_limit: 25,
  });
  if (!vehicleOptions.some((vehicle) => vehicle.stock_unit_id === stockUnitId)) {
    throw new Error('test-drive picker did not expose newly available stock');
  }

  let createdTestDrive;
  await stage('sales test-drive creation', async () => {
    createdTestDrive = await rpc(salesToken, 'create_test_drive', {
      target_lead_id: lead.id,
      target_stock_unit_id: stockUnitId,
      target_scheduled_at: testDriveScheduledAt,
      target_expected_duration_minutes: 30,
      target_vehicle_registration: 'DEMO-TEST-DRIVE',
      target_start_location: { label: 'Demo showroom' },
      target_destination: { label: 'Demo route' },
      target_request_id: requestId(),
    });
  });

  await stage('sales test-drive list refresh', async () => {
    const result = await rpc(salesToken, 'get_test_drive_workspace_page', {
      target_view: 'UPCOMING',
      target_search: '',
      target_model: '',
      target_from_date: null,
      target_to_date: null,
      target_page: 1,
      target_page_size: 25,
      target_sort: 'scheduled:desc',
      target_timezone: 'Asia/Kolkata',
    });
    if (!result.records?.some((record) => record.id === createdTestDrive?.id))
      throw new Error('test-drive list did not return the newly saved test drive');
  });

  const quotation = await rpc(salesToken, 'save_quotation', {
    target_quotation_id: null,
    expected_version: null,
    target_lead_id: lead.id,
    target_items: [
      {
        item_type: 'VEHICLE',
        description: 'Demo vehicle quotation',
        quantity: 1,
        unit_price: 1000000,
        adjustment: 0,
      },
    ],
    target_request_id: requestId(),
  });
  console.log('passed: sales quotation draft');

  const sentQuotation = await rpc(salesToken, 'transition_quotation_status', {
    target_quotation_id: quotation.id,
    expected_version: quotation.version,
    target_status: 'SENT',
    change_reason: MARKER,
    target_request_id: requestId(),
  });
  console.log('passed: sales quotation sent');

  const acceptedQuotation = await rpc(salesToken, 'transition_quotation_status', {
    target_quotation_id: quotation.id,
    expected_version: sentQuotation.version,
    target_status: 'ACCEPTED',
    change_reason: MARKER,
    target_request_id: requestId(),
  });
  console.log('passed: sales quotation accepted');

  const booking = await rpc(salesToken, 'create_booking_from_quotation', {
    target_quotation_id: quotation.id,
    expected_quotation_version: acceptedQuotation.version,
    target_booking_amount: 100000,
    target_finance_required: true,
    target_exchange_required: true,
    target_expected_delivery_date: dateAfter(14).toISOString().slice(0, 10),
    target_request_id: requestId(),
  });
  console.log('passed: sales booking created');

  const allocationVehicleOptions = await rpc(salesToken, 'get_test_drive_vehicle_options', {
    target_branch_id: lead.branch_id,
    target_search: '',
    target_limit: 25,
  });
  if (allocationVehicleOptions.some((vehicle) => vehicle.stock_unit_id === stockUnitId)) {
    throw new Error('test-drive picker still exposes already scheduled stock');
  }

  await stage('inventory allocation', async () => {
    await rpc(inventoryToken, 'allocate_stock_unit', {
      target_stock_unit_id: allocationStock.stock_unit_id,
      expected_stock_version: allocationStock.version,
      target_booking_id: booking.id,
      target_allocation_status: 'ALLOCATED',
      target_existing_allocation_id: null,
      expected_allocation_version: null,
      target_request_id: requestId(),
    });
  });

  const departmentActors = [
    ['FINANCE', financeToken],
    ['INSURANCE', insuranceToken],
    ['RTO', rtoToken],
    ['EXCHANGE', exchangeToken],
    ['DELIVERY', deliveryToken],
  ];
  for (const [department, accessToken] of departmentActors) {
    await stage(`${department.toLowerCase()} case creation`, async () => {
      await rpc(accessToken, 'create_operational_case', {
        target_department: department,
        target_booking_id: booking.id,
        target_vehicle_id: null,
        target_assigned_user_id: null,
        target_priority: 'NORMAL',
        target_due_at: dateAfter(7).toISOString(),
        target_notes: MARKER,
        target_request_id: requestId(),
      });
    });
  }

  console.log(
    JSON.stringify({
      passed: 'lead-to-booking-to-operations',
      demo_tenant: 'go-digital-demo-test',
    }),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replaceAll(demoPassword, '[redacted]'));
  process.exitCode = 1;
});
