import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const org = randomUUID();
const otherOrg = randomUUID();
const telecaller = randomUUID();
const colleague = randomUUID();
const outsider = randomUUID();
const branch = randomUUID();
const otherBranch = randomUUID();
const team = randomUUID();
let db: PGlite;

type Synced = {
  call_id: string;
  lead_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  phone: string;
  matched: boolean;
  duplicate: boolean;
  has_recording: boolean;
};

// Scope and permission helpers have their own tests; here they are stubs driven
// by session settings (test.permissions, test.branches, test.own_only), so each
// test can grant or withhold access. create_lead and review_ai_call_fields are
// stubs that record how they were called.
const fixture = `
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema app_private;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', 'anon')
$$;
create function app_private.current_tenant_organization() returns uuid language sql stable as $$
  select nullif(current_setting('test.org', true), '')::uuid
$$;
create function app_private.has_permission(uuid, text) returns boolean language sql stable as $$
  select $1 = app_private.current_tenant_organization()
    and $2 = any(string_to_array(coalesce(current_setting('test.permissions', true), ''), ','))
$$;
create function app_private.can_access_record(uuid, uuid, uuid, uuid) returns boolean
language sql stable as $$
  select $1 = app_private.current_tenant_organization()
    and $2::text = any(string_to_array(coalesce(current_setting('test.branches', true), ''), ','))
    and (coalesce(current_setting('test.own_only', true), '') <> 'true' or $4 = auth.uid())
$$;
create function app_private.can_access_customer(uuid, uuid) returns boolean language sql stable as $$
  select $1 = app_private.current_tenant_organization()
$$;

create table public.organizations (id uuid primary key);
create table public.profiles (
  id uuid primary key, organization_id uuid not null references public.organizations(id),
  active boolean not null default true, deleted_at timestamptz,
  unique (organization_id, id)
);
create table public.branches (
  id uuid primary key, organization_id uuid not null, active boolean not null default true,
  deleted_at timestamptz
);
create table public.teams (
  id uuid primary key, organization_id uuid not null, branch_id uuid not null,
  active boolean not null default true
);
create table public.team_members (
  organization_id uuid not null, team_id uuid not null, user_id uuid not null,
  active boolean not null default true, joined_at timestamptz not null default now()
);
create table public.user_branch_access (
  organization_id uuid not null, user_id uuid not null, branch_id uuid not null,
  active boolean not null default true, created_at timestamptz not null default now()
);
create table public.user_role_assignments (
  organization_id uuid not null, user_id uuid not null, scope_branch_id uuid,
  active boolean not null default true, created_at timestamptz not null default now()
);
create table public.customers (
  id uuid primary key, organization_id uuid not null, full_name text, primary_phone text,
  primary_email text, deleted_at timestamptz
);
create table public.leads (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  branch_id uuid not null, team_id uuid, customer_id uuid, assigned_user_id uuid,
  customer_name text not null, phone text not null, normalized_phone text not null,
  email text, interested_model text, lifecycle_status text not null default 'New',
  temperature text, source text, source_detail text, deleted_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.calls (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  branch_id uuid not null, team_id uuid, lead_id uuid, customer_id uuid,
  assigned_user_id uuid not null, connection_id uuid, provider_call_id text,
  direction text not null, call_source text not null, started_at timestamptz not null,
  ended_at timestamptz, duration_seconds integer, outcome text,
  status text not null default 'PENDING', notes text, finalized_at timestamptz,
  finalized_by uuid, call_mode text not null default 'HUMAN', caller_phone text,
  normalized_caller_phone text, version bigint not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.object_files (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  branch_id uuid, resource_type text not null, resource_id uuid not null,
  mime_type text not null, checksum text not null default 'x', uploaded_by uuid,
  deleted_at timestamptz
);
create table public.call_recordings (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  call_id uuid not null, object_file_id uuid, source text not null, status text not null,
  checksum text, created_at timestamptz not null default now()
);
create unique index on public.call_recordings (organization_id, object_file_id)
  where object_file_id is not null;
create table public.ai_call_processing_jobs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  branch_id uuid not null, call_id uuid not null, recording_id uuid not null,
  status text not null, attempt_count integer not null default 0, lease_token uuid,
  lease_expires_at timestamptz, safe_error_code text, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, call_id, recording_id)
);
create table public.call_transcripts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  call_id uuid not null, processing_job_id uuid, transcript_text text, language text,
  speaker_turns jsonb not null default '[]', speaker_separation_method text,
  analysis_model_reference text, status text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ai_call_summaries (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  call_id uuid not null, processing_job_id uuid, summary text not null, model_reference text,
  created_at timestamptz not null default now(), unique (organization_id, processing_job_id)
);
create table public.ai_extraction_runs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  call_id uuid, lead_id uuid, processing_job_id uuid, status text not null,
  suggestions jsonb not null, created_at timestamptz not null default now(),
  unique (organization_id, processing_job_id)
);
create table public.ai_field_reviews (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  extraction_run_id uuid not null, field_key text not null, suggested_value jsonb,
  applied_value jsonb, decision text not null, reviewed_by uuid, reviewed_at timestamptz
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), organization_id uuid, actor_id uuid,
  action text not null, resource_type text, resource_id text, branch_id uuid,
  request_id uuid, metadata jsonb not null default '{}'
);
create table public.activities (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  customer_id uuid, lead_id uuid, activity_type text not null, actor_id uuid,
  metadata jsonb not null default '{}', occurred_at timestamptz not null
);

create function app_private.can_access_call(uuid, uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from public.calls call_row
    where call_row.id = $2 and call_row.organization_id = $1
      and app_private.has_permission($1, 'call.view')
      and app_private.can_access_record($1, call_row.branch_id, call_row.team_id, call_row.assigned_user_id)
  )
$$;
create function app_private.can_access_lead(uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from public.leads lead_row
    where lead_row.id = $1
      and app_private.can_access_record(lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id)
  )
$$;
create function public.create_lead(
  uuid, uuid, uuid, text, text, text, text default null, text default null,
  text default null, text default null
) returns uuid language sql as $$
  insert into public.leads (
    organization_id, branch_id, team_id, assigned_user_id, source, customer_name, phone,
    normalized_phone, email, source_detail, interested_model
  ) values ($1, $2, $3, auth.uid(), $4, $5, $6, $6, $7, $8, $10)
  returning id
$$;
create function public.review_ai_call_fields(uuid, jsonb, uuid) returns jsonb language sql as $$
  insert into public.audit_logs (action, request_id, metadata)
  values ('stub.review', $3, jsonb_build_object('run', $1, 'decisions', $2));
  select jsonb_build_object('accepted_fields', (
    select jsonb_agg(decision.value ->> 'field_key') from jsonb_array_elements($2) decision(value)
  ))
$$;
-- Placeholder so the trigger can be created; the migration replaces the body.
create function app_private.enqueue_ai_call_processing() returns trigger language plpgsql as $$
begin return new; end; $$;
create trigger queue_ai_call_processing_after_recording_ready
  after insert or update of status, object_file_id on public.call_recordings
  for each row execute function app_private.enqueue_ai_call_processing();
`;

