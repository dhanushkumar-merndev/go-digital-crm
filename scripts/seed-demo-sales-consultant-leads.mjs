/*
 * Add a predictable, idempotent volume fixture for the primary demo Sales
 * Consultant. This is intentionally separate from the broad demo tenant seed
 * so it cannot create unrelated demo records while testing the lead flow.
 *
 * Run: pnpm seed:demo:sales-consultant-leads
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
const DEFAULT_LEAD_COUNT = 100;
const MAX_LEAD_COUNT = 100;
const FIXTURE_PREFIX = 'demo-sales-consultant-volume';
const FIXTURE_MARKER = 'Demo Sales Consultant volume fixture';
const ASSIGNMENT_REASON = 'Demo volume fixture assignment';
const ACTIVITY_TYPE = 'demo.sales_consultant_volume_seeded';

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

function requestedLeadCount() {
  const countArgument = process.argv.find((argument) => argument.startsWith('--count='));
  if (!countArgument) return DEFAULT_LEAD_COUNT;
  const value = Number.parseInt(countArgument.slice('--count='.length), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEAD_COUNT) {
    console.error(`--count must be a whole number from 1 to ${MAX_LEAD_COUNT}.`);
    process.exit(1);
  }
  return value;
}

const targetCount = requestedLeadCount();
// --reset retires every lead in the demo organization that this fixture set does
// not own, so hand-made rows carrying two or three states at once stop polluting
// the queues. It is a soft delete: the list RPCs filter `deleted_at is null`, so
// the rows leave every view while staying recoverable. Nothing is destroyed, and
// no cascade runs across activities, follow-ups, assignments or stage history.
const resetRequested = process.argv.includes('--reset');
const env = readEnv();
const projectUrl = env.get('SUPABASE_URL')?.replace(/\/$/, '');
const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
const remoteSeedAllowed = env.get('DEMO_ALLOW_REMOTE_SEED') === 'true';
const allowedProjectRef = env.get('DEMO_ALLOWED_SUPABASE_PROJECT_REF')?.trim();

if (!process.argv.includes('--apply')) {
  console.error(
    'Refusing to write demo lead data. Re-run with --apply after confirming the isolated demo project.',
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

async function patch(table, query, row) {
  return request(restUrl(table, query), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
}

async function first(table, query, errorMessage) {
  const rows = await select(table, { ...query, limit: '1' });
  if (rows.length !== 1) throw new Error(errorMessage);
  return rows[0];
}

const LEAD_STATES = ['NEW', 'PENDING', 'CONTACTED', 'FOLLOW_UP', 'APPOINTMENT', 'LOST'];

function leadFixture(sequence) {
  const suffix = String(sequence).padStart(3, '0');
  const state = LEAD_STATES[(sequence - 1) % LEAD_STATES.length];
  // New is defined by the handoff landing inside today, Pending by it landing
  // before today, so the handoff timestamp is the only thing separating them.
  const handoffAt =
    state === 'NEW'
      ? new Date(Date.now() - 2 * 3_600_000)
      : new Date(Date.now() - (24 + ((sequence * 7) % 216)) * 3_600_000);
  const lifecycleStatus =
    state === 'APPOINTMENT'
      ? 'Appointment Scheduled'
      : state === 'LOST'
        ? 'Lost'
        : 'Transferred to Sales';
  const createdAt = new Date(handoffAt.getTime() - 3_600_000);
  const nextFollowupAt = new Date(Date.now() + ((sequence % 9) + 2) * 3_600_000);
  const phone = `+919800${String(sequence).padStart(6, '0')}`;
  const email = `sales-volume-${suffix}@${DEMO_DOMAIN}`;
  const externalLeadId = `${FIXTURE_PREFIX}-${suffix}`;

  return {
    sequence,
    state,
    handoffAt: handoffAt.toISOString(),
    // Only the follow-up cohort carries a pending follow-up. Every other state
    // must be free of one, or it would sit in two queues at once.
    contacted: state === 'CONTACTED' || state === 'FOLLOW_UP' || state === 'APPOINTMENT',
    externalLeadId,
    fullName: `Demo Volume Lead ${suffix}`,
    phone,
    email,
    createdAt: createdAt.toISOString(),
    lifecycleStatus,
    temperature: ['HOT', 'WARM', 'COLD'][(sequence - 1) % 3],
    source: ['Facebook', 'Instagram', 'Google Ads', 'Website', 'CarWale', 'Manual'][
      (sequence - 1) % 6
    ],
    interestedModel: ['Nexon EV', 'Harrier', 'Punch EV', 'Safari', 'Curvv EV'][(sequence - 1) % 5],
    firstContactedAt:
      state === 'NEW' || state === 'PENDING'
        ? null
        : new Date(handoffAt.getTime() + 60 * 60_000).toISOString(),
    nextFollowupAt: state === 'FOLLOW_UP' ? nextFollowupAt.toISOString() : null,
    slaDueAt: new Date(createdAt.getTime() + 24 * 3_600_000).toISOString(),
    lostReason: state === 'LOST' ? 'Demo test fixture — customer deferred purchase' : null,
  };
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

async function main() {
  const target = await resolveTarget();
  const [existingBranchAccess] = await select('user_branch_access', {
    select: 'active',
    organization_id: `eq.${target.organizationId}`,
    user_id: `eq.${target.salesConsultantId}`,
    branch_id: `eq.${target.branchId}`,
  });
  let branchAccessGranted = false;
  if (!existingBranchAccess) {
    await insert('user_branch_access', [
      {
        organization_id: target.organizationId,
        user_id: target.salesConsultantId,
        branch_id: target.branchId,
        granted_by: target.clientAdminId,
        active: true,
      },
    ]);
    branchAccessGranted = true;
  } else if (!existingBranchAccess.active) {
    await patch(
      'user_branch_access',
      {
        organization_id: `eq.${target.organizationId}`,
        user_id: `eq.${target.salesConsultantId}`,
        branch_id: `eq.${target.branchId}`,
      },
      { active: true, revoked_at: null, revoked_by: null },
    );
    branchAccessGranted = true;
  }

  const fixtures = Array.from({ length: targetCount }, (_, index) => leadFixture(index + 1));

  if (resetRequested) {
    const fixtureExternalIds = new Set(fixtures.map((fixture) => fixture.externalLeadId));
    const liveLeads = await select('leads', {
      select: 'id,external_lead_id,customer_name',
      organization_id: `eq.${target.organizationId}`,
      deleted_at: 'is.null',
    });
    const strayLeads = liveLeads.filter(
      (lead) => !fixtureExternalIds.has(lead.external_lead_id ?? ''),
    );
    const retiredAt = new Date().toISOString();

    // Order matters. `followups` and `appointments` are validated against their
    // lead, and that check reads the lead as live -- retiring the lead first
    // makes every later cancel fail with WORK_LEAD_NOT_IN_ORGANIZATION. So the
    // commitments are closed while their lead can still be resolved, and only
    // then is the lead itself retired.
    //
    // Neither table has a `deleted_at`; their lifecycle is a status column, so
    // the equivalent of retiring one is cancelling it. Left open, they would
    // keep stale commitments in the Follow-ups and Appointments workspaces.
    // A lead retired by an earlier run can no longer be resolved by the trigger,
    // so its commitments are permanently un-editable. Restricting the cancel to
    // leads that are still live keeps a partially completed previous run from
    // failing every subsequent one.
    const liveLeadIds = liveLeads.map((lead) => lead.id);
    const openFollowups = liveLeadIds.length
      ? await select('followups', {
          select: 'id',
          organization_id: `eq.${target.organizationId}`,
          status: 'in.(OPEN,OVERDUE)',
          lead_id: inFilter(liveLeadIds),
        })
      : [];
    console.log(`Cancelling ${openFollowups.length} open follow-up(s).`);
    for (const followup of openFollowups) {
      await patch(
        'followups',
        { id: `eq.${followup.id}`, organization_id: `eq.${target.organizationId}` },
        {
          status: 'CANCELLED',
          cancelled_at: retiredAt,
          cancellation_reason: 'Demo fixture reset',
          updated_at: retiredAt,
        },
      );
    }

    const openAppointments = liveLeadIds.length
      ? await select('appointments', {
          select: 'id',
          organization_id: `eq.${target.organizationId}`,
          status: 'eq.SCHEDULED',
          lead_id: inFilter(liveLeadIds),
        })
      : [];
    console.log(`Cancelling ${openAppointments.length} scheduled appointment(s).`);
    for (const appointment of openAppointments) {
      await patch(
        'appointments',
        { id: `eq.${appointment.id}`, organization_id: `eq.${target.organizationId}` },
        {
          status: 'CANCELLED',
          cancelled_at: retiredAt,
          cancellation_reason: 'Demo fixture reset',
          updated_at: retiredAt,
        },
      );
    }

    console.log(`Retiring ${strayLeads.length} lead(s) outside the fixture set.`);
    for (const lead of strayLeads) {
      console.log(`  - ${lead.customer_name ?? lead.id}`);
      await patch(
        'leads',
        { id: `eq.${lead.id}`, organization_id: `eq.${target.organizationId}` },
        { deleted_at: retiredAt },
      );
    }
  }
  const emails = fixtures.map((fixture) => fixture.email);
  const externalLeadIds = fixtures.map((fixture) => fixture.externalLeadId);

  const existingCustomers = await select('customers', {
    select: 'id,primary_email,deleted_at',
    organization_id: `eq.${target.organizationId}`,
    primary_email: inFilter(emails),
  });
  const customerByEmail = new Map();
  for (const customer of existingCustomers) {
    if (customer.deleted_at) continue;
    if (customerByEmail.has(customer.primary_email))
      throw new Error(
        `Multiple active demo fixture customers exist for ${customer.primary_email}.`,
      );
    customerByEmail.set(customer.primary_email, customer);
  }

  const createdCustomers = await insert(
    'customers',
    fixtures
      .filter((fixture) => !customerByEmail.has(fixture.email))
      .map((fixture) => ({
        organization_id: target.organizationId,
        full_name: fixture.fullName,
        primary_phone: fixture.phone,
        normalized_phone: fixture.phone,
        primary_email: fixture.email,
        created_by: target.clientAdminId,
        created_at: fixture.createdAt,
        updated_at: fixture.createdAt,
      })),
  );
  for (const customer of createdCustomers) customerByEmail.set(customer.primary_email, customer);

  const existingLeads = await select('leads', {
    select:
      'id,external_lead_id,customer_id,branch_id,team_id,assigned_user_id,lifecycle_status,deleted_at',
    organization_id: `eq.${target.organizationId}`,
    connection_id: 'is.null',
    external_lead_id: inFilter(externalLeadIds),
  });
  const leadByExternalId = new Map();
  for (const lead of existingLeads) {
    if (lead.deleted_at)
      throw new Error(
        `Fixture lead ${lead.external_lead_id} is soft deleted; refusing to recreate it.`,
      );
    if (leadByExternalId.has(lead.external_lead_id))
      throw new Error(`Multiple active leads exist for fixture ${lead.external_lead_id}.`);
    leadByExternalId.set(lead.external_lead_id, lead);
  }

  for (const fixture of fixtures) {
    const existingLead = leadByExternalId.get(fixture.externalLeadId);
    if (!existingLead) continue;
    const customer = customerByEmail.get(fixture.email);
    if (
      !customer ||
      existingLead.customer_id !== customer.id ||
      existingLead.branch_id !== target.branchId ||
      existingLead.team_id !== target.teamId ||
      existingLead.assigned_user_id !== target.salesConsultantId
    ) {
      throw new Error(
        `Fixture lead ${fixture.externalLeadId} does not match the expected demo customer, scope, or assignee.`,
      );
    }
  }

  const createdLeads = await insert(
    'leads',
    fixtures
      .filter((fixture) => !leadByExternalId.has(fixture.externalLeadId))
      .map((fixture) => {
        const customer = customerByEmail.get(fixture.email);
        if (!customer)
          throw new Error(`Customer is missing for fixture ${fixture.externalLeadId}.`);
        return {
          organization_id: target.organizationId,
          branch_id: target.branchId,
          team_id: target.teamId,
          customer_id: customer.id,
          source: fixture.source,
          source_detail: FIXTURE_MARKER,
          campaign: 'QA Sales Consultant lead-flow volume test',
          connection_id: null,
          external_lead_id: fixture.externalLeadId,
          raw_payload: {
            demo_fixture: true,
            fixture: FIXTURE_PREFIX,
            sequence: fixture.sequence,
          },
          customer_name: fixture.fullName,
          phone: fixture.phone,
          normalized_phone: fixture.phone,
          email: fixture.email,
          interested_model: fixture.interestedModel,
          lifecycle_status: fixture.lifecycleStatus,
          temperature: fixture.temperature,
          assigned_user_id: target.salesConsultantId,
          first_contacted_at: fixture.firstContactedAt,
          next_followup_at: fixture.nextFollowupAt,
          sla_due_at: fixture.slaDueAt,
          lost_reason: fixture.lostReason,
          created_at: fixture.createdAt,
          updated_at: fixture.createdAt,
        };
      }),
  );
  for (const lead of createdLeads) leadByExternalId.set(lead.external_lead_id, lead);

  const allLeads = fixtures.map((fixture) => {
    const lead = leadByExternalId.get(fixture.externalLeadId);
    if (!lead) throw new Error(`Fixture lead ${fixture.externalLeadId} was not created.`);
    return lead;
  });
  const leadIds = allLeads.map((lead) => lead.id);

  // Sales Consultants receive qualified handoffs, never raw intake leads.  The
  // list RPC enforces that history, so volume fixtures must model the same
  // journey instead of bypassing it with a plain `assigned_user_id` update.
  const existingHandoffs = await select('lead_stage_history', {
    select: 'lead_id',
    organization_id: `eq.${target.organizationId}`,
    lead_id: inFilter(leadIds),
    to_status: 'eq.Transferred to Sales',
  });
  const handoffLeadIds = new Set(existingHandoffs.map((history) => history.lead_id));
  const fixtureByExternalId = new Map(fixtures.map((fixture) => [fixture.externalLeadId, fixture]));
  const handoffRows = allLeads
    .filter((lead) => !handoffLeadIds.has(lead.id))
    .map((lead) => ({
      organization_id: target.organizationId,
      lead_id: lead.id,
      from_status: lead.lifecycle_status,
      to_status: 'Transferred to Sales',
      changed_by: target.clientAdminId,
      reason: 'Demo qualified lead handoff to Sales Consultant',
      created_at: fixtureByExternalId.get(lead.external_lead_id)?.handoffAt,
    }));
  await insert('lead_stage_history', handoffRows);
  // Re-running has to RESET state, not just top it up. Patching only the
  // lifecycle left an already-seeded lead holding its previous
  // `next_followup_at`, which put it back into two queues at once -- the exact
  // condition this fixture set exists to avoid.
  for (const lead of allLeads) {
    const fixture = fixtureByExternalId.get(lead.external_lead_id);
    if (!fixture) continue;
    const intended =
      fixture.state === 'APPOINTMENT'
        ? 'Appointment Scheduled'
        : fixture.state === 'LOST'
          ? 'Lost'
          : 'Transferred to Sales';
    await patch(
      'leads',
      { id: `eq.${lead.id}`, organization_id: `eq.${target.organizationId}` },
      {
        lifecycle_status: intended,
        next_followup_at: fixture.nextFollowupAt,
        first_contacted_at: fixture.firstContactedAt,
        lost_reason: fixture.lostReason,
      },
    );
  }

  const activeAssignments = await select('lead_assignments', {
    select: 'lead_id,assigned_user_id',
    organization_id: `eq.${target.organizationId}`,
    lead_id: inFilter(leadIds),
    active: 'eq.true',
  });
  const assignmentByLeadId = new Map();
  for (const assignment of activeAssignments) {
    if (
      assignmentByLeadId.has(assignment.lead_id) ||
      assignment.assigned_user_id !== target.salesConsultantId
    ) {
      throw new Error(`Fixture lead ${assignment.lead_id} has an unexpected active assignment.`);
    }
    assignmentByLeadId.set(assignment.lead_id, assignment);
  }
  const assignmentRows = allLeads
    .filter((lead) => !assignmentByLeadId.has(lead.id))
    .map((lead) => ({
      organization_id: target.organizationId,
      lead_id: lead.id,
      branch_id: target.branchId,
      team_id: target.teamId,
      assigned_user_id: target.salesConsultantId,
      assignment_type: 'FRESH',
      method: 'MANUAL_ASSIGNMENT',
      assigned_by: target.clientAdminId,
      reason: ASSIGNMENT_REASON,
      active: true,
    }));
  await insert('lead_assignments', assignmentRows);

  const assignmentHistory = await select('lead_assignment_history', {
    select: 'lead_id',
    organization_id: `eq.${target.organizationId}`,
    lead_id: inFilter(leadIds),
    new_owner_id: `eq.${target.salesConsultantId}`,
    reason: `eq.${ASSIGNMENT_REASON}`,
  });
  const historyLeadIds = new Set(assignmentHistory.map((entry) => entry.lead_id));
  const historyRows = allLeads
    .filter((lead) => !historyLeadIds.has(lead.id))
    .map((lead) => ({
      organization_id: target.organizationId,
      lead_id: lead.id,
      branch_id: target.branchId,
      team_id: target.teamId,
      previous_owner_id: null,
      new_owner_id: target.salesConsultantId,
      assigned_by: target.clientAdminId,
      method: 'MANUAL_ASSIGNMENT',
      reason: ASSIGNMENT_REASON,
    }));
  await insert('lead_assignment_history', historyRows);

  // A lead in the Follow-up cohort must have the corresponding open work row.
  // `next_followup_at` alone only decorates the lead list; without this row the
  // Follow-ups workspace and its Today/Overdue/Upcoming counts cannot account
  // for the consultant's commitment.
  const followupFixtures = allLeads.flatMap((lead) => {
    const fixture = fixtureByExternalId.get(lead.external_lead_id);
    return fixture?.state === 'FOLLOW_UP' && fixture.nextFollowupAt ? [{ lead, fixture }] : [];
  });
  const existingOpenFollowups = followupFixtures.length
    ? await select('followups', {
        select: 'lead_id',
        organization_id: `eq.${target.organizationId}`,
        lead_id: inFilter(followupFixtures.map(({ lead }) => lead.id)),
        status: 'eq.OPEN',
      })
    : [];
  const openFollowupLeadIds = new Set(existingOpenFollowups.map((followup) => followup.lead_id));
  const followupRows = followupFixtures
    .filter(({ lead }) => !openFollowupLeadIds.has(lead.id))
    .map(({ lead, fixture }) => ({
      organization_id: target.organizationId,
      branch_id: target.branchId,
      team_id: target.teamId,
      lead_id: lead.id,
      customer_id: lead.customer_id,
      assigned_user_id: target.salesConsultantId,
      reason: `${FIXTURE_MARKER} follow-up`,
      priority: fixture.temperature === 'HOT' ? 'HIGH' : 'NORMAL',
      due_at: fixture.nextFollowupAt,
      status: 'OPEN',
      created_by: target.clientAdminId,
      created_at: fixture.handoffAt,
      updated_at: fixture.handoffAt,
    }));
  await insert('followups', followupRows);

  const existingActivities = await select('activities', {
    select: 'lead_id,activity_type',
    organization_id: `eq.${target.organizationId}`,
    lead_id: inFilter(leadIds),
    activity_type: inFilter([
      ACTIVITY_TYPE,
      'LEAD_RECEIVED',
      'FIRST_CONTACTED',
      'LEAD_QUALIFIED',
      'LEAD_TRANSFERRED_TO_SALES',
    ]),
  });
  const activityKeys = new Set(
    existingActivities.map((entry) => `${entry.lead_id}:${entry.activity_type}`),
  );
  const activityRows = allLeads.flatMap((lead) => {
    const sequence = fixtures.find((fixture) => fixture.externalLeadId === lead.external_lead_id);
    const createdAt = sequence?.createdAt ?? new Date().toISOString();
    const events = [
      ['LEAD_RECEIVED', 'Lead received from the source'],
      ['FIRST_CONTACTED', 'First customer contact recorded'],
      ['LEAD_QUALIFIED', 'Lead qualified for Sales'],
      ['LEAD_TRANSFERRED_TO_SALES', 'Qualified lead transferred to Sales Consultant'],
      [ACTIVITY_TYPE, 'Demo Sales Consultant volume fixture ready'],
    ];
    if (sequence?.contacted)
      events.push(['SALES_CONTACTED', 'Sales Consultant recorded customer contact']);
    return events
      .filter(([activityType]) => !activityKeys.has(`${lead.id}:${activityType}`))
      .map(([activityType, title], index) => ({
        organization_id: target.organizationId,
        customer_id: lead.customer_id,
        lead_id: lead.id,
        activity_type: activityType,
        actor_id: target.clientAdminId,
        occurred_at: new Date(new Date(createdAt).getTime() + index * 30 * 60_000).toISOString(),
        metadata: { fixture: FIXTURE_PREFIX, title, dummy: true },
      }));
  });
  await insert('activities', activityRows);

  const verifiedLeads = await select('leads', {
    select: 'id,customer_id,branch_id,team_id,assigned_user_id',
    organization_id: `eq.${target.organizationId}`,
    connection_id: 'is.null',
    external_lead_id: inFilter(externalLeadIds),
    deleted_at: 'is.null',
  });
  if (
    verifiedLeads.length !== targetCount ||
    verifiedLeads.some(
      (lead) =>
        !lead.customer_id ||
        lead.branch_id !== target.branchId ||
        lead.team_id !== target.teamId ||
        lead.assigned_user_id !== target.salesConsultantId,
    )
  ) {
    throw new Error('Demo Sales Consultant lead fixture verification failed.');
  }

  console.log(
    JSON.stringify(
      {
        organization_slug: DEMO_SLUG,
        target_role: 'sales_consultant',
        requested_fixture_leads: targetCount,
        created_customers: createdCustomers.length,
        created_leads: createdLeads.length,
        branch_access_granted: branchAccessGranted,
        created_sales_handoff_history: handoffRows.length,
        created_assignment_records: assignmentRows.length,
        created_assignment_history_records: historyRows.length,
        created_open_followups: followupRows.length,
        total_active_fixture_leads: verifiedLeads.length,
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
