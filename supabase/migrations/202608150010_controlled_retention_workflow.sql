begin;

-- Tenant deletion is deliberately the only permanent-purge target in this
-- release. Adding another resource type requires a separately reviewed purge
-- implementation; a generic resource_id delete would be unsafe.
alter table public.deletion_requests
  alter column status set default 'PENDING_APPROVAL',
  add column idempotency_key uuid,
  add column request_hash text,
  add column original_status public.tenant_status,
  add column approved_by uuid references public.profiles(id),
  add column approved_at timestamptz,
  add column decision_reason_hash text,
  add column legal_hold boolean not null default false,
  add column legal_hold_reason text,
  add column legal_hold_by uuid references public.profiles(id),
  add column legal_hold_at timestamptz,
  add column restored_by uuid references public.profiles(id),
  add column restored_at timestamptz,
  add column restore_reason_hash text,
  add column purge_started_at timestamptz,
  add column failure_safe_code text,
  add column updated_at timestamptz not null default now(),
  add constraint deletion_requests_tenant_only check (
    resource_type = 'ORGANIZATION' and resource_id = organization_id
  ) not valid,
  add constraint deletion_requests_status_check check (
    status in (
      'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED',
      'RESTORED', 'REJECTED', 'PURGED'
    )
  ) not valid,
  add constraint deletion_requests_request_hash_check check (
    request_hash is null or request_hash ~ '^[0-9a-f]{64}$'
  ) not valid,
  add constraint deletion_requests_reason_hash_check check (
    decision_reason_hash is null or decision_reason_hash ~ '^[0-9a-f]{64}$'
  ) not valid,
  add constraint deletion_requests_restore_hash_check check (
    restore_reason_hash is null or restore_reason_hash ~ '^[0-9a-f]{64}$'
  ) not valid,
  add constraint deletion_requests_legal_hold_shape check (
    (
      not legal_hold
      and legal_hold_reason is null
      and legal_hold_by is null
      and legal_hold_at is null
    )
    or (
      legal_hold
      and legal_hold_reason is not null
      and legal_hold_by is not null
      and legal_hold_at is not null
    )
  ) not valid;

create unique index deletion_requests_actor_idempotency_idx
  on public.deletion_requests (requested_by, idempotency_key)
  where idempotency_key is not null;
with ranked_requests as (
  select id,
    row_number() over (
      partition by organization_id
      order by created_at, id
    ) as row_number
  from public.deletion_requests
  where status in ('PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED')
)
update public.deletion_requests request_row
set status = 'REJECTED',
    failure_safe_code = 'DUPLICATE_LEGACY_REQUEST',
    updated_at = now()
from ranked_requests ranked_row
where ranked_row.id = request_row.id and ranked_row.row_number > 1;
create unique index deletion_requests_one_open_tenant_idx
  on public.deletion_requests (organization_id)
  where status in ('PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED');
create index deletion_requests_retention_queue_idx
  on public.deletion_requests (purge_after, id)
  where status = 'APPROVED' and not legal_hold;

alter table public.purge_jobs
  add column lease_token uuid,
  add column worker_id text,
  add column leased_until timestamptz,
  add column next_attempt_at timestamptz not null default now(),
  add column last_error_code text,
  add column last_error_at timestamptz,
  add column manual_requeues integer not null default 0,
  add column updated_at timestamptz not null default now(),
  add constraint purge_jobs_status_check check (
    status in ('QUEUED', 'PROCESSING', 'RETRY', 'FAILED', 'CANCELLED', 'COMPLETED')
  ) not valid,
  add constraint purge_jobs_attempts_check check (attempts between 0 and 12) not valid;

-- Preserve the oldest job as the canonical history if a pre-existing deployment
-- accidentally created duplicate jobs before this uniqueness rule existed.
with ranked_jobs as (
  select id,
    row_number() over (
      partition by deletion_request_id
      order by created_at, id
    ) as row_number
  from public.purge_jobs
)
update public.purge_jobs job_row
set status = 'CANCELLED',
    last_error_code = 'DUPLICATE_LEGACY_JOB',
    updated_at = now()
from ranked_jobs ranked_row
where ranked_row.id = job_row.id and ranked_row.row_number > 1;

create unique index purge_jobs_one_per_deletion_request_idx
  on public.purge_jobs (deletion_request_id)
  where status <> 'CANCELLED';
create index purge_jobs_claim_idx
  on public.purge_jobs (next_attempt_at, created_at, id)
  where status in ('QUEUED', 'RETRY', 'PROCESSING');

create table public.retention_suspensions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  deletion_request_id uuid not null references public.deletion_requests(id) on delete cascade,
  resource_type text not null check (
    resource_type in (
      'PROFILE', 'CONNECTED_ACCOUNT', 'AUTOMATION_RULE', 'ALERT_RULE',
      'TENANT_INSTALLATION', 'DOMAIN_OUTBOX', 'PROVIDER_EVENT'
    )
  ),
  resource_id uuid not null,
  prior_state jsonb not null check (jsonb_typeof(prior_state) = 'object'),
  created_at timestamptz not null default now(),
  unique (deletion_request_id, resource_type, resource_id)
);

create table public.purge_manifests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  deletion_request_id uuid not null unique references public.deletion_requests(id),
  resource_type text not null check (resource_type = 'ORGANIZATION'),
  resource_id uuid not null,
  status text not null default 'PREPARED' check (
    status in ('PREPARED', 'PROCESSING', 'RETRY', 'FAILED', 'COMPLETED')
  ),
  disposition text not null default 'DELETE_DEPENDENTS_AND_IRREVERSIBLY_ANONYMIZE_ROOT'
    check (disposition = 'DELETE_DEPENDENTS_AND_IRREVERSIBLY_ANONYMIZE_ROOT'),
  planned_object_count bigint not null default 0 check (planned_object_count >= 0),
  deleted_object_count bigint not null default 0 check (deleted_object_count >= 0),
  planned_auth_identity_count bigint not null default 0
    check (planned_auth_identity_count >= 0),
  deleted_auth_identity_count bigint not null default 0
    check (deleted_auth_identity_count >= 0),
  planned_external_connection_count bigint not null default 0
    check (planned_external_connection_count >= 0),
  data_current_table text,
  data_last_completed_order integer not null default 0,
  deleted_row_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(deleted_row_counts) = 'object'),
  final_checksum text,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint purge_manifest_tenant_shape check (
    resource_id = organization_id
    and (final_checksum is null or final_checksum ~ '^[0-9a-f]{64}$')
  )
);

create table public.purge_manifest_objects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  manifest_id uuid not null references public.purge_manifests(id) on delete cascade,
  source_type text not null check (source_type in ('OBJECT_FILE', 'UPLOAD_INTENT')),
  source_id uuid not null,
  object_file_id uuid,
  bucket text,
  object_key text,
  object_locator_hash text not null check (object_locator_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'DELETED')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  last_error_code text,
  storage_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (manifest_id, source_type, source_id),
  constraint purge_manifest_object_locator check (
    (status = 'PENDING' and bucket is not null and object_key is not null)
    or (status = 'DELETED' and bucket is null and object_key is null and storage_deleted_at is not null)
  )
);

create table public.purge_manifest_auth_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  manifest_id uuid not null references public.purge_manifests(id) on delete cascade,
  user_id uuid not null,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'SOFT_DELETED', 'NOT_FOUND')
  ),
  attempts integer not null default 0 check (attempts between 0 and 100),
  last_error_code text,
  auth_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (manifest_id, user_id),
  constraint purge_manifest_auth_completion check (
    (status = 'PENDING' and auth_deleted_at is null)
    or (status in ('SOFT_DELETED', 'NOT_FOUND') and auth_deleted_at is not null)
  )
);

-- This reviewed list is the fail-closed boundary for tenant data disposal. The
-- purge worker refuses to enter the data phase if a future organization-scoped
-- table is absent, preventing a schema change from silently leaving tenant data.
create table app_private.retention_table_allowlist (
  table_name name primary key,
  disposition text not null check (disposition in ('DELETE', 'ANONYMIZE', 'RETAIN_SYSTEM')),
  delete_order integer unique,
  constraint retention_allowlist_order check (
    (disposition = 'DELETE' and delete_order is not null)
    or (disposition <> 'DELETE' and delete_order is null)
  )
);