const workerPermissions = [
  'call.view',
  'call.create',
  'lead.view',
  'lead.create',
  'customer.view',
  'document.upload',
];

async function as(
  user: string,
  options: {
    permissions?: string[];
    organization?: string;
    branches?: string[];
    ownOnly?: boolean;
  } = {},
) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  await db.query("select set_config('test.org', $1, true)", [options.organization ?? org]);
  await db.query("select set_config('test.permissions', $1, true)", [
    (options.permissions ?? workerPermissions).join(','),
  ]);
  await db.query("select set_config('test.branches', $1, true)", [
    (options.branches ?? [branch]).join(','),
  ]);
  await db.query("select set_config('test.own_only', $1, true)", [
    options.ownOnly === false ? 'false' : 'true',
  ]);
}

async function asWorker() {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: 'service_role' }),
  ]);
}

async function sync(phone: string, file: string, direction = 'OUTBOUND') {
  const result = await db.query<{ result: Synced }>(
    `select public.log_recorded_phone_call($1, $2, now() - interval '1 hour', 120, $3, $4) as result`,
    [phone, direction, sha(file), file],
  );
  return result.rows[0].result;
}

async function lead(values: {
  phone: string;
  owner?: string;
  branchId?: string;
  lifecycle?: string;
  name?: string;
  organizationId?: string;
}) {
  const result = await db.query<{ id: string }>(
    `insert into public.leads (organization_id, branch_id, team_id, assigned_user_id,
       customer_name, phone, normalized_phone, lifecycle_status)
     values ($1, $2, $3, $4, $5, $6, $6, $7) returning id`,
    [
      values.organizationId ?? org,
      values.branchId ?? branch,
      team,
      values.owner ?? telecaller,
      values.name ?? 'Ravi Kumar',
      values.phone,
      values.lifecycle ?? 'New',
    ],
  );
  return result.rows[0].id;
}

