/*
 * Add a small, predictable set of early-today schedule fixtures for the
 * primary demo Sales Consultant. The records are deliberately separate from
 * the volume lead seed so dashboard/timeline testing does not create any
 * unrelated demo data.
 *
 * Run: pnpm seed:demo:sales-consultant-schedule
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEMO_SLUG = 'go-digital-demo-test';
const DEMO_DOMAIN = 'demo.go-digital.invalid';
const SALES_CONSULTANT_EMAIL = `sales-consultant@${DEMO_DOMAIN}`;
const CLIENT_ADMIN_EMAIL = `client-admin@${DEMO_DOMAIN}`;
const BRANCH_CODE = 'BLR-01';
const TEAM_NAME = 'Demo Sales Team';
const TIMEZONE = 'Asia/Kolkata';
const FIXTURE_PREFIX = 'demo-sales-consultant-today-schedule';
const FIXTURE_MARKER = 'Demo Sales Consultant today schedule fixture';

const genericAppointmentBlueprints = [
  { key: 'showroom-visit-1', type: 'Showroom Visit', hour: 8, minute: 30, leadIndex: 0 },
  { key: 'video-call-1', type: 'Video Call', hour: 9, minute: 0, leadIndex: 1 },
  { key: 'consultant-call-1', type: 'Consultant Call', hour: 9, minute: 30, leadIndex: 2 },
  { key: 'appointment-test-drive-1', type: 'Test Drive', hour: 10, minute: 0, leadIndex: 3 },
  { key: 'showroom-visit-2', type: 'Showroom Visit', hour: 10, minute: 30, leadIndex: 4 },
  { key: 'video-call-2', type: 'Video Call', hour: 10, minute: 45, leadIndex: 5 },
];

const dedicatedTestDriveBlueprints = [
  { key: 'dedicated-test-drive-1', hour: 8, minute: 45, leadIndex: 6, suffix: 'A' },
  { key: 'dedicated-test-drive-2', hour: 10, minute: 15, leadIndex: 7, suffix: 'B' },
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
    'Refusing to write demo schedule data. Re-run with --apply after confirming the isolated demo project.',
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

async function first(table, query, errorMessage) {
  const rows = await select(table, { ...query, limit: '1' });
  if (rows.length !== 1) throw new Error(errorMessage);
  return rows[0];
}

function todayInIndia() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
  };
}

function dateKey(today) {
  return `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
}

function compactDateKey(today) {
  return `${today.year}${String(today.month).padStart(2, '0')}${String(today.day).padStart(2, '0')}`;
}

function scheduledAtInIndia(today, hour, minute) {
  // India is UTC+05:30 throughout the year, with no daylight-saving shift.
  return new Date(Date.UTC(today.year, today.month - 1, today.day, hour - 5, minute - 30));
}

async function resolveTarget() {
  const organization = await first(
    'organizations',
    { select: 'id', slug: `eq.${DEMO_SLUG}` },
    'The isolated demo tenant is missing. Run pnpm seed:demo:remote first.',
  );
  const branch = await first(
    'branches',
    {
      select: 'id',
      organization_id: `eq.${organization.id}`,
      code: `eq.${BRANCH_CODE}`,
    },
    'The demo branch is missing. Run pnpm seed:demo:remote first.',
  );
  const team = await first(
    'teams',
    {
      select: 'id',
      organization_id: `eq.${organization.id}`,
      branch_id: `eq.${branch.id}`,
      name: `eq.${TEAM_NAME}`,
      active: 'eq.true',
    },
    'The demo sales team is missing or inactive. Run pnpm seed:demo:remote first.',
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
    'The primary demo Sales Consultant is missing or inactive. Run pnpm seed:demo:remote first.',
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
    'The demo Client Admin is missing or inactive. Run pnpm seed:demo:remote first.',
  );
  const membership = await select('team_members', {
    select: 'team_id',
    organization_id: `eq.${organization.id}`,
    team_id: `eq.${team.id}`,
    user_id: `eq.${salesConsultant.id}`,
    active: 'eq.true',
  });
  if (membership.length !== 1)
    throw new Error(
      'The primary demo Sales Consultant is not an active member of the demo sales team.',
    );

  const roleRows = await select('roles', {
    select: 'id',
    organization_id: `eq.${organization.id}`,
    role_key: 'eq.sales_consultant',
  });
  const roleIds = roleRows.map((role) => role.id);
  const roleAssignments =
    roleIds.length === 0
      ? []
      : await select('user_role_assignments', {
          select: 'id',
          organization_id: `eq.${organization.id}`,
          user_id: `eq.${salesConsultant.id}`,
          role_id: inFilter(roleIds),
          active: 'eq.true',
        });
  if (roleAssignments.length === 0)
    throw new Error('The primary demo Sales Consultant role assignment is missing or inactive.');

  return {
    organizationId: organization.id,
    branchId: branch.id,
    teamId: team.id,
    salesConsultantId: salesConsultant.id,
    clientAdminId: clientAdmin.id,
  };
}

async function resolveFixtureLeads(target, requiredCount) {
  const externalLeadIds = Array.from(
    { length: 24 },
    (_, index) => `demo-sales-consultant-volume-${String(index + 1).padStart(3, '0')}`,
  );
  const rows = await select('leads', {
    select:
      'id,external_lead_id,customer_id,branch_id,team_id,assigned_user_id,lifecycle_status,deleted_at',
    organization_id: `eq.${target.organizationId}`,
    connection_id: 'is.null',
    external_lead_id: inFilter(externalLeadIds),
  });
  const rowsByExternalLeadId = new Map();
  for (const row of rows) {
    if (rowsByExternalLeadId.has(row.external_lead_id))
      throw new Error(`Multiple demo fixture leads exist for ${row.external_lead_id}.`);
    if (
      row.deleted_at ||
      !row.customer_id ||
      row.branch_id !== target.branchId ||
      row.team_id !== target.teamId ||
      row.assigned_user_id !== target.salesConsultantId
    ) {
      throw new Error(
        `Fixture lead ${row.external_lead_id} does not match the expected demo scope.`,
      );
    }
    rowsByExternalLeadId.set(row.external_lead_id, row);
  }

  const eligibleLeads = externalLeadIds
    .map((externalLeadId) => rowsByExternalLeadId.get(externalLeadId))
    .filter((lead) => lead && lead.lifecycle_status !== 'Lost');
  if (eligibleLeads.length < requiredCount) {
    throw new Error(
      'At least eight active Sales Consultant volume leads are required. Run pnpm seed:demo:sales-consultant-leads first.',
    );
  }
  return eligibleLeads.slice(0, requiredCount);
}

function sameInstant(left, right) {
  return new Date(left).getTime() === new Date(right).getTime();
}

function assertGenericAppointmentFixture(existing, fixture, target) {
  if (
    existing.organization_id !== target.organizationId ||
    existing.branch_id !== target.branchId ||
    existing.team_id !== target.teamId ||
    existing.lead_id !== fixture.lead.id ||
    existing.customer_id !== fixture.lead.customer_id ||
    existing.assigned_user_id !== target.salesConsultantId ||
    existing.appointment_type !== fixture.type ||
    !sameInstant(existing.scheduled_at, fixture.scheduledAt)
  ) {
    throw new Error(
      `Existing schedule fixture ${fixture.key} does not match its expected demo scope.`,
    );
  }
}

function assertTestDriveFixture(existing, fixture, target) {
  if (
    existing.organization_id !== target.organizationId ||
    existing.branch_id !== target.branchId ||
    existing.team_id !== target.teamId ||
    existing.lead_id !== fixture.lead.id ||
    existing.customer_id !== fixture.lead.customer_id ||
    existing.assigned_user_id !== target.salesConsultantId ||
    !existing.stock_unit_id ||
    !sameInstant(existing.scheduled_at, fixture.scheduledAt)
  ) {
    throw new Error(
      `Existing dedicated test-drive fixture ${fixture.key} does not match its expected demo scope.`,
    );
  }
}

async function main() {
  const target = await resolveTarget();
  const today = todayInIndia();
  const readableDate = dateKey(today);
  const compactDate = compactDateKey(today);
  const leads = await resolveFixtureLeads(
    target,
    genericAppointmentBlueprints.length + dedicatedTestDriveBlueprints.length,
  );
  const genericFixtures = genericAppointmentBlueprints.map((blueprint) => ({
    ...blueprint,
    lead: leads[blueprint.leadIndex],
    scheduledAt: scheduledAtInIndia(today, blueprint.hour, blueprint.minute).toISOString(),
    notes: `${FIXTURE_MARKER} | ${FIXTURE_PREFIX} | ${readableDate} | ${blueprint.key}`,
  }));
  const testDriveFixtures = dedicatedTestDriveBlueprints.map((blueprint) => ({
    ...blueprint,
    lead: leads[blueprint.leadIndex],
    scheduledAt: scheduledAtInIndia(today, blueprint.hour, blueprint.minute).toISOString(),
    vehicleRegistration: `DMS-TD-${compactDate}-${blueprint.suffix}`,
  }));

  const existingAppointments = await select('appointments', {
    select:
      'id,organization_id,branch_id,team_id,lead_id,customer_id,assigned_user_id,appointment_type,scheduled_at,notes',
    organization_id: `eq.${target.organizationId}`,
    notes: inFilter(genericFixtures.map((fixture) => fixture.notes)),
  });
  const appointmentByNotes = new Map();
  for (const appointment of existingAppointments) {
    if (appointmentByNotes.has(appointment.notes))
      throw new Error(`Multiple schedule fixtures exist for ${appointment.notes}.`);
    appointmentByNotes.set(appointment.notes, appointment);
  }
  for (const fixture of genericFixtures) {
    const existing = appointmentByNotes.get(fixture.notes);
    if (existing) assertGenericAppointmentFixture(existing, fixture, target);
  }

  const createdGenericAppointments = await insert(
    'appointments',
    genericFixtures
      .filter((fixture) => !appointmentByNotes.has(fixture.notes))
      .map((fixture) => ({
        organization_id: target.organizationId,
        branch_id: target.branchId,
        team_id: target.teamId,
        lead_id: fixture.lead.id,
        customer_id: fixture.lead.customer_id,
        assigned_user_id: target.salesConsultantId,
        appointment_type: fixture.type,
        scheduled_at: fixture.scheduledAt,
        status: 'SCHEDULED',
        attendance_status: 'NOT_ARRIVED',
        notes: fixture.notes,
        created_by: target.clientAdminId,
      })),
  );

  const existingTestDriveAppointments = await select('test_drive_appointments', {
    select:
      'id,organization_id,branch_id,team_id,lead_id,customer_id,assigned_user_id,stock_unit_id,scheduled_at,vehicle_registration',
    organization_id: `eq.${target.organizationId}`,
    vehicle_registration: inFilter(testDriveFixtures.map((fixture) => fixture.vehicleRegistration)),
  });
  const testDriveAppointmentByRegistration = new Map();
  for (const appointment of existingTestDriveAppointments) {
    if (testDriveAppointmentByRegistration.has(appointment.vehicle_registration))
      throw new Error(
        `Multiple dedicated test-drive fixtures exist for ${appointment.vehicle_registration}.`,
      );
    testDriveAppointmentByRegistration.set(appointment.vehicle_registration, appointment);
  }
  for (const fixture of testDriveFixtures) {
    const existing = testDriveAppointmentByRegistration.get(fixture.vehicleRegistration);
    if (existing) assertTestDriveFixture(existing, fixture, target);
  }

  const missingTestDriveFixtures = testDriveFixtures.filter(
    (fixture) => !testDriveAppointmentByRegistration.has(fixture.vehicleRegistration),
  );
  if (missingTestDriveFixtures.length > 0) {
    const [availableStock, scheduledStock] = await Promise.all([
      select('stock_units', {
        select: 'id',
        organization_id: `eq.${target.organizationId}`,
        branch_id: `eq.${target.branchId}`,
        status: 'eq.AVAILABLE',
        deleted_at: 'is.null',
        order: 'created_at.asc',
      }),
      select('test_drive_appointments', {
        select: 'stock_unit_id',
        organization_id: `eq.${target.organizationId}`,
        status: 'in.(SCHEDULED,ACTIVE)',
        stock_unit_id: 'not.is.null',
      }),
    ]);
    const scheduledStockIds = new Set(
      scheduledStock.map((appointment) => appointment.stock_unit_id),
    );
    const availableFixtureStock = availableStock.filter(
      (stock) => !scheduledStockIds.has(stock.id),
    );
    if (availableFixtureStock.length < missingTestDriveFixtures.length) {
      throw new Error(
        'Not enough unreserved demo stock units are available for the dedicated test-drive fixtures.',
      );
    }
    const createdTestDriveAppointments = await insert(
      'test_drive_appointments',
      missingTestDriveFixtures.map((fixture, index) => ({
        organization_id: target.organizationId,
        branch_id: target.branchId,
        team_id: target.teamId,
        customer_id: fixture.lead.customer_id,
        lead_id: fixture.lead.id,
        assigned_user_id: target.salesConsultantId,
        stock_unit_id: availableFixtureStock[index].id,
        scheduled_at: fixture.scheduledAt,
        status: 'SCHEDULED',
        expected_duration_minutes: 45,
        start_location: { label: 'Demo showroom' },
        destination: { label: 'Demo test-drive route' },
        vehicle_registration: fixture.vehicleRegistration,
        created_by: target.clientAdminId,
      })),
    );
    for (const appointment of createdTestDriveAppointments) {
      testDriveAppointmentByRegistration.set(appointment.vehicle_registration, appointment);
    }
  }

  const allTestDriveAppointments = testDriveFixtures.map((fixture) => {
    const appointment = testDriveAppointmentByRegistration.get(fixture.vehicleRegistration);
    if (!appointment)
      throw new Error(`Dedicated test-drive fixture ${fixture.key} was not created.`);
    return appointment;
  });
  const testDriveAppointmentIds = allTestDriveAppointments.map((appointment) => appointment.id);
  const existingTestDrives = await select('test_drives', {
    select:
      'id,appointment_id,organization_id,branch_id,team_id,customer_id,lead_id,assigned_user_id',
    organization_id: `eq.${target.organizationId}`,
    appointment_id: inFilter(testDriveAppointmentIds),
  });
  const testDriveByAppointmentId = new Map();
  for (const drive of existingTestDrives) {
    if (testDriveByAppointmentId.has(drive.appointment_id))
      throw new Error(`Multiple test drives exist for appointment ${drive.appointment_id}.`);
    testDriveByAppointmentId.set(drive.appointment_id, drive);
  }
  const createdTestDrives = await insert(
    'test_drives',
    allTestDriveAppointments
      .filter((appointment) => !testDriveByAppointmentId.has(appointment.id))
      .map((appointment) => ({
        organization_id: target.organizationId,
        branch_id: target.branchId,
        team_id: target.teamId,
        appointment_id: appointment.id,
        customer_id: appointment.customer_id,
        lead_id: appointment.lead_id,
        assigned_user_id: target.salesConsultantId,
        status: 'READY',
      })),
  );

  const verifiedGenericAppointments = await select('appointments', {
    select: 'id',
    organization_id: `eq.${target.organizationId}`,
    notes: inFilter(genericFixtures.map((fixture) => fixture.notes)),
  });
  const verifiedTestDriveAppointments = await select('test_drive_appointments', {
    select: 'id',
    organization_id: `eq.${target.organizationId}`,
    vehicle_registration: inFilter(testDriveFixtures.map((fixture) => fixture.vehicleRegistration)),
  });
  const verifiedTestDrives = await select('test_drives', {
    select: 'id',
    organization_id: `eq.${target.organizationId}`,
    appointment_id: inFilter(verifiedTestDriveAppointments.map((appointment) => appointment.id)),
  });
  if (
    verifiedGenericAppointments.length !== genericFixtures.length ||
    verifiedTestDriveAppointments.length !== testDriveFixtures.length ||
    verifiedTestDrives.length !== testDriveFixtures.length
  ) {
    throw new Error('Demo Sales Consultant schedule fixture verification failed.');
  }

  console.log(
    JSON.stringify(
      {
        organization_slug: DEMO_SLUG,
        target_role: 'sales_consultant',
        schedule_date: readableDate,
        created_generic_appointments: createdGenericAppointments.length,
        created_test_drive_appointments: missingTestDriveFixtures.length,
        created_test_drive_records: createdTestDrives.length,
        total_today_schedule_items: genericFixtures.length + testDriveFixtures.length,
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