-- PostgreSQL's built-in SHA-256 avoids depending on the deployment-specific
-- schema used for the pgcrypto extension inside security-definer functions.
create or replace function app_private.sha256_hex(target_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(target_value, 'UTF8')), 'hex');
$$;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
values
  ('organization_onboarding_documents', 'DELETE', 10),
  ('finance_case_documents', 'DELETE', 20),
  ('insurance_case_documents', 'DELETE', 30),
  ('rto_case_documents', 'DELETE', 40),
  ('case_documents', 'DELETE', 50),
  ('object_upload_intents', 'DELETE', 60),
  ('call_recordings', 'DELETE', 70),
  ('call_transcripts', 'DELETE', 80),
  ('ai_call_summaries', 'DELETE', 90),
  ('ai_field_reviews', 'DELETE', 100),
  ('conversation_messages', 'DELETE', 110),
  ('test_drive_route_summaries', 'DELETE', 120),
  ('test_drive_route_points', 'DELETE', 130),
  ('test_drive_feedback', 'DELETE', 140),
  ('live_tracking_sessions', 'DELETE', 150),
  ('delivery_checklist_items', 'DELETE', 160),
  ('exchange_evaluations', 'DELETE', 170),
  ('approval_history', 'DELETE', 180),
  ('booking_status_history', 'DELETE', 190),
  ('quotation_items', 'DELETE', 200),
  ('quotation_versions', 'DELETE', 210),
  ('stock_movements', 'DELETE', 220),
  ('lead_assignments', 'DELETE', 230),
  ('lead_assignment_history', 'DELETE', 240),
  ('lead_stage_history', 'DELETE', 250),
  ('lead_temperature_history', 'DELETE', 260),
  ('custom_field_values', 'DELETE', 270),
  ('automation_runs', 'DELETE', 280),
  ('integration_oauth_states', 'DELETE', 290),
  ('provider_events', 'DELETE', 300),
  ('sync_runs', 'DELETE', 310),
  ('integration_field_mappings', 'DELETE', 320),
  ('integration_branch_mappings', 'DELETE', 330),
  ('integration_credentials', 'DELETE', 340),
  ('organization_onboarding_submissions', 'DELETE', 350),
  ('mobile_link_challenges', 'DELETE', 360),
  ('email_messages', 'DELETE', 370),
  ('notifications', 'DELETE', 380),
  ('domain_outbox', 'DELETE', 390),
  ('error_logs', 'DELETE', 400),
  ('tenant_installations', 'DELETE', 410),
  ('support_sessions', 'DELETE', 420),
  ('support_access_requests', 'DELETE', 430),
  ('module_usage', 'DELETE', 440),
  ('organization_module_entitlements', 'DELETE', 450),
  ('reminders', 'DELETE', 460),
  ('notes', 'DELETE', 470),
  ('activities', 'DELETE', 480),
  ('escalations', 'DELETE', 490),
  ('feedback_requests', 'DELETE', 500),
  ('complaints', 'DELETE', 510),
  ('delivery_cases', 'DELETE', 520),
  ('finance_cases', 'DELETE', 530),
  ('insurance_cases', 'DELETE', 540),
  ('rto_cases', 'DELETE', 550),
  ('exchange_cases', 'DELETE', 560),
  ('stock_allocations', 'DELETE', 570),
  ('bookings', 'DELETE', 580),
  ('approvals', 'DELETE', 590),
  ('quotations', 'DELETE', 600),
  ('test_drives', 'DELETE', 610),
  ('test_drive_appointments', 'DELETE', 620),
  ('appointments', 'DELETE', 630),
  ('ai_extraction_runs', 'DELETE', 640),
  ('conversations', 'DELETE', 650),
  ('calls', 'DELETE', 660),
  ('followups', 'DELETE', 670),
  ('tasks', 'DELETE', 680),
  ('targets', 'DELETE', 690),
  ('stock_units', 'DELETE', 700),
  ('vehicle_variants', 'DELETE', 710),
  ('vehicle_models', 'DELETE', 720),
  ('vehicle_brands', 'DELETE', 730),
  ('customer_vehicles', 'DELETE', 740),
  ('customer_contacts', 'DELETE', 750),
  ('customer_addresses', 'DELETE', 760),
  ('leads', 'DELETE', 770),
  ('customers', 'DELETE', 780),
  ('connected_accounts', 'DELETE', 790),
  ('custom_field_definitions', 'DELETE', 800),
  ('lead_sources', 'DELETE', 810),
  ('automation_rules', 'DELETE', 820),
  ('templates', 'DELETE', 830),
  ('alert_rules', 'DELETE', 840),
  ('object_files', 'DELETE', 850),
  ('team_members', 'DELETE', 860),
  ('user_branch_access', 'DELETE', 870),
  ('user_role_assignments', 'DELETE', 880),
  ('teams', 'DELETE', 890),
  ('roles', 'DELETE', 900),
  ('branches', 'DELETE', 910),
  ('profiles', 'ANONYMIZE', null),
  ('credit_ledger', 'ANONYMIZE', null),
  ('audit_logs', 'ANONYMIZE', null),
  ('tenant_status_history', 'ANONYMIZE', null),
  ('deletion_requests', 'RETAIN_SYSTEM', null),
  ('purge_jobs', 'RETAIN_SYSTEM', null),
  ('retention_suspensions', 'RETAIN_SYSTEM', null),
  ('purge_manifests', 'RETAIN_SYSTEM', null),
  ('purge_manifest_objects', 'RETAIN_SYSTEM', null),
  ('purge_manifest_auth_identities', 'RETAIN_SYSTEM', null);

alter table public.retention_suspensions enable row level security;
alter table public.retention_suspensions force row level security;
alter table public.purge_manifests enable row level security;
alter table public.purge_manifests force row level security;
alter table public.purge_manifest_objects enable row level security;
alter table public.purge_manifest_objects force row level security;
alter table public.purge_manifest_auth_identities enable row level security;
alter table public.purge_manifest_auth_identities force row level security;

drop policy if exists tenant_record_scope on public.deletion_requests;
drop policy if exists tenant_record_scope on public.purge_jobs;
drop policy if exists retention_platform_read on public.deletion_requests;
drop policy if exists retention_platform_read on public.purge_jobs;
create policy retention_platform_read on public.deletion_requests
for select to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
create policy retention_platform_read on public.purge_jobs
for select to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
create policy purge_manifests_platform_read on public.purge_manifests
for select to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
revoke all on public.retention_suspensions from public, anon, authenticated;
revoke all on public.purge_manifests from public, anon, authenticated;
revoke all on public.purge_manifest_objects from public, anon, authenticated;
revoke all on public.purge_manifest_auth_identities from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.deletion_requests, public.purge_jobs
  from public, anon, authenticated;
grant select on public.deletion_requests, public.purge_jobs, public.purge_manifests
  to authenticated;
grant select on public.purge_manifest_objects, public.purge_manifest_auth_identities
  to service_role;

-- Audit and credit records remain immutable for every ordinary caller. A
-- service-role purge may redact their tenant PII only while the local flag is
-- set inside the finalization transaction.
create or replace function app_private.prevent_immutable_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and auth.role() = 'service_role'
    and current_setting('app.controlled_retention_purge', true) = 'on'
  then
    return new;
  end if;
  raise exception using errcode = '42501', message = 'IMMUTABLE_RECORD';
end;
$$;

create or replace function app_private.require_platform_retention_actor()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;
end;
$$;

-- The existing row guards correctly prevent ordinary platform users from
-- mutating tenant identities or provider state. Permit only this migration's
-- audited retention transition, which is additionally bound to a platform AAL2
-- actor by require_platform_retention_actor().
create or replace function app_private.validate_profile_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_authority integer;
  target_authority integer;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if current_setting('app.controlled_retention_transition', true) = 'on'
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  then
    new.updated_at := now();
    return new;
  end if;
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if old.id = auth.uid() then
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.email is distinct from old.email
      or new.employee_id is distinct from old.employee_id
      or new.active is distinct from old.active
      or new.mfa_required is distinct from old.mfa_required
      or new.deleted_at is distinct from old.deleted_at
      or new.created_at is distinct from old.created_at
    then
      raise exception using errcode = '42501', message = 'PROFILE_SECURITY_FIELDS_IMMUTABLE';
    end if;
  else
    if app_private.is_platform_admin() then
      raise exception using errcode = '42501', message = 'PLATFORM_PROFILE_MUTATION_REQUIRES_SERVICE_ROLE';
    end if;
    if old.organization_id is null or not app_private.has_permission(old.organization_id, 'user.manage') then
      raise exception using errcode = '42501', message = 'USER_MANAGE_PERMISSION_REQUIRED';
    end if;
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.email is distinct from old.email
      or new.deleted_at is distinct from old.deleted_at
      or new.created_at is distinct from old.created_at
    then
      raise exception using errcode = '42501', message = 'PROFILE_IDENTITY_FIELDS_IMMUTABLE';
    end if;

    select coalesce(max(role_row.authority_level), -1) into actor_authority
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.user_id = auth.uid()
      and assignment_row.organization_id = old.organization_id
      and assignment_row.active;
    select coalesce(max(role_row.authority_level), -1) into target_authority
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.user_id = old.id
      and assignment_row.organization_id = old.organization_id
      and assignment_row.active;
    if target_authority >= actor_authority then
      raise exception using errcode = '42501', message = 'USER_AUTHORITY_CEILING_EXCEEDED';
    end if;
  end if;

  new.updated_at := now();
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    old.organization_id,
    auth.uid(),
    'profile.updated',
    'profile',
    old.id::text,
    jsonb_build_object(
      'self_update', old.id = auth.uid(),
      'active_changed', new.active is distinct from old.active,
      'mfa_policy_changed', new.mfa_required is distinct from old.mfa_required
    )
  );
  return new;