async function attachRecording(callId: string, uploader = telecaller) {
  const file = await db.query<{ id: string }>(
    `insert into public.object_files (organization_id, resource_type, resource_id, mime_type, uploaded_by)
     values ($1, 'call', $2, 'audio/mp4', $3) returning id`,
    [org, callId, uploader],
  );
  const result = await db.query<{ result: { recording_id: string } }>(
    'select public.attach_manual_call_recording($1, $2, $3) as result',
    [callId, file.rows[0].id, randomUUID()],
  );
  return result.rows[0].result.recording_id;
}

async function jobCount(callId: string) {
  const result = await db.query<{ n: number }>(
    'select count(*)::int as n from public.ai_call_processing_jobs where call_id = $1',
    [callId],
  );
  return result.rows[0].n;
}

describe('phone call recording sync', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(fixture);
    await db.query('insert into public.organizations (id) values ($1), ($2)', [org, otherOrg]);
    await db.query(
      `insert into public.profiles (id, organization_id) values ($1, $4), ($2, $4), ($3, $5)`,
      [telecaller, colleague, outsider, org, otherOrg],
    );
    await db.query('insert into public.branches (id, organization_id) values ($1, $3), ($2, $3)', [
      branch,
      otherBranch,
      org,
    ]);
    await db.query(
      'insert into public.teams (id, organization_id, branch_id) values ($1, $2, $3)',
      [team, org, branch],
    );
    await db.query(
      'insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4)',
      [org, team, telecaller, colleague],
    );
    await db.exec(source('supabase/migrations/202610182200_call_recording_sync.sql'));
  }, 30_000);

  beforeEach(async () => {
    await db.exec('begin');
  });

  afterEach(async () => {
    await db.exec('rollback');
  });

  afterAll(async () => {
    await db?.close();
  });

  it("files a recording on the caller's lead with that number", async () => {
    const leadId = await lead({ phone: '+919876543210' });
    await as(telecaller);
    const result = await sync('+91 98765 43210', 'Call recording Ravi.m4a');
    expect(result).toMatchObject({
      lead_id: leadId,
      customer_name: 'Ravi Kumar',
      phone: '+919876543210',
      matched: true,
      duplicate: false,
    });
    const call = await db.query<Record<string, unknown>>(
      'select * from public.calls where id = $1',
      [result.call_id],
    );
    expect(call.rows[0]).toMatchObject({
      call_source: 'PERSONAL_MANUAL',
      status: 'COMPLETED',
      outcome: 'CONNECTED',
      duration_seconds: 120,
      branch_id: branch,
      team_id: team,
      assigned_user_id: telecaller,
      normalized_caller_phone: '+919876543210',
    });
    const activity = await db.query('select 1 from public.activities where lead_id = $1', [leadId]);
    expect(activity.rows).toHaveLength(1);
  });

  it('normalizes the number forms recorder apps write', async () => {
    await as(telecaller);
    for (const [phone, file] of [
      ['09876543210', 'a'],
      ['919876543210', 'b'],
      ['9876543210', 'c'],
      ['+91-98765-43210', 'd'],
    ]) {
      expect((await sync(phone, file)).phone).toBe('+919876543210');
    }
    expect((await sync('+44 20 7946 0958', 'e')).phone).toBe('+442079460958');
    await expect(sync('Ravi', 'f')).rejects.toThrow('RECORDED_CALL_PHONE_INVALID');
  });

  it("logs a call with no lead for an unknown number, or for another user's lead", async () => {
    await lead({ phone: '+919876543210', owner: colleague });
    await lead({ phone: '+919876543210', branchId: otherBranch });
    await lead({ phone: '+919876543210', organizationId: otherOrg });
    await as(telecaller);
    const result = await sync('9876543210', 'unknown.m4a', 'INBOUND');
    expect(result).toMatchObject({ lead_id: null, customer_id: null, matched: false });
    const call = await db.query<{ branch_id: string; team_id: string; direction: string }>(
      'select branch_id, team_id, direction from public.calls where id = $1',
      [result.call_id],
    );
    // No lead: filed under the caller's own team.
    expect(call.rows[0]).toEqual({ branch_id: branch, team_id: team, direction: 'INBOUND' });
  });

  it('prefers an open lead over a lost one', async () => {
    await lead({ phone: '+919876543210', lifecycle: 'Lost', name: 'Lost one' });
    const open = await lead({ phone: '+919876543210', name: 'Open one' });
    await as(telecaller);
    expect((await sync('9876543210', 'x')).lead_id).toBe(open);
  });

  it('returns the existing call when the same file is synced again', async () => {
    await as(telecaller);
    const first = await sync('9876543210', 'same.m4a');
    const second = await sync('9876543210', 'same.m4a');
    expect(second).toMatchObject({ call_id: first.call_id, duplicate: true, has_recording: false });
    await attachRecording(first.call_id);
    expect((await sync('9876543210', 'same.m4a')).has_recording).toBe(true);
    const calls = await db.query('select 1 from public.calls');
    expect(calls.rows).toHaveLength(1);
  });

  it('refuses callers without call.create, without a tenant, or with bad input', async () => {
    await as(telecaller, { permissions: ['call.view'] });
    await expect(sync('9876543210', 'x')).rejects.toThrow('PERMISSION_DENIED');
    await db.exec('rollback; begin');
    await as(outsider, { organization: '' });
    await expect(sync('9876543210', 'x')).rejects.toThrow('PERMISSION_DENIED');
    await db.exec('rollback; begin');
    await as(telecaller);
    await expect(
      db.query(
        "select public.log_recorded_phone_call('9876543210', 'OUTBOUND', now(), 1, 'not-a-hash', null)",
      ),
    ).rejects.toThrow('RECORDED_CALL_SYNC_KEY_INVALID');
    await db.exec('rollback; begin');
    await as(telecaller);
    await expect(sync('9876543210', 'x', 'SIDEWAYS')).rejects.toThrow('INVALID_CALL_DIRECTION');
  });

  it('does not queue AI for a manual upload unless the uploader chose auto', async () => {
    await as(telecaller);
    const manual = await sync('9876543210', 'manual');
    await attachRecording(manual.call_id);
    expect(await jobCount(manual.call_id)).toBe(0);

    await db.query('select public.set_my_call_ai_preferences(true, null)');
    const auto = await sync('9876543210', 'auto');
    await attachRecording(auto.call_id);
    expect(await jobCount(auto.call_id)).toBe(1);

    const audit = await db.query(
      "select 1 from public.audit_logs where action = 'call_ai.preferences_updated'",
    );
    expect(audit.rows).toHaveLength(1);
    const prefs = await db.query<{ result: { auto_process: boolean; auto_sync: boolean } }>(
      'select public.get_my_call_ai_preferences() as result',
    );
    expect(prefs.rows[0].result).toMatchObject({ auto_process: true, auto_sync: true });
  });

  it('queues AI once from the button and reports the state', async () => {
    await as(telecaller);
    const synced = await sync('9876543210', 'button');
    await expect(
      db.query('select public.request_call_ai_processing($1)', [synced.call_id]),
    ).rejects.toThrow('CALL_RECORDING_NOT_READY');
    await db.exec('rollback; begin');
    await as(telecaller);
    const again = await sync('9876543210', 'button');
    await attachRecording(again.call_id);

    const state = async () =>
      (
        await db.query<{ result: Record<string, unknown> }>(
          'select public.get_call_ai_processing_state($1) as result',
          [again.call_id],
        )
      ).rows[0].result;
    expect(await state()).toMatchObject({
      recording_ready: true,
      job: null,
      can_request: true,
      can_regenerate: false,
      can_create_lead: true,
      auto_process: false,
      phone: '+919876543210',
    });

    const first = await db.query<{ result: { job_id: string; queued: boolean } }>(
      'select public.request_call_ai_processing($1) as result',
      [again.call_id],
    );
    const second = await db.query<{ result: { job_id: string; queued: boolean } }>(
      'select public.request_call_ai_processing($1) as result',
      [again.call_id],
    );
    expect(first.rows[0].result.queued).toBe(true);
    expect(second.rows[0].result).toEqual({ ...first.rows[0].result, queued: false });
    expect(await jobCount(again.call_id)).toBe(1);
    expect(await state()).toMatchObject({ can_request: false, job: { status: 'QUEUED' } });

    // A failed job can be asked for again, with a fresh attempt budget.
    await db.query(
      "update public.ai_call_processing_jobs set status = 'FAILED', attempt_count = 7 where call_id = $1",
      [again.call_id],
    );
    await db.query('select public.request_call_ai_processing($1)', [again.call_id]);
    const job = await db.query<{ status: string; attempt_count: number }>(
      'select status, attempt_count from public.ai_call_processing_jobs where call_id = $1',
      [again.call_id],
    );
    expect(job.rows[0]).toEqual({ status: 'QUEUED', attempt_count: 0 });

    await db.query(
      "update public.ai_call_processing_jobs set status = 'COMPLETED' where call_id = $1",
      [again.call_id],
    );
    await expect(
      db.query('select public.request_call_ai_processing($1)', [again.call_id]),
    ).rejects.toThrow('AI_ALREADY_DONE');
  });

  it("refuses AI on another user's call without call.update", async () => {
    await as(colleague);
    const synced = await sync('9876543210', 'colleague');
    await attachRecording(synced.call_id, colleague);
    await as(telecaller, { ownOnly: false });
    await expect(
      db.query('select public.request_call_ai_processing($1)', [synced.call_id]),
    ).rejects.toThrow('PERMISSION_DENIED');
    await db.exec('rollback; begin');
    await as(colleague);
    const again = await sync('9876543210', 'colleague');
    await attachRecording(again.call_id, colleague);
    await as(telecaller, { ownOnly: false, permissions: [...workerPermissions, 'call.update'] });
    const result = await db.query<{ result: { queued: boolean } }>(
      'select public.request_call_ai_processing($1) as result',
      [again.call_id],
    );
    expect(result.rows[0].result.queued).toBe(true);
  });

  it('keeps suggestions for a call with no lead and creates the lead the user confirmed', async () => {
    await as(telecaller);
    const synced = await sync('9876543210', 'new-lead');
    await attachRecording(synced.call_id);
    const job = await db.query<{ result: { job_id: string } }>(
      'select public.request_call_ai_processing($1) as result',
      [synced.call_id],
    );
    const jobId = job.rows[0].result.job_id;
    const lease = randomUUID();
    await db.query(
      "update public.ai_call_processing_jobs set status = 'PROCESSING', lease_token = $2 where id = $1",
      [jobId, lease],
    );
    await db.query(
      `insert into public.call_transcripts (organization_id, call_id, processing_job_id, status)
       values ($1, $2, $3, 'PROCESSING')`,
      [org, synced.call_id, jobId],
    );
    await asWorker();
    const saved = await db.query<{ saved: boolean }>(
      `select public.save_ai_call_analysis_result($1, $2, 'Hello, I want a City', '[]', null,
         'Customer wants a City', $3, 'test-model') as saved`,
      [
        jobId,
        lease,
        JSON.stringify({
          customer_name: 'Ravi Kumar',
          email: 'ravi@example.com',
          interested_model: 'City',
          temperature: 'HOT',
        }),
      ],
    );
    expect(saved.rows[0].saved).toBe(true);

    await as(telecaller);
    const review = await db.query<{
      result: { call: { phone: string }; extraction: { fields: Array<{ field_key: string }> } };
    }>('select public.get_ai_call_field_review($1) as result', [synced.call_id]);
    expect(review.rows[0].result.call.phone).toBe('+919876543210');
    expect(review.rows[0].result.extraction.fields.map((field) => field.field_key)).toEqual([
      'customer_name',
      'email',
      'interested_model',
      'temperature',
    ]);

    const requestId = randomUUID();
    const decisions = JSON.stringify([
      { field_key: 'temperature', decision: 'APPLIED' },
      { field_key: 'customer_name', decision: 'APPLIED' },
    ]);
    const created = await db.query<{ result: { lead_id: string; accepted_fields: string[] } }>(
      `select public.create_lead_from_call_review($1, 'Ravi Kumar', 'RAVI@example.com',
         'Honda City', $2, $3) as result`,
      [synced.call_id, decisions, requestId],
    );
    const leadId = created.rows[0].result.lead_id;
    expect(created.rows[0].result.accepted_fields).toEqual(['temperature']);

    const newLead = await db.query<Record<string, unknown>>(
      'select customer_name, normalized_phone, email, interested_model, source, source_detail, assigned_user_id from public.leads where id = $1',
      [leadId],
    );
    expect(newLead.rows[0]).toEqual({
      customer_name: 'Ravi Kumar',
      normalized_phone: '+919876543210',
      email: 'ravi@example.com',
      interested_model: 'Honda City',
      source: 'Manual',
      source_detail: 'Phone call recording',
      assigned_user_id: telecaller,
    });
    const call = await db.query<{ lead_id: string }>(
      'select lead_id from public.calls where id = $1',
      [synced.call_id],
    );
    expect(call.rows[0].lead_id).toBe(leadId);
    const run = await db.query<{ lead_id: string }>(
      'select lead_id from public.ai_extraction_runs where call_id = $1',
      [synced.call_id],
    );
    expect(run.rows[0].lead_id).toBe(leadId);

    // Identity fields are recorded as reviewed here; only the rest goes through
    // review_ai_call_fields.
    const reviews = await db.query<{ field_key: string; decision: string }>(
      'select field_key, decision from public.ai_field_reviews order by field_key',
    );
    expect(reviews.rows).toEqual([
      { field_key: 'customer_name', decision: 'APPLIED' },
      { field_key: 'email', decision: 'APPLIED' },
      { field_key: 'interested_model', decision: 'EDITED' },
    ]);
    const stub = await db.query<{ metadata: { decisions: Array<{ field_key: string }> } }>(
      "select metadata from public.audit_logs where action = 'stub.review'",
    );
    expect(stub.rows[0].metadata.decisions.map((decision) => decision.field_key)).toEqual([
      'temperature',
    ]);

    const replay = await db.query<{ result: { lead_id: string; replayed: boolean } }>(
      `select public.create_lead_from_call_review($1, 'Ravi Kumar', null, null, '[]', $2) as result`,
      [synced.call_id, requestId],
    );
    expect(replay.rows[0].result).toMatchObject({ lead_id: leadId, replayed: true });
    await expect(
      db.query(
        `select public.create_lead_from_call_review($1, 'Ravi Kumar', null, null, '[]', $2)`,
        [synced.call_id, randomUUID()],
      ),
    ).rejects.toThrow('CALL_ALREADY_HAS_LEAD');
  });

  it('refuses a lead from a call the caller cannot see', async () => {
    await as(colleague);
    const hidden = await sync('9876543210', 'hidden');
    await as(outsider, { organization: otherOrg, branches: [branch] });
    await expect(
      db.query('select public.get_call_ai_processing_state($1)', [hidden.call_id]),
    ).rejects.toThrow('PERMISSION_DENIED');
    await db.exec('rollback; begin');
    await as(colleague);
    const again = await sync('9876543210', 'hidden');
    await as(telecaller);
    await expect(
      db.query(`select public.create_lead_from_call_review($1, 'Ravi', null, null, '[]', $2)`, [
        again.call_id,
        randomUUID(),
      ]),
    ).rejects.toThrow('CALL_ACCESS_DENIED');
  });
});