end;
$$;

create or replace function app_private.validate_connected_account_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if current_setting('app.controlled_retention_transition', true) = 'on'
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  then
    new.updated_at := now();
    return new;
  end if;
  if auth.uid() is null
    or not app_private.has_permission(new.organization_id, 'integration.manage')
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if char_length(btrim(coalesce(new.provider_key, ''))) not between 2 and 80
    or char_length(btrim(coalesce(new.display_name, ''))) not between 2 and 160
  then
    raise exception using errcode = '22023', message = 'INVALID_CONNECTED_ACCOUNT';
  end if;
  if tg_op = 'INSERT' then
    if new.created_by is distinct from auth.uid()
      or new.status <> 'PENDING'
      or new.credential_version <> 1
      or new.external_account_id is not null
      or new.last_tested_at is not null
      or new.last_sync_at is not null
      or new.deleted_at is not null
    then
      raise exception using errcode = '42501', message = 'CONNECTED_ACCOUNT_SERVER_FIELDS_FORBIDDEN';
    end if;
  elsif new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.provider_key is distinct from old.provider_key
    or new.scope_mode is distinct from old.scope_mode
    or new.status is distinct from old.status
    or new.external_account_id is distinct from old.external_account_id
    or new.credential_version is distinct from old.credential_version
    or new.last_tested_at is distinct from old.last_tested_at
    or new.last_sync_at is distinct from old.last_sync_at
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception using errcode = '42501', message = 'CONNECTED_ACCOUNT_SERVER_FIELDS_IMMUTABLE';
  end if;

  new.updated_at := now();
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    new.organization_id,
    auth.uid(),
    case
      when tg_op = 'INSERT' then 'integration.connection.created'
      when new.deleted_at is distinct from old.deleted_at then 'integration.connection.deletion_changed'
      else 'integration.connection.updated'
    end,
    'connected_account',
    new.id::text,
    jsonb_build_object('provider_key', new.provider_key, 'deleted', new.deleted_at is not null)
  );
  return new;
end;
$$;

create or replace function app_private.restore_tenant_from_retention_snapshot(
  target_request_id uuid,
  target_actor_id uuid,
  target_terminal_status text,
  target_reason text
)
returns public.deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.deletion_requests%rowtype;
declare restored_status public.tenant_status;
declare normalized_reason text := btrim(coalesce(target_reason, ''));
begin
  if target_terminal_status not in ('RESTORED', 'REJECTED')
    or char_length(normalized_reason) not between 10 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_RESTORE_DECISION';
  end if;
  perform set_config('app.controlled_retention_transition', 'on', true);

  select * into request_row
  from public.deletion_requests
  where id = target_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELETION_REQUEST_NOT_FOUND';
  end if;
  if request_row.status not in ('PENDING', 'PENDING_APPROVAL', 'APPROVED')
    or request_row.purge_after is null
    or request_row.purge_after <= now()
  then
    raise exception using errcode = '23514', message = 'RESTORE_WINDOW_CLOSED';
  end if;

  restored_status := coalesce(request_row.original_status, 'SUSPENDED'::public.tenant_status);

  update public.profiles profile_row
  set active = coalesce((snapshot_row.prior_state ->> 'active')::boolean, false),
      updated_at = now()
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'PROFILE'
    and profile_row.id = snapshot_row.resource_id
    and profile_row.organization_id = request_row.organization_id
    and profile_row.deleted_at is null;

  update public.connected_accounts account_row
  set status = snapshot_row.prior_state ->> 'status',
      deleted_at = (snapshot_row.prior_state ->> 'deleted_at')::timestamptz,
      updated_at = now()
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'CONNECTED_ACCOUNT'
    and account_row.id = snapshot_row.resource_id
    and account_row.organization_id = request_row.organization_id;

  update public.automation_rules rule_row
  set enabled = coalesce((snapshot_row.prior_state ->> 'enabled')::boolean, false),
      updated_at = now()
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'AUTOMATION_RULE'
    and rule_row.id = snapshot_row.resource_id
    and rule_row.organization_id = request_row.organization_id;

  update public.alert_rules rule_row
  set enabled = coalesce((snapshot_row.prior_state ->> 'enabled')::boolean, false)
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'ALERT_RULE'
    and rule_row.id = snapshot_row.resource_id
    and rule_row.organization_id = request_row.organization_id;

  update public.tenant_installations installation_row
  set status = snapshot_row.prior_state ->> 'status'
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'TENANT_INSTALLATION'
    and installation_row.id = snapshot_row.resource_id
    and installation_row.organization_id = request_row.organization_id;

  update public.domain_outbox outbox_row
  set dead_lettered_at = null,
      locked_at = null,
      locked_by = null,
      last_error_code = snapshot_row.prior_state ->> 'last_error_code',
      next_attempt_at = greatest(
        now(),
        coalesce((snapshot_row.prior_state ->> 'next_attempt_at')::timestamptz, now())
      )
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'DOMAIN_OUTBOX'
    and outbox_row.id = snapshot_row.resource_id
    and outbox_row.organization_id = request_row.organization_id
    and outbox_row.published_at is null;

  update public.provider_events event_row
  set status = case
        when snapshot_row.prior_state ->> 'status' = 'PROCESSING' then 'RETRY'
        else snapshot_row.prior_state ->> 'status'
      end,
      safe_error_code = snapshot_row.prior_state ->> 'safe_error_code',
      next_attempt_at = greatest(
        now(),
        coalesce((snapshot_row.prior_state ->> 'next_attempt_at')::timestamptz, now())
      ),
      processing_started_at = null,
      processing_worker_id = null,
      processed_at = null
  from public.retention_suspensions snapshot_row
  where snapshot_row.deletion_request_id = request_row.id
    and snapshot_row.resource_type = 'PROVIDER_EVENT'
    and event_row.id = snapshot_row.resource_id
    and event_row.organization_id = request_row.organization_id;

  update public.organizations
  set status = restored_status,
      deleted_at = null,
      deleted_by = null,
      deletion_reason = null,
      purge_after = null,
      updated_at = now()
  where id = request_row.organization_id and status = 'SOFT_DELETED';
  if not found then
    raise exception using errcode = '23514', message = 'TENANT_NOT_SOFT_DELETED';
  end if;

  update public.deletion_requests
  set status = target_terminal_status,
      restored_by = target_actor_id,
      restored_at = now(),
      restore_reason_hash = app_private.sha256_hex(normalized_reason),
      legal_hold = false,
      legal_hold_reason = null,
      legal_hold_by = null,
      legal_hold_at = null,
      updated_at = now()
  where id = request_row.id
  returning * into request_row;

  update public.purge_jobs
  set status = 'CANCELLED',
      lease_token = null,
      worker_id = null,
      leased_until = null,
      updated_at = now()
  where deletion_request_id = request_row.id and status <> 'COMPLETED';

  insert into public.tenant_status_history (
    organization_id, from_status, to_status, changed_by, reason
  ) values (
    request_row.organization_id, 'SOFT_DELETED', restored_status, target_actor_id,
    'Retention restore decision; reason hash ' || app_private.sha256_hex(normalized_reason)
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id,
    target_actor_id,
    case when target_terminal_status = 'REJECTED'
      then 'retention.deletion_rejected'
      else 'retention.tenant_restored'
    end,
    'organization',
    request_row.organization_id::text,
    jsonb_build_object(
      'deletion_request_id', request_row.id,
      'reason_hash', app_private.sha256_hex(normalized_reason)
    )
  );
  delete from public.retention_suspensions
  where deletion_request_id = request_row.id;
  return request_row;
end;
$$;

create or replace function public.request_tenant_deletion(
  target_organization_id uuid,
  deletion_reason text,
  retention_days integer,
  request_idempotency_key uuid
)
returns public.deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare organization_row public.organizations%rowtype;
declare request_row public.deletion_requests%rowtype;
declare normalized_reason text := btrim(coalesce(deletion_reason, ''));
declare normalized_hash text;
declare target_purge_after timestamptz;
begin
  perform app_private.require_platform_retention_actor();
  if target_organization_id is null
    or request_idempotency_key is null
    or retention_days not between 1 and 3650
    or char_length(normalized_reason) not between 10 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_DELETION_REQUEST';
  end if;
  perform set_config('app.controlled_retention_transition', 'on', true);
  normalized_hash := app_private.sha256_hex(
    target_organization_id::text || '|' || retention_days::text || '|' || normalized_reason
  );

  select * into request_row
  from public.deletion_requests
  where requested_by = auth.uid() and idempotency_key = request_idempotency_key;
  if found then
    if request_row.request_hash <> normalized_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return request_row;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tenant-retention:' || target_organization_id::text, 0));
  select * into organization_row
  from public.organizations
  where id = target_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ORGANIZATION_NOT_FOUND';
  end if;
  if organization_row.status in ('SOFT_DELETED', 'SUPPORT_MAINTENANCE')
    or organization_row.deleted_at is not null
  then
    raise exception using errcode = '23514', message = 'TENANT_NOT_DELETION_ELIGIBLE';
  end if;
  if exists (
    select 1 from public.support_sessions session_row
    where session_row.organization_id = target_organization_id
      and session_row.ended_at is null
      and session_row.expires_at > now()
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_SUPPORT_SESSION_EXISTS';
  end if;

  target_purge_after := now() + make_interval(days => retention_days);
  insert into public.deletion_requests (
    organization_id, resource_type, resource_id, requested_by, reason,
    status, purge_after, idempotency_key, request_hash, original_status
  ) values (
    target_organization_id, 'ORGANIZATION', target_organization_id, auth.uid(),
    normalized_reason, 'PENDING_APPROVAL', target_purge_after,
    request_idempotency_key, normalized_hash, organization_row.status
  ) returning * into request_row;

  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'PROFILE', profile_row.id,
    jsonb_build_object('active', profile_row.active)
  from public.profiles profile_row
  where profile_row.organization_id = target_organization_id;
  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'CONNECTED_ACCOUNT', account_row.id,
    jsonb_build_object('status', account_row.status, 'deleted_at', account_row.deleted_at)
  from public.connected_accounts account_row
  where account_row.organization_id = target_organization_id;
  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'AUTOMATION_RULE', rule_row.id,
    jsonb_build_object('enabled', rule_row.enabled)
  from public.automation_rules rule_row
  where rule_row.organization_id = target_organization_id;
  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'ALERT_RULE', rule_row.id,
    jsonb_build_object('enabled', rule_row.enabled)
  from public.alert_rules rule_row
  where rule_row.organization_id = target_organization_id;
  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'TENANT_INSTALLATION', installation_row.id,
    jsonb_build_object('status', installation_row.status)
  from public.tenant_installations installation_row
  where installation_row.organization_id = target_organization_id;
  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'DOMAIN_OUTBOX', outbox_row.id,
    jsonb_build_object(
      'next_attempt_at', outbox_row.next_attempt_at,
      'last_error_code', outbox_row.last_error_code
    )
  from public.domain_outbox outbox_row
  where outbox_row.organization_id = target_organization_id
    and outbox_row.published_at is null
    and outbox_row.dead_lettered_at is null;
  insert into public.retention_suspensions (
    organization_id, deletion_request_id, resource_type, resource_id, prior_state
  )
  select target_organization_id, request_row.id, 'PROVIDER_EVENT', event_row.id,
    jsonb_build_object(
      'status', event_row.status,
      'next_attempt_at', event_row.next_attempt_at,
      'safe_error_code', event_row.safe_error_code
    )
  from public.provider_events event_row
  where event_row.organization_id = target_organization_id
    and event_row.status in ('RECEIVED', 'RETRY', 'PROCESSING');

  update public.profiles
  set active = false, updated_at = now()
  where organization_id = target_organization_id and active;
  update public.connected_accounts
  set status = 'DISABLED', deleted_at = coalesce(deleted_at, now()), updated_at = now()
  where organization_id = target_organization_id;
  update public.automation_rules
  set enabled = false, updated_at = now()
  where organization_id = target_organization_id and enabled;
  update public.alert_rules
  set enabled = false
  where organization_id = target_organization_id and enabled;
  update public.tenant_installations
  set status = 'DISABLED'
  where organization_id = target_organization_id and status <> 'DISABLED';
  update public.domain_outbox
  set dead_lettered_at = now(),
      locked_at = null,
      locked_by = null,
      last_error_code = 'TENANT_SOFT_DELETED'
  where organization_id = target_organization_id
    and published_at is null
    and dead_lettered_at is null;
  update public.provider_events
  set status = 'TENANT_SUSPENDED',
      safe_error_code = 'TENANT_SOFT_DELETED',
      processing_started_at = null,
      processing_worker_id = null,
      next_attempt_at = null
  where organization_id = target_organization_id
    and status in ('RECEIVED', 'RETRY', 'PROCESSING');
  update public.live_tracking_sessions
  set ended_at = now()
  where organization_id = target_organization_id and ended_at is null;

  update public.organizations
  set status = 'SOFT_DELETED',
      deleted_at = now(),
      deleted_by = auth.uid(),
      deletion_reason = normalized_reason,
      purge_after = target_purge_after,
      updated_at = now()
  where id = target_organization_id;
  insert into public.tenant_status_history (
    organization_id, from_status, to_status, changed_by, reason
  ) values (
    target_organization_id, organization_row.status, 'SOFT_DELETED', auth.uid(),
    'Controlled retention request ' || request_row.id::text
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    target_organization_id, auth.uid(), 'retention.soft_deleted', 'organization',
    target_organization_id::text,
    jsonb_build_object(
      'deletion_request_id', request_row.id,
      'purge_after', target_purge_after,
      'reason_hash', app_private.sha256_hex(normalized_reason)
    )
  );
  return request_row;
end;
$$;

create or replace function public.review_tenant_deletion(
  target_deletion_request_id uuid,
  target_decision text,
  decision_reason text
)
returns public.deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.deletion_requests%rowtype;
declare normalized_reason text := btrim(coalesce(decision_reason, ''));
declare normalized_reason_hash text;
begin
  perform app_private.require_platform_retention_actor();
  if target_decision not in ('APPROVE', 'REJECT')
    or char_length(normalized_reason) not between 10 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_DELETION_REVIEW';
  end if;
  normalized_reason_hash := app_private.sha256_hex(normalized_reason);
  select * into request_row
  from public.deletion_requests
  where id = target_deletion_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELETION_REQUEST_NOT_FOUND';
  end if;
  if request_row.status = (
      case when target_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end
    )
    and request_row.approved_by = auth.uid()
    and request_row.decision_reason_hash = normalized_reason_hash
  then
    return request_row;
  end if;
  if request_row.status not in ('PENDING', 'PENDING_APPROVAL') then
    raise exception using errcode = '23514', message = 'DELETION_REQUEST_NOT_REVIEWABLE';
  end if;
  if request_row.requested_by = auth.uid() then
    raise exception using errcode = '42501', message = 'DISTINCT_RETENTION_APPROVER_REQUIRED';
  end if;

  update public.deletion_requests
  set approved_by = auth.uid(),
      approved_at = now(),
      decision_reason_hash = normalized_reason_hash,
      updated_at = now()
  where id = request_row.id
  returning * into request_row;

  if target_decision = 'REJECT' then
    return app_private.restore_tenant_from_retention_snapshot(
      request_row.id, auth.uid(), 'REJECTED', normalized_reason
    );
  end if;
  update public.deletion_requests
  set status = 'APPROVED', updated_at = now()
  where id = request_row.id
  returning * into request_row;
  insert into public.purge_jobs (
    organization_id, deletion_request_id, status, next_attempt_at
  ) values (
    request_row.organization_id, request_row.id, 'QUEUED', request_row.purge_after
  ) on conflict (deletion_request_id) where status <> 'CANCELLED'
    do update set status = 'QUEUED',
      next_attempt_at = excluded.next_attempt_at,
      updated_at = now();
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id, auth.uid(), 'retention.deletion_approved',
    'organization', request_row.organization_id::text,
    jsonb_build_object(
      'deletion_request_id', request_row.id,
      'purge_after', request_row.purge_after,
      'reason_hash', normalized_reason_hash
    )
  );
  return request_row;
end;
$$;

create or replace function public.restore_soft_deleted_tenant(
  target_deletion_request_id uuid,
  restore_reason text
)
returns public.deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.deletion_requests%rowtype;
begin
  perform app_private.require_platform_retention_actor();
  select * into request_row
  from public.deletion_requests
  where id = target_deletion_request_id;
  if request_row.status = 'RESTORED' and request_row.restored_by = auth.uid() then
    return request_row;
  end if;
  return app_private.restore_tenant_from_retention_snapshot(
    target_deletion_request_id, auth.uid(), 'RESTORED', restore_reason
  );
end;
$$;

create or replace function public.set_tenant_deletion_legal_hold(
  target_deletion_request_id uuid,
  hold_enabled boolean,
  hold_reason text
)
returns public.deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.deletion_requests%rowtype;
declare normalized_reason text := btrim(coalesce(hold_reason, ''));
begin
  perform app_private.require_platform_retention_actor();
  if hold_enabled is null or char_length(normalized_reason) not between 10 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_LEGAL_HOLD';
  end if;
  select * into request_row
  from public.deletion_requests
  where id = target_deletion_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELETION_REQUEST_NOT_FOUND';
  end if;
  if request_row.status not in (
    'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED'
  ) then
    raise exception using errcode = '23514', message = 'LEGAL_HOLD_STATE_LOCKED';
  end if;
  if request_row.legal_hold = hold_enabled then
    return request_row;
  end if;
  update public.deletion_requests
  set legal_hold = hold_enabled,
      legal_hold_reason = case when hold_enabled then normalized_reason else null end,
      legal_hold_by = case when hold_enabled then auth.uid() else null end,
      legal_hold_at = case when hold_enabled then now() else null end,
      updated_at = now()
  where id = request_row.id
  returning * into request_row;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id, auth.uid(),
    case when hold_enabled then 'retention.legal_hold_applied' else 'retention.legal_hold_released' end,
    'deletion_request', request_row.id::text,
    jsonb_build_object('reason_hash', app_private.sha256_hex(normalized_reason))
  );
  return request_row;
end;
$$;

create or replace function public.extend_tenant_retention(
  target_deletion_request_id uuid,
  target_purge_after timestamptz,
  extension_reason text
)
returns public.deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.deletion_requests%rowtype;
declare normalized_reason text := btrim(coalesce(extension_reason, ''));
begin
  perform app_private.require_platform_retention_actor();
  if target_purge_after is null
    or target_purge_after > now() + interval '10 years'
    or char_length(normalized_reason) not between 10 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_RETENTION_EXTENSION';
  end if;
  select * into request_row
  from public.deletion_requests
  where id = target_deletion_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELETION_REQUEST_NOT_FOUND';
  end if;
  if request_row.status in ('PENDING', 'PENDING_APPROVAL', 'APPROVED')
    and target_purge_after = request_row.purge_after
  then
    return request_row;
  end if;
  if request_row.status not in ('PENDING', 'PENDING_APPROVAL', 'APPROVED')
    or target_purge_after <= request_row.purge_after
  then
    raise exception using errcode = '23514', message = 'RETENTION_CAN_ONLY_BE_EXTENDED';
  end if;
  update public.deletion_requests
  set purge_after = target_purge_after, updated_at = now()
  where id = request_row.id
  returning * into request_row;
  update public.organizations
  set purge_after = target_purge_after, updated_at = now()
  where id = request_row.organization_id and status = 'SOFT_DELETED';
  update public.purge_jobs
  set next_attempt_at = target_purge_after, updated_at = now()
  where deletion_request_id = request_row.id and status in ('QUEUED', 'RETRY');
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id, auth.uid(), 'retention.extended',
    'deletion_request', request_row.id::text,
    jsonb_build_object(
      'purge_after', target_purge_after,
      'reason_hash', app_private.sha256_hex(normalized_reason)
    )
  );
  return request_row;
end;
$$;

create or replace function public.requeue_failed_tenant_purge(
  target_deletion_request_id uuid,
  requeue_reason text
)
returns public.purge_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.deletion_requests%rowtype;
declare job_row public.purge_jobs%rowtype;
declare normalized_reason text := btrim(coalesce(requeue_reason, ''));
begin
  perform app_private.require_platform_retention_actor();
  if char_length(normalized_reason) not between 10 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_REQUEUE_REASON';
  end if;
  select * into request_row
  from public.deletion_requests
  where id = target_deletion_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELETION_REQUEST_NOT_FOUND';
  end if;
  if request_row.status = 'APPROVED' then
    select * into job_row
    from public.purge_jobs
    where deletion_request_id = request_row.id
      and status in ('QUEUED', 'RETRY')
      and manual_requeues > 0;
    if found then return job_row; end if;
  end if;
  if request_row.status <> 'FAILED'
    or request_row.legal_hold
    or request_row.purge_after > now()
    or not exists (
      select 1 from public.organizations organization_row
      where organization_row.id = request_row.organization_id
        and organization_row.status = 'SOFT_DELETED'
        and organization_row.deleted_at is not null
    )
  then
    raise exception using errcode = '23514', message = 'PURGE_NOT_REQUEUEABLE';
  end if;
  update public.deletion_requests
  set status = 'APPROVED', failure_safe_code = null, updated_at = now()
  where id = request_row.id;
  update public.purge_jobs
  set status = 'RETRY', attempts = 0, manual_requeues = manual_requeues + 1,
      lease_token = null, worker_id = null, leased_until = null,
      next_attempt_at = now(), last_error_code = null, updated_at = now()
  where deletion_request_id = request_row.id
  returning * into job_row;
  if not found then
    raise exception using errcode = 'P0002', message = 'PURGE_JOB_NOT_FOUND';
  end if;
  update public.purge_manifests
  set status = 'RETRY'
  where deletion_request_id = request_row.id and status = 'FAILED';
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id, auth.uid(), 'retention.purge_requeued',
    'deletion_request', request_row.id::text,
    jsonb_build_object('reason_hash', app_private.sha256_hex(normalized_reason))
  );
  return job_row;
end;
$$;

create or replace function public.claim_controlled_purges(
  target_worker_id text,
  target_batch_size integer default 5
)
returns table (
  job_id uuid,
  deletion_request_id uuid,
  organization_id uuid,
  manifest_id uuid,
  lease_token uuid,
  attempt_number integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare claimed_job public.purge_jobs%rowtype;
declare request_row public.deletion_requests%rowtype;
declare current_manifest_id uuid;
declare current_lease_token uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(btrim(target_worker_id), '') is null
    or char_length(target_worker_id) > 200
    or target_batch_size not between 1 and 20
  then
    raise exception using errcode = '22023', message = 'INVALID_PURGE_CLAIM';
  end if;

  update public.purge_jobs job_row
  set status = 'RETRY', lease_token = null, worker_id = null, leased_until = null,
      next_attempt_at = now(), last_error_code = 'PURGE_LEASE_EXPIRED', updated_at = now()
  where job_row.status = 'PROCESSING'
    and (job_row.leased_until is null or job_row.leased_until < now())
    and job_row.attempts < 12;
  update public.deletion_requests request_row_update
  set status = 'APPROVED', failure_safe_code = 'PURGE_LEASE_EXPIRED', updated_at = now()
  where request_row_update.status = 'PURGING'
    and exists (
      select 1 from public.purge_jobs job_row
      where job_row.deletion_request_id = request_row_update.id
        and job_row.status = 'RETRY'
        and job_row.last_error_code = 'PURGE_LEASE_EXPIRED'
    );
  update public.purge_manifests manifest_row
  set status = 'RETRY'
  where manifest_row.status = 'PROCESSING'
    and exists (
      select 1 from public.purge_jobs job_row
      where job_row.deletion_request_id = manifest_row.deletion_request_id
        and job_row.status = 'RETRY'
        and job_row.last_error_code = 'PURGE_LEASE_EXPIRED'
    );
  update public.purge_jobs job_row
  set status = 'FAILED', lease_token = null, worker_id = null, leased_until = null,
      last_error_code = 'PURGE_RETRY_EXHAUSTED', last_error_at = now(), updated_at = now()
  where job_row.status = 'PROCESSING'
    and (job_row.leased_until is null or job_row.leased_until < now())
    and job_row.attempts >= 12;
  update public.deletion_requests request_row_update
  set status = 'FAILED', failure_safe_code = 'PURGE_RETRY_EXHAUSTED', updated_at = now()
  where request_row_update.status = 'PURGING'
    and exists (
      select 1 from public.purge_jobs job_row
      where job_row.deletion_request_id = request_row_update.id
        and job_row.status = 'FAILED'
        and job_row.last_error_code = 'PURGE_RETRY_EXHAUSTED'
    );
  update public.purge_manifests manifest_row
  set status = 'FAILED'
  where manifest_row.status <> 'COMPLETED'
    and exists (
      select 1 from public.purge_jobs job_row
      where job_row.deletion_request_id = manifest_row.deletion_request_id
        and job_row.status = 'FAILED'
        and job_row.last_error_code = 'PURGE_RETRY_EXHAUSTED'
    );

  for claimed_job in
    select job_row.*
    from public.purge_jobs job_row
    join public.deletion_requests request_candidate
      on request_candidate.id = job_row.deletion_request_id
     and request_candidate.organization_id = job_row.organization_id
    join public.organizations organization_row
      on organization_row.id = job_row.organization_id
    where job_row.status in ('QUEUED', 'RETRY')
      and job_row.next_attempt_at <= now()
      and job_row.attempts < 12
      and request_candidate.status = 'APPROVED'
      and request_candidate.resource_type = 'ORGANIZATION'
      and request_candidate.resource_id = request_candidate.organization_id
      and request_candidate.purge_after is not null
      and request_candidate.purge_after <= now()
      and not request_candidate.legal_hold
      and organization_row.status = 'SOFT_DELETED'
      and organization_row.deleted_at is not null
      and organization_row.purge_after = request_candidate.purge_after
    order by request_candidate.purge_after, job_row.id
    for update of job_row, request_candidate skip locked
    limit target_batch_size
  loop
    select * into request_row
    from public.deletion_requests
    where id = claimed_job.deletion_request_id
    for update;
    current_lease_token := gen_random_uuid();
    update public.purge_jobs
    set status = 'PROCESSING', attempts = attempts + 1,
        started_at = coalesce(started_at, now()), lease_token = current_lease_token,
        worker_id = target_worker_id, leased_until = now() + interval '10 minutes',
        last_error_code = null, updated_at = now()
    where id = claimed_job.id;
    update public.deletion_requests
    set status = 'PURGING', purge_started_at = coalesce(purge_started_at, now()),
        failure_safe_code = null, updated_at = now()
    where id = request_row.id;

    insert into public.purge_manifests (
      organization_id, deletion_request_id, resource_type, resource_id, status
    ) values (
      request_row.organization_id, request_row.id, 'ORGANIZATION',
      request_row.organization_id, 'PREPARED'
    ) on conflict on constraint purge_manifests_deletion_request_id_key do nothing;
    select manifest_row.id into current_manifest_id
    from public.purge_manifests manifest_row
    where manifest_row.deletion_request_id = request_row.id;

    insert into public.purge_manifest_objects (
      organization_id, manifest_id, source_type, source_id, object_file_id,
      bucket, object_key, object_locator_hash
    )
    select request_row.organization_id, current_manifest_id, 'OBJECT_FILE', file_row.id,
      file_row.id, file_row.bucket, file_row.object_key,
      app_private.sha256_hex(
        char_length(file_row.bucket)::text || ':' || file_row.bucket || file_row.object_key
      )
    from public.object_files file_row
    where file_row.organization_id = request_row.organization_id
    on conflict on constraint purge_manifest_objects_manifest_id_source_type_source_id_key
      do nothing;
    insert into public.purge_manifest_objects (
      organization_id, manifest_id, source_type, source_id, object_file_id,
      bucket, object_key, object_locator_hash
    )
    select request_row.organization_id, current_manifest_id, 'UPLOAD_INTENT', intent_row.id,
      null, intent_row.bucket, intent_row.object_key,
      app_private.sha256_hex(
        char_length(intent_row.bucket)::text || ':' || intent_row.bucket || intent_row.object_key
      )
    from public.object_upload_intents intent_row
    where intent_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.object_files file_row
        where file_row.organization_id = intent_row.organization_id
          and file_row.bucket = intent_row.bucket
          and file_row.object_key = intent_row.object_key
      )
    on conflict on constraint purge_manifest_objects_manifest_id_source_type_source_id_key
      do nothing;
    insert into public.purge_manifest_auth_identities (
      organization_id, manifest_id, user_id
    )
    select request_row.organization_id, current_manifest_id, profile_row.id
    from public.profiles profile_row
    where profile_row.organization_id = request_row.organization_id
    on conflict on constraint purge_manifest_auth_identities_manifest_id_user_id_key
      do nothing;

    update public.purge_manifests manifest_row
    set status = 'PROCESSING',
        planned_object_count = (
          select count(*) from public.purge_manifest_objects object_row
          where object_row.manifest_id = manifest_row.id
        ),
        deleted_object_count = (
          select count(*) from public.purge_manifest_objects object_row
          where object_row.manifest_id = manifest_row.id and object_row.status = 'DELETED'
        ),
        planned_auth_identity_count = (
          select count(*) from public.purge_manifest_auth_identities auth_row
          where auth_row.manifest_id = manifest_row.id
        ),
        deleted_auth_identity_count = (
          select count(*) from public.purge_manifest_auth_identities auth_row
          where auth_row.manifest_id = manifest_row.id and auth_row.status <> 'PENDING'
        ),
        planned_external_connection_count = (
          select count(*) from public.connected_accounts account_row
          where account_row.organization_id = request_row.organization_id
        )
    where manifest_row.id = current_manifest_id;
    insert into public.audit_logs (
      organization_id, action, resource_type, resource_id, metadata
    ) values (
      request_row.organization_id, 'retention.purge_claimed', 'deletion_request',
      request_row.id::text,
      jsonb_build_object(
        'purge_job_id', claimed_job.id,
        'manifest_id', current_manifest_id,
        'attempt', claimed_job.attempts + 1
      )
    );

    job_id := claimed_job.id;
    deletion_request_id := request_row.id;
    organization_id := request_row.organization_id;
    manifest_id := current_manifest_id;
    lease_token := current_lease_token;
    attempt_number := claimed_job.attempts + 1;
    return next;
  end loop;
end;
$$;

create or replace function public.renew_controlled_purge_lease(
  target_job_id uuid,
  target_worker_id text,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.purge_jobs
  set leased_until = now() + interval '10 minutes', updated_at = now()
  where id = target_job_id and status = 'PROCESSING'
    and worker_id = target_worker_id and lease_token = target_lease_token
    and leased_until > now()
    and exists (
      select 1 from public.deletion_requests request_row
      where request_row.id = public.purge_jobs.deletion_request_id
        and request_row.status = 'PURGING'
        and not request_row.legal_hold
    );
  return found;
end;
$$;

create or replace function public.mark_purge_object_deleted(
  target_job_id uuid,
  target_worker_id text,
  target_lease_token uuid,
  target_manifest_object_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare object_row public.purge_manifest_objects%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.purge_jobs job_row
    join public.purge_manifests manifest_row
      on manifest_row.deletion_request_id = job_row.deletion_request_id
    join public.deletion_requests request_row
      on request_row.id = job_row.deletion_request_id
    where job_row.id = target_job_id and job_row.status = 'PROCESSING'
      and job_row.worker_id = target_worker_id
      and job_row.lease_token = target_lease_token
      and job_row.leased_until > now()
      and request_row.status = 'PURGING'
      and not request_row.legal_hold
      and manifest_row.id = (
        select item_row.manifest_id from public.purge_manifest_objects item_row
        where item_row.id = target_manifest_object_id
      )
  ) then
    raise exception using errcode = '42501', message = 'PURGE_LEASE_INVALID';
  end if;
  select * into object_row
  from public.purge_manifest_objects
  where id = target_manifest_object_id
  for update;
  if object_row.status = 'DELETED' then return true; end if;
  update public.purge_manifest_objects
  set status = 'DELETED', attempts = attempts + 1, last_error_code = null,
      storage_deleted_at = now(), bucket = null, object_key = null
  where id = object_row.id;
  if object_row.object_file_id is not null then
    update public.object_files
    set deleted_at = coalesce(deleted_at, now())
    where id = object_row.object_file_id
      and organization_id = object_row.organization_id;
  end if;
  update public.purge_manifests manifest_row
  set deleted_object_count = (
    select count(*) from public.purge_manifest_objects item_row
    where item_row.manifest_id = manifest_row.id and item_row.status = 'DELETED'
  )
  where manifest_row.id = object_row.manifest_id;
  return true;
end;
$$;

create or replace function public.mark_purge_auth_identity_deleted(
  target_job_id uuid,
  target_worker_id text,
  target_lease_token uuid,
  target_manifest_auth_id uuid,
  target_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare auth_row public.purge_manifest_auth_identities%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_status not in ('SOFT_DELETED', 'NOT_FOUND') then
    raise exception using errcode = '22023', message = 'INVALID_AUTH_PURGE_STATUS';
  end if;
  if not exists (
    select 1 from public.purge_jobs job_row
    join public.purge_manifests manifest_row
      on manifest_row.deletion_request_id = job_row.deletion_request_id
    join public.deletion_requests request_row
      on request_row.id = job_row.deletion_request_id
    where job_row.id = target_job_id and job_row.status = 'PROCESSING'
      and job_row.worker_id = target_worker_id
      and job_row.lease_token = target_lease_token
      and job_row.leased_until > now()
      and request_row.status = 'PURGING'
      and not request_row.legal_hold
      and manifest_row.id = (
        select item_row.manifest_id from public.purge_manifest_auth_identities item_row
        where item_row.id = target_manifest_auth_id
      )
  ) then
    raise exception using errcode = '42501', message = 'PURGE_LEASE_INVALID';
  end if;
  select * into auth_row
  from public.purge_manifest_auth_identities
  where id = target_manifest_auth_id
  for update;
  if auth_row.status <> 'PENDING' then return true; end if;
  update public.purge_manifest_auth_identities
  set status = target_status, attempts = attempts + 1,
      last_error_code = null, auth_deleted_at = now()
  where id = auth_row.id;
  update public.purge_manifests manifest_row
  set deleted_auth_identity_count = (
    select count(*) from public.purge_manifest_auth_identities item_row
    where item_row.manifest_id = manifest_row.id and item_row.status <> 'PENDING'
  )
  where manifest_row.id = auth_row.manifest_id;
  return true;
end;
$$;

create or replace function public.retry_controlled_purge(
  target_job_id uuid,
  target_worker_id text,
  target_lease_token uuid,
  target_safe_error_code text,
  target_phase text,
  target_item_id uuid default null,
  target_delay_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.purge_jobs%rowtype;
declare manifest_row public.purge_manifests%rowtype;
declare terminal_failure boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_phase not in ('STORAGE', 'AUTH', 'DATA', 'FINALIZE')
    or target_safe_error_code is null
    or target_safe_error_code !~ '^[A-Z0-9_]{3,120}$'
    or target_delay_seconds not between 60 and 86400
  then
    raise exception using errcode = '22023', message = 'INVALID_PURGE_RETRY';
  end if;
  select * into job_row
  from public.purge_jobs
  where id = target_job_id and status = 'PROCESSING'
    and worker_id = target_worker_id and lease_token = target_lease_token
  for update;
  if not found then return false; end if;
  select * into manifest_row
  from public.purge_manifests
  where deletion_request_id = job_row.deletion_request_id
  for update;
  if target_phase = 'STORAGE' and target_item_id is not null then
    update public.purge_manifest_objects
    set attempts = least(attempts + 1, 100), last_error_code = target_safe_error_code
    where id = target_item_id and manifest_id = manifest_row.id and status = 'PENDING';
  elsif target_phase = 'AUTH' and target_item_id is not null then
    update public.purge_manifest_auth_identities
    set attempts = least(attempts + 1, 100), last_error_code = target_safe_error_code
    where id = target_item_id and manifest_id = manifest_row.id and status = 'PENDING';
  end if;
  terminal_failure := job_row.attempts >= 12;
  update public.purge_jobs
  set status = case when terminal_failure then 'FAILED' else 'RETRY' end,
      lease_token = null, worker_id = null, leased_until = null,
      next_attempt_at = case when terminal_failure then next_attempt_at
        else now() + make_interval(secs => target_delay_seconds)
      end,
      last_error_code = target_safe_error_code, last_error_at = now(), updated_at = now()
  where id = job_row.id;
  update public.deletion_requests
  set status = case when terminal_failure then 'FAILED' else 'APPROVED' end,
      failure_safe_code = target_safe_error_code, updated_at = now()
  where id = job_row.deletion_request_id;
  update public.purge_manifests
  set status = case when terminal_failure then 'FAILED' else 'RETRY' end
  where id = manifest_row.id;
  insert into public.audit_logs (
    organization_id, action, resource_type, resource_id, metadata
  ) values (
    job_row.organization_id, 'retention.purge_retry_scheduled', 'deletion_request',
    job_row.deletion_request_id::text,
    jsonb_build_object(
      'purge_job_id', job_row.id,
      'phase', target_phase,
      'safe_error_code', target_safe_error_code,
      'attempt', job_row.attempts,
      'terminal', terminal_failure
    )
  );
  return true;
end;
$$;

create or replace function public.purge_tenant_data_batch(
  target_job_id uuid,
  target_worker_id text,
  target_lease_token uuid,
  target_batch_size integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.purge_jobs%rowtype;
declare manifest_row public.purge_manifests%rowtype;
declare request_row public.deletion_requests%rowtype;
declare allowlist_row app_private.retention_table_allowlist%rowtype;
declare deleted_count integer;
declare previous_count bigint;
declare unknown_table text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_batch_size not between 100 and 10000 then
    raise exception using errcode = '22023', message = 'INVALID_PURGE_BATCH_SIZE';
  end if;
  select * into job_row
  from public.purge_jobs
  where id = target_job_id and status = 'PROCESSING'
    and worker_id = target_worker_id and lease_token = target_lease_token
    and leased_until > now()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PURGE_LEASE_INVALID';
  end if;
  select * into request_row
  from public.deletion_requests
  where id = job_row.deletion_request_id and status = 'PURGING'
    and not legal_hold and purge_after <= now()
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'PURGE_NOT_ELIGIBLE';
  end if;
  select * into manifest_row
  from public.purge_manifests
  where deletion_request_id = request_row.id
  for update;

  if exists (
    select 1 from public.purge_manifest_objects object_row
    where object_row.manifest_id = manifest_row.id and object_row.status <> 'DELETED'
  ) then
    raise exception using errcode = '23514', message = 'OBJECT_PURGE_INCOMPLETE';
  end if;
  if exists (
    select 1 from public.purge_manifest_auth_identities auth_row
    where auth_row.manifest_id = manifest_row.id and auth_row.status = 'PENDING'
  ) then
    raise exception using errcode = '23514', message = 'AUTH_PURGE_INCOMPLETE';
  end if;
  if exists (
    select 1 from public.object_files file_row
    where file_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.purge_manifest_objects object_row
        where object_row.manifest_id = manifest_row.id
          and object_row.source_type = 'OBJECT_FILE'
          and object_row.source_id = file_row.id
      )
  ) or exists (
    select 1 from public.object_upload_intents intent_row
    where intent_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.object_files file_row
        where file_row.organization_id = intent_row.organization_id
          and file_row.bucket = intent_row.bucket
          and file_row.object_key = intent_row.object_key
      )
      and not exists (
        select 1 from public.purge_manifest_objects object_row
        where object_row.manifest_id = manifest_row.id
          and object_row.source_type = 'UPLOAD_INTENT'
          and object_row.source_id = intent_row.id
      )
  ) or exists (
    select 1 from public.profiles profile_row
    where profile_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.purge_manifest_auth_identities auth_row
        where auth_row.manifest_id = manifest_row.id
          and auth_row.user_id = profile_row.id
      )
  ) then
    raise exception using errcode = '23514', message = 'PURGE_INVENTORY_CHANGED';
  end if;

  select column_row.table_name into unknown_table
  from information_schema.columns column_row
  join information_schema.tables table_row
    on table_row.table_schema = column_row.table_schema
   and table_row.table_name = column_row.table_name
   and table_row.table_type = 'BASE TABLE'
  left join app_private.retention_table_allowlist allowlist_candidate
    on allowlist_candidate.table_name::text = column_row.table_name
  where column_row.table_schema = 'public'
    and column_row.column_name = 'organization_id'
    and allowlist_candidate.table_name is null
  order by column_row.table_name
  limit 1;
  if unknown_table is not null then
    raise exception using errcode = '55000',
      message = 'PURGE_SCHEMA_ALLOWLIST_STALE',
      detail = unknown_table;
  end if;

  if manifest_row.data_current_table is not null then
    select * into allowlist_row
    from app_private.retention_table_allowlist
    where table_name::text = manifest_row.data_current_table
      and disposition = 'DELETE';
  else
    select * into allowlist_row
    from app_private.retention_table_allowlist
    where disposition = 'DELETE'
      and delete_order > manifest_row.data_last_completed_order
    order by delete_order
    limit 1;
  end if;
  if allowlist_row.table_name is null then
    update public.purge_jobs
    set leased_until = now() + interval '10 minutes', updated_at = now()
    where id = job_row.id;
    return jsonb_build_object('done', true, 'table', null, 'deleted_rows', 0);
  end if;

  execute format(
    'with victims as (
       select ctid from public.%I
       where organization_id = $1
       limit $2
       for update skip locked
     )
     delete from public.%I target_row
     using victims
     where target_row.ctid = victims.ctid',
    allowlist_row.table_name, allowlist_row.table_name
  ) using request_row.organization_id, target_batch_size;
  get diagnostics deleted_count = row_count;
  previous_count := coalesce(
    (manifest_row.deleted_row_counts ->> allowlist_row.table_name::text)::bigint,
    0
  );
  update public.purge_manifests
  set data_current_table = case when deleted_count < target_batch_size
        then null else allowlist_row.table_name::text end,
      data_last_completed_order = case when deleted_count < target_batch_size
        then allowlist_row.delete_order else data_last_completed_order end,
      deleted_row_counts = jsonb_set(
        deleted_row_counts,
        array[allowlist_row.table_name::text],
        to_jsonb(previous_count + deleted_count),
        true
      ),
      status = 'PROCESSING'
  where id = manifest_row.id;
  update public.purge_jobs
  set leased_until = now() + interval '10 minutes', updated_at = now()
  where id = job_row.id;
  return jsonb_build_object(
    'done', false,
    'table', allowlist_row.table_name::text,
    'table_complete', deleted_count < target_batch_size,
    'deleted_rows', deleted_count
  );
end;
$$;

create or replace function public.finalize_controlled_tenant_purge(
  target_job_id uuid,
  target_worker_id text,
  target_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare job_row public.purge_jobs%rowtype;
declare request_row public.deletion_requests%rowtype;
declare manifest_row public.purge_manifests%rowtype;
declare allowlist_row app_private.retention_table_allowlist%rowtype;
declare residual_count bigint;
declare unknown_table text;
declare reason_digest text;
declare final_digest text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into job_row
  from public.purge_jobs
  where id = target_job_id and status = 'PROCESSING'
    and worker_id = target_worker_id and lease_token = target_lease_token
    and leased_until > now()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PURGE_LEASE_INVALID';
  end if;
  select * into request_row
  from public.deletion_requests
  where id = job_row.deletion_request_id and status = 'PURGING'
    and not legal_hold and purge_after <= now()
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'PURGE_NOT_ELIGIBLE';
  end if;
  select * into manifest_row
  from public.purge_manifests
  where deletion_request_id = request_row.id
  for update;
  if manifest_row.data_current_table is not null
    or exists (
      select 1 from app_private.retention_table_allowlist allowlist_candidate
      where allowlist_candidate.disposition = 'DELETE'
        and allowlist_candidate.delete_order > manifest_row.data_last_completed_order
    )
    or exists (
      select 1 from public.purge_manifest_objects object_row
      where object_row.manifest_id = manifest_row.id and object_row.status <> 'DELETED'
    )
    or exists (
      select 1 from public.purge_manifest_auth_identities auth_row
      where auth_row.manifest_id = manifest_row.id and auth_row.status = 'PENDING'
    )
  then
    raise exception using errcode = '23514', message = 'PURGE_PHASES_INCOMPLETE';
  end if;
  if exists (
    select 1 from public.object_files file_row
    where file_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.purge_manifest_objects object_row
        where object_row.manifest_id = manifest_row.id
          and object_row.source_type = 'OBJECT_FILE'
          and object_row.source_id = file_row.id
      )
  ) or exists (
    select 1 from public.object_upload_intents intent_row
    where intent_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.object_files file_row
        where file_row.organization_id = intent_row.organization_id
          and file_row.bucket = intent_row.bucket
          and file_row.object_key = intent_row.object_key
      )
      and not exists (
        select 1 from public.purge_manifest_objects object_row
        where object_row.manifest_id = manifest_row.id
          and object_row.source_type = 'UPLOAD_INTENT'
          and object_row.source_id = intent_row.id
      )
  ) or exists (
    select 1 from public.profiles profile_row
    where profile_row.organization_id = request_row.organization_id
      and not exists (
        select 1 from public.purge_manifest_auth_identities auth_row
        where auth_row.manifest_id = manifest_row.id
          and auth_row.user_id = profile_row.id
      )
  ) then
    raise exception using errcode = '23514', message = 'PURGE_INVENTORY_CHANGED';
  end if;
  select column_row.table_name into unknown_table
  from information_schema.columns column_row
  join information_schema.tables table_row
    on table_row.table_schema = column_row.table_schema
   and table_row.table_name = column_row.table_name
   and table_row.table_type = 'BASE TABLE'
  left join app_private.retention_table_allowlist allowlist_candidate
    on allowlist_candidate.table_name::text = column_row.table_name
  where column_row.table_schema = 'public'
    and column_row.column_name = 'organization_id'
    and allowlist_candidate.table_name is null
  order by column_row.table_name
  limit 1;
  if unknown_table is not null then
    raise exception using errcode = '55000',
      message = 'PURGE_SCHEMA_ALLOWLIST_STALE',
      detail = unknown_table;
  end if;
  for allowlist_row in
    select * from app_private.retention_table_allowlist
    where disposition = 'DELETE'
    order by delete_order
  loop
    execute format(
      'select count(*) from public.%I where organization_id = $1',
      allowlist_row.table_name
    ) into residual_count using request_row.organization_id;
    if residual_count <> 0 then
      raise exception using errcode = '55000',
        message = 'PURGE_RESIDUAL_DATA_FOUND',
        detail = allowlist_row.table_name::text;
    end if;
  end loop;

  perform set_config('app.controlled_retention_purge', 'on', true);
  update public.audit_logs
  set actor_id = null,
      branch_id = null,
      resource_id = null,
      request_id = null,
      metadata = jsonb_build_object('redacted_by_controlled_purge', true)
  where organization_id = request_row.organization_id;
  update public.credit_ledger
  set user_id = null,
      created_by = null,
      source = null,
      reference_id = 'purged:' || id::text,
      reason = 'Redacted by controlled tenant purge'
  where organization_id = request_row.organization_id;
  update public.tenant_status_history
  set changed_by = null,
      reason = 'Redacted by controlled tenant purge'
  where organization_id = request_row.organization_id;
  update public.profiles
  set full_name = 'Deleted user ' || left(id::text, 8),
      email = id::text || '@deleted.invalid',
      phone = null,
      normalized_phone = null,
      employee_id = null,
      active = false,
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
  where organization_id = request_row.organization_id;

  reason_digest := app_private.sha256_hex(request_row.reason);
  update public.organizations
  set name = 'Deleted tenant ' || left(id::text, 8),
      slug = 'purged-' || id::text,
      legal_name = null,
      gst_number = null,
      status = 'SOFT_DELETED',
      deletion_reason = 'Irreversibly purged; request ' || request_row.id::text,
      updated_at = now()
  where id = request_row.organization_id;
  update public.deletion_requests
  set status = 'PURGED',
      reason = '[redacted after controlled purge]',
      failure_safe_code = null,
      updated_at = now()
  where id = request_row.id;
  delete from public.retention_suspensions
  where deletion_request_id = request_row.id;

  final_digest := app_private.sha256_hex(
    manifest_row.id::text || '|' || request_row.id::text || '|' ||
    manifest_row.planned_object_count::text || '|' ||
    manifest_row.planned_auth_identity_count::text || '|' ||
    manifest_row.planned_external_connection_count::text || '|' ||
    manifest_row.deleted_row_counts::text || '|' || reason_digest
  );
  update public.purge_manifests
  set status = 'COMPLETED',
      deleted_object_count = planned_object_count,
      deleted_auth_identity_count = planned_auth_identity_count,
      final_checksum = final_digest,
      summary = jsonb_build_object(
        'disposition', 'DELETE_DEPENDENTS_AND_IRREVERSIBLY_ANONYMIZE_ROOT',
        'object_count', planned_object_count,
        'auth_identity_count', planned_auth_identity_count,
        'external_provider_connection_count', planned_external_connection_count,
        'external_provider_token_revocation', 'NOT_EXECUTED_REQUIRES_PROVIDER_ADAPTER',
        'purge_scope', 'CRM_LOCAL_TIGRIS_AND_SUPABASE_AUTH',
        'deleted_row_counts', deleted_row_counts,
        'reason_hash', reason_digest
      ),
      completed_at = now()
  where id = manifest_row.id;
  update public.purge_jobs
  set status = 'COMPLETED', completed_at = now(), lease_token = null,
      worker_id = null, leased_until = null, last_error_code = null, updated_at = now()
  where id = job_row.id;
  insert into public.audit_logs (
    organization_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id, 'retention.purge_completed', 'organization',
    request_row.organization_id::text,
    jsonb_build_object(
      'deletion_request_id', request_row.id,
      'purge_job_id', job_row.id,
      'manifest_id', manifest_row.id,
      'manifest_checksum', final_digest,
      'disposition', 'DELETE_DEPENDENTS_AND_IRREVERSIBLY_ANONYMIZE_ROOT',
      'external_provider_connection_count', manifest_row.planned_external_connection_count,
      'external_provider_token_revocation', 'NOT_EXECUTED_REQUIRES_PROVIDER_ADAPTER'
    )
  );
  return jsonb_build_object(
    'completed', true,
    'manifest_id', manifest_row.id,
    'manifest_checksum', final_digest
  );
end;
$$;

-- Disable the old completion shortcut. It did not delete tenant data, enforce a
-- lease or prove auth/object completion and must not remain callable.
create or replace function public.complete_controlled_purge(target_deletion_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '0A000', message = 'LEGACY_PURGE_ENTRYPOINT_DISABLED';
end;
$$;

revoke all on function app_private.require_platform_retention_actor()
  from public, anon, authenticated;
revoke all on function app_private.sha256_hex(text)
  from public, anon, authenticated, service_role;
revoke all on function app_private.restore_tenant_from_retention_snapshot(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.request_tenant_deletion(uuid, text, integer, uuid)
  from public, anon;
revoke all on function public.review_tenant_deletion(uuid, text, text)
  from public, anon;
revoke all on function public.restore_soft_deleted_tenant(uuid, text)
  from public, anon;
revoke all on function public.set_tenant_deletion_legal_hold(uuid, boolean, text)
  from public, anon;
revoke all on function public.extend_tenant_retention(uuid, timestamptz, text)
  from public, anon;
revoke all on function public.requeue_failed_tenant_purge(uuid, text)
  from public, anon;
grant execute on function public.request_tenant_deletion(uuid, text, integer, uuid)
  to authenticated;
grant execute on function public.review_tenant_deletion(uuid, text, text)
  to authenticated;
grant execute on function public.restore_soft_deleted_tenant(uuid, text)
  to authenticated;
grant execute on function public.set_tenant_deletion_legal_hold(uuid, boolean, text)
  to authenticated;
grant execute on function public.extend_tenant_retention(uuid, timestamptz, text)
  to authenticated;
grant execute on function public.requeue_failed_tenant_purge(uuid, text)
  to authenticated;

revoke all on function public.claim_controlled_purges(text, integer)
  from public, anon, authenticated;
revoke all on function public.renew_controlled_purge_lease(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.mark_purge_object_deleted(uuid, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.mark_purge_auth_identity_deleted(uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.retry_controlled_purge(uuid, text, uuid, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.purge_tenant_data_batch(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_controlled_tenant_purge(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_controlled_purge(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_controlled_purges(text, integer) to service_role;
grant execute on function public.renew_controlled_purge_lease(uuid, text, uuid) to service_role;
grant execute on function public.mark_purge_object_deleted(uuid, text, uuid, uuid) to service_role;
grant execute on function public.mark_purge_auth_identity_deleted(uuid, text, uuid, uuid, text)
  to service_role;
grant execute on function public.retry_controlled_purge(uuid, text, uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.purge_tenant_data_batch(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.finalize_controlled_tenant_purge(uuid, text, uuid)
  to service_role;

commit;
