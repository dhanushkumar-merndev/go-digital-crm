begin;

create table public.followups (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  lead_id uuid references public.leads(id), customer_id uuid references public.customers(id), assigned_user_id uuid not null references public.profiles(id), reason text not null,
  due_at timestamptz not null, status text not null default 'OPEN' check (status in ('OPEN','COMPLETED','CANCELLED','OVERDUE')), completed_at timestamptz, created_by uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.reminders (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), user_id uuid not null references public.profiles(id), resource_type text not null, resource_id uuid not null,
  remind_at timestamptz not null, delivered_at timestamptz, created_at timestamptz not null default now()
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid references public.branches(id), team_id uuid references public.teams(id),
  assigned_user_id uuid references public.profiles(id), resource_type text, resource_id uuid, title text not null, description text, priority text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  status text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED')), due_at timestamptz, created_by uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.appointments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  lead_id uuid references public.leads(id), customer_id uuid not null references public.customers(id), assigned_user_id uuid not null references public.profiles(id), appointment_type text not null,
  scheduled_at timestamptz not null, status text not null default 'SCHEDULED', attendance_status text, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.calls (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  lead_id uuid references public.leads(id), customer_id uuid references public.customers(id), assigned_user_id uuid not null references public.profiles(id), connection_id uuid,
  provider_call_id text, direction text not null check (direction in ('INBOUND','OUTBOUND')), call_source text not null check (call_source in ('PROVIDER','PERSONAL_MANUAL')),
  started_at timestamptz not null, ended_at timestamptz, duration_seconds integer, outcome text, status text not null default 'PENDING', created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, connection_id, provider_call_id)
);
create table public.call_recordings (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), call_id uuid not null references public.calls(id), object_file_id uuid,
  source text not null check (source in ('PROVIDER_SYNC','MANUAL_UPLOAD')), status text not null default 'PENDING', checksum text, created_at timestamptz not null default now()
);
create table public.call_transcripts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), call_id uuid not null references public.calls(id),
  transcript_text text, language text, provider_reference text, status text not null, created_at timestamptz not null default now()
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), lead_id uuid references public.leads(id), customer_id uuid not null references public.customers(id),
  channel text not null check (channel in ('WHATSAPP_BUSINESS','FACEBOOK_MESSENGER','INSTAGRAM_MESSAGING')), connection_id uuid not null, external_thread_id text, assigned_user_id uuid references public.profiles(id), status text not null default 'OPEN', created_at timestamptz not null default now()
);
create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), conversation_id uuid not null references public.conversations(id), provider_message_id text,
  direction text not null check (direction in ('INBOUND','OUTBOUND')), body text, delivery_status text, sent_by uuid references public.profiles(id), sent_at timestamptz not null, metadata jsonb not null default '{}'::jsonb,
  unique nulls not distinct (organization_id, conversation_id, provider_message_id)
);
create table public.ai_call_summaries (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), call_id uuid not null references public.calls(id), summary text not null,
  model_reference text, generated_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table public.ai_extraction_runs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), call_id uuid references public.calls(id), lead_id uuid references public.leads(id),
  status text not null, suggestions jsonb not null default '{}'::jsonb, credit_reference uuid, requested_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table public.ai_field_reviews (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), extraction_run_id uuid not null references public.ai_extraction_runs(id),
  field_key text not null, suggested_value jsonb, applied_value jsonb, decision text not null check (decision in ('PENDING','APPLIED','REJECTED','EDITED')), reviewed_by uuid references public.profiles(id), reviewed_at timestamptz
);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), ledger_kind public.credit_ledger_kind not null,
  transaction_type public.credit_transaction_type not null, amount bigint not null check (amount <> 0), feature text, user_id uuid references public.profiles(id), source text,
  reference_id text not null, reason text not null, created_by uuid references public.profiles(id), created_at timestamptz not null default now(),
  unique (organization_id, ledger_kind, reference_id)
);

create or replace function public.consume_credits(target_organization_id uuid, target_ledger public.credit_ledger_kind, requested_amount bigint, target_feature text, idempotency_key text, consumption_reason text)
returns table (ledger_id uuid, balance bigint) language plpgsql security definer set search_path = '' as $$
declare current_balance bigint; new_id uuid;
begin
  if requested_amount <= 0 then raise exception using errcode = '22023', message = 'INVALID_CREDIT_AMOUNT'; end if;
  if not app_private.has_permission(target_organization_id, 'credit.consume') then raise exception using errcode = '42501', message = 'PERMISSION_DENIED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_organization_id::text || ':' || target_ledger::text, 0));
  select coalesce(sum(amount), 0) into current_balance from public.credit_ledger where organization_id = target_organization_id and ledger_kind = target_ledger;
  if current_balance < requested_amount then raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS'; end if;
  insert into public.credit_ledger (organization_id, ledger_kind, transaction_type, amount, feature, user_id, reference_id, reason, created_by)
    values (target_organization_id, target_ledger, 'CONSUMPTION', -requested_amount, target_feature, auth.uid(), idempotency_key, consumption_reason, auth.uid())
    on conflict (organization_id, ledger_kind, reference_id) do update set reference_id = excluded.reference_id
    returning id into new_id;
  return query select new_id, (select coalesce(sum(cl.amount), 0) from public.credit_ledger cl where cl.organization_id = target_organization_id and cl.ledger_kind = target_ledger);
end;
$$;
revoke all on function public.consume_credits(uuid, public.credit_ledger_kind, bigint, text, text, text) from public, anon;
grant execute on function public.consume_credits(uuid, public.credit_ledger_kind, bigint, text, text, text) to authenticated;

create table public.test_drive_appointments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  customer_id uuid not null references public.customers(id), lead_id uuid references public.leads(id), assigned_user_id uuid not null references public.profiles(id), stock_unit_id uuid,
  scheduled_at timestamptz not null, status text not null default 'SCHEDULED', destination jsonb, created_at timestamptz not null default now()
);
create table public.test_drives (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  appointment_id uuid references public.test_drive_appointments(id), customer_id uuid not null references public.customers(id), lead_id uuid references public.leads(id), assigned_user_id uuid not null references public.profiles(id),
  status text not null default 'READY', started_at timestamptz, reached_at timestamptz, completed_at timestamptz, start_anchor jsonb, reached_anchor jsonb, end_anchor jsonb,
  start_odometer integer, end_odometer integer, distance_meters integer, duration_seconds integer, created_at timestamptz not null default now()
);
create table public.test_drive_route_summaries (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), test_drive_id uuid not null unique references public.test_drives(id),
  encoded_polyline text, distance_meters integer not null, duration_seconds integer not null, point_count integer not null, created_at timestamptz not null default now()
);
create table public.test_drive_route_points (
  id bigint generated always as identity primary key, organization_id uuid not null references public.organizations(id), test_drive_id uuid not null references public.test_drives(id),
  sequence_no integer not null, latitude double precision not null, longitude double precision not null, recorded_at timestamptz not null, unique (test_drive_id, sequence_no)
);
create table public.test_drive_feedback (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), test_drive_id uuid not null unique references public.test_drives(id),
  vehicle_rating smallint check (vehicle_rating between 1 and 5), consultant_rating smallint check (consultant_rating between 1 and 5), comments text, created_at timestamptz not null default now()
);
create table public.live_tracking_sessions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), test_drive_id uuid not null references public.test_drives(id),
  requested_by uuid not null references public.profiles(id), started_at timestamptz not null default now(), expires_at timestamptz not null, ended_at timestamptz,
  tracking_credit_reference uuid, constraint tracking_max_one_minute check (expires_at <= started_at + interval '1 minute')
);

create table public.vehicle_brands (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, active boolean not null default true, unique (organization_id, name)
);
create table public.vehicle_models (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), brand_id uuid not null references public.vehicle_brands(id), name text not null, active boolean not null default true, unique (organization_id, brand_id, name)
);
create table public.vehicle_variants (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), model_id uuid not null references public.vehicle_models(id), name text not null, specifications jsonb not null default '{}'::jsonb, active boolean not null default true, unique (organization_id, model_id, name)
);
create table public.stock_units (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), variant_id uuid not null references public.vehicle_variants(id),
  vin text not null, chassis_number text not null, engine_number text, color text, status text not null default 'AVAILABLE', received_at timestamptz, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, vin), unique (organization_id, chassis_number)
);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), stock_unit_id uuid not null references public.stock_units(id),
  from_branch_id uuid references public.branches(id), to_branch_id uuid references public.branches(id), movement_type text not null, reason text, moved_by uuid references public.profiles(id), moved_at timestamptz not null default now()
);
create table public.stock_allocations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), stock_unit_id uuid not null references public.stock_units(id),
  booking_id uuid, allocation_method text not null check (allocation_method in ('MANUAL','AUTO')), status text not null default 'ACTIVE', allocated_by uuid references public.profiles(id), allocated_at timestamptz not null default now()
);
create table public.quotations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  customer_id uuid not null references public.customers(id), lead_id uuid references public.leads(id), assigned_user_id uuid not null references public.profiles(id), quotation_number text not null,
  status text not null default 'DRAFT', current_version integer not null default 1, total_amount numeric(14,2) not null default 0, approval_status text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, quotation_number)
);
create table public.quotation_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), quotation_id uuid not null references public.quotations(id),
  item_type text not null, description text not null, quantity numeric(10,2) not null default 1, unit_price numeric(14,2) not null, adjustment numeric(14,2) not null default 0
);
create table public.quotation_versions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), quotation_id uuid not null references public.quotations(id),
  version integer not null, snapshot jsonb not null, created_by uuid references public.profiles(id), created_at timestamptz not null default now(), unique (quotation_id, version)
);
create table public.bookings (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), team_id uuid references public.teams(id),
  customer_id uuid not null references public.customers(id), lead_id uuid references public.leads(id), quotation_id uuid references public.quotations(id), assigned_user_id uuid not null references public.profiles(id),
  booking_number text not null, status text not null default 'CONFIRMED', booking_amount numeric(14,2) not null, total_value numeric(14,2), finance_required boolean not null default false,
  exchange_required boolean not null default false, expected_delivery_date date, deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, booking_number), unique nulls not distinct (organization_id, quotation_id)
);
create table public.booking_status_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), booking_id uuid not null references public.bookings(id),
  from_status text, to_status text not null, changed_by uuid references public.profiles(id), reason text, created_at timestamptz not null default now()
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid references public.branches(id), resource_type text not null, resource_id uuid not null,
  approval_type text not null, requested_change jsonb not null, requester_id uuid not null references public.profiles(id), current_approver_id uuid references public.profiles(id), authority_limit numeric(14,2),
  status text not null default 'PENDING', created_at timestamptz not null default now(), decided_at timestamptz
);
create table public.approval_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), approval_id uuid not null references public.approvals(id),
  actor_id uuid not null references public.profiles(id), action text not null, comment text, created_at timestamptz not null default now()
);
create table public.targets (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid references public.branches(id), team_id uuid references public.teams(id), user_id uuid references public.profiles(id),
  metric text not null, period_start date not null, period_end date not null, target_value numeric(14,2) not null, assigned_by uuid references public.profiles(id), created_at timestamptz not null default now()
);

-- All post-booking departments use separate case tables while sharing a common workflow shape.
create table public.exchange_cases (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), booking_id uuid references public.bookings(id), customer_id uuid not null references public.customers(id),
  assigned_user_id uuid references public.profiles(id), status text not null default 'REQUESTED', vehicle_id uuid references public.customer_vehicles(id), estimated_value numeric(14,2), accepted_value numeric(14,2), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.exchange_evaluations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), exchange_case_id uuid not null references public.exchange_cases(id), evaluator_id uuid references public.profiles(id),
  inspection jsonb not null default '{}'::jsonb, quoted_value numeric(14,2), created_at timestamptz not null default now()
);
create table public.finance_cases (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), booking_id uuid not null references public.bookings(id), customer_id uuid not null references public.customers(id),
  assigned_user_id uuid references public.profiles(id), status text not null default 'DOCUMENTS_PENDING', lender text, application_reference text, approved_amount numeric(14,2), disbursed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, booking_id)
);
create table public.insurance_cases (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), booking_id uuid not null references public.bookings(id), customer_id uuid not null references public.customers(id),
  vehicle_id uuid, assigned_user_id uuid references public.profiles(id), status text not null default 'QUOTE_PENDING', insurer text, policy_number text, policy_start date, policy_end date, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, booking_id)
);
create table public.rto_cases (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), booking_id uuid not null references public.bookings(id), customer_id uuid not null references public.customers(id),
  vehicle_id uuid, assigned_user_id uuid references public.profiles(id), status text not null default 'NEW', registration_number text, submitted_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, booking_id)
);
create table public.delivery_cases (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), booking_id uuid not null references public.bookings(id), customer_id uuid not null references public.customers(id),
  vehicle_id uuid, assigned_user_id uuid references public.profiles(id), status text not null default 'PLANNING', scheduled_at timestamptz, delivered_at timestamptz, signature_file_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (organization_id, booking_id)
);
create table public.delivery_checklist_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), delivery_id uuid not null references public.delivery_cases(id), category text not null, item text not null,
  completed boolean not null default false, completed_by uuid references public.profiles(id), completed_at timestamptz
);
create table public.case_documents (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), case_type text not null check (case_type in ('FINANCE','INSURANCE','RTO','EXCHANGE','DELIVERY')),
  case_id uuid not null, document_type text not null, object_file_id uuid not null, status text not null default 'UPLOADED', created_at timestamptz not null default now()
);
create table public.feedback_requests (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), customer_id uuid not null references public.customers(id), booking_id uuid references public.bookings(id),
  channel text not null, status text not null default 'PENDING', sent_at timestamptz, completed_at timestamptz, rating smallint check (rating between 1 and 5), comments text, created_at timestamptz not null default now()
);
create table public.complaints (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid not null references public.branches(id), customer_id uuid not null references public.customers(id), booking_id uuid references public.bookings(id),
  assigned_user_id uuid references public.profiles(id), category text not null, description text not null, priority text not null, status text not null default 'OPEN', resolution text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.escalations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid references public.branches(id), resource_type text not null, resource_id uuid not null,
  assigned_user_id uuid references public.profiles(id), reason text not null, severity text not null, status text not null default 'OPEN', resolved_at timestamptz, created_at timestamptz not null default now()
);

create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), provider_key text not null, display_name text not null,
  scope_mode public.branch_scope_mode not null, status text not null default 'PENDING', external_account_id text, credential_version integer not null default 1, last_tested_at timestamptz, last_sync_at timestamptz,
  created_by uuid references public.profiles(id), deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.integration_credentials (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), connected_account_id uuid not null unique references public.connected_accounts(id),
  encrypted_payload bytea not null, key_version integer not null, replaced_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
revoke all on public.integration_credentials from anon, authenticated;
create table public.integration_branch_mappings (
  organization_id uuid not null references public.organizations(id), connected_account_id uuid not null references public.connected_accounts(id), branch_id uuid not null references public.branches(id),
  external_resource_type text, external_resource_id text, created_at timestamptz not null default now(), primary key (connected_account_id, branch_id, external_resource_id)
);
create table public.integration_field_mappings (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), connected_account_id uuid not null references public.connected_accounts(id),
  external_field text not null, canonical_field text not null, transform_config jsonb not null default '{}'::jsonb, unique (connected_account_id, external_field)
);
create table public.provider_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), connected_account_id uuid not null references public.connected_accounts(id),
  provider_event_id text not null, event_type text not null, payload_reference text, payload_hash text not null, status text not null default 'RECEIVED', received_at timestamptz not null default now(), processed_at timestamptz,
  unique (organization_id, connected_account_id, provider_event_id)
);
create table public.sync_runs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), connected_account_id uuid not null references public.connected_accounts(id),
  sync_type text not null, status text not null, cursor text, records_processed integer not null default 0, request_id uuid not null default gen_random_uuid(), started_at timestamptz not null default now(), completed_at timestamptz
);
create table public.error_logs (
  id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id), reference_id uuid not null default gen_random_uuid(), service text not null, safe_code text not null,
  safe_message text not null, sanitized_context jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.automation_rules (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, event_type text not null, conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb, enabled boolean not null default false, created_by uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.automation_runs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), rule_id uuid not null references public.automation_rules(id), event_id uuid,
  status text not null, result jsonb not null default '{}'::jsonb, started_at timestamptz not null default now(), completed_at timestamptz
);
create table public.templates (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), channel text not null, name text not null, content jsonb not null,
  provider_template_id text, status text not null default 'DRAFT', created_by uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.alert_rules (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, event_type text not null, conditions jsonb not null,
  recipients jsonb not null, enabled boolean not null default true, created_at timestamptz not null default now()
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), user_id uuid not null references public.profiles(id), event_type text not null,
  title text not null, body text not null, resource_type text, resource_id uuid, read_at timestamptz, created_at timestamptz not null default now()
);
create table public.domain_outbox (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), event_type text not null, aggregate_type text not null, aggregate_id uuid not null,
  payload jsonb not null, created_at timestamptz not null default now(), published_at timestamptz, attempts integer not null default 0
);
create table public.audit_logs (
  id bigint generated always as identity primary key, organization_id uuid references public.organizations(id), actor_id uuid references public.profiles(id), action text not null,
  resource_type text not null, resource_id text, branch_id uuid, request_id uuid, metadata jsonb not null default '{}'::jsonb, ip_hash text, created_at timestamptz not null default now()
);
create table public.support_access_requests (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), requested_by uuid not null references public.profiles(id), purpose text not null,
  capability_scope jsonb not null, status text not null default 'PENDING', approved_by uuid references public.profiles(id), created_at timestamptz not null default now(), decided_at timestamptz
);
create table public.support_sessions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), request_id uuid not null unique references public.support_access_requests(id), requester_id uuid not null references public.profiles(id),
  approver_id uuid not null references public.profiles(id), purpose text not null, capability_scope jsonb not null, starts_at timestamptz not null default now(), expires_at timestamptz not null,
  ended_at timestamptz, termination_reason text, constraint support_session_max_hour check (expires_at <= starts_at + interval '1 hour')
);
create table public.tenant_status_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), from_status public.tenant_status, to_status public.tenant_status not null,
  changed_by uuid references public.profiles(id), reason text, created_at timestamptz not null default now()
);
create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), resource_type text not null, resource_id uuid not null,
  requested_by uuid not null references public.profiles(id), reason text not null, status text not null default 'PENDING', purge_after timestamptz, created_at timestamptz not null default now()
);
create table public.purge_jobs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), deletion_request_id uuid not null references public.deletion_requests(id),
  status text not null default 'QUEUED', trigger_run_id text, attempts integer not null default 0, started_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now()
);
create table public.object_files (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), branch_id uuid references public.branches(id), resource_type text not null, resource_id uuid not null,
  bucket text not null, object_key text not null, mime_type text not null, size_bytes bigint not null check (size_bytes >= 0), checksum text not null, uploaded_by uuid references public.profiles(id),
  deleted_at timestamptz, created_at timestamptz not null default now(), unique (bucket, object_key)
);
alter table public.call_recordings add constraint call_recordings_object_file_fk foreign key (object_file_id) references public.object_files(id);

create index followups_scope_due_idx on public.followups (organization_id, assigned_user_id, status, due_at, id);
create index calls_scope_started_idx on public.calls (organization_id, branch_id, started_at desc, id);
create index appointments_scope_scheduled_idx on public.appointments (organization_id, branch_id, scheduled_at, id);
create index bookings_scope_created_idx on public.bookings (organization_id, branch_id, status, created_at desc, id);
create index stock_units_scope_status_idx on public.stock_units (organization_id, branch_id, status, created_at desc, id);
create index provider_events_cursor_idx on public.provider_events (organization_id, connected_account_id, received_at desc, id);
create index audit_logs_cursor_idx on public.audit_logs (organization_id, created_at desc, id);
create index notifications_user_idx on public.notifications (organization_id, user_id, read_at, created_at desc);
create index outbox_unpublished_idx on public.domain_outbox (created_at, id) where published_at is null;
create index object_files_resource_idx on public.object_files (organization_id, resource_type, resource_id);

create or replace function app_private.prevent_immutable_change() returns trigger language plpgsql set search_path = '' as $$
begin raise exception using errcode = '42501', message = 'IMMUTABLE_RECORD'; end;
$$;
create trigger audit_logs_immutable before update or delete on public.audit_logs for each row execute function app_private.prevent_immutable_change();
create trigger credit_ledger_immutable before update or delete on public.credit_ledger for each row execute function app_private.prevent_immutable_change();

create or replace function app_private.can_access_record(target_organization_id uuid, target_branch_id uuid default null, target_team_id uuid default null, target_owner_id uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin() or (app_private.can_access_organization(target_organization_id) and exists (
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid() and ura.organization_id = target_organization_id and ura.active and (
      ura.data_scope = 'ORGANIZATION'
      or ura.data_scope = 'ALL_BRANCHES'
      or (ura.data_scope = 'ONE_BRANCH' and target_branch_id = ura.scope_branch_id)
      or (ura.data_scope = 'SELECTED_BRANCHES' and target_branch_id = any(ura.selected_branch_ids))
      or (ura.data_scope = 'OWN_RECORDS' and target_owner_id = auth.uid())
      or (ura.data_scope = 'OWN_TEAM' and target_team_id in (select tm.team_id from public.team_members tm where tm.user_id = auth.uid() and tm.active))
    )
  ));
$$;

-- Tenant isolation is server-enforced for every organization-owned table. Tables with branch/team/owner columns also enforce record scope.
do $$
declare t record; expression text;
begin
  for t in
    select c.table_name,
      bool_or(c.column_name = 'branch_id') as has_branch,
      bool_or(c.column_name = 'team_id') as has_team,
      bool_or(c.column_name = 'assigned_user_id') as has_owner
    from information_schema.columns c
    join information_schema.tables table_row
      on table_row.table_schema = c.table_schema
     and table_row.table_name = c.table_name
     and table_row.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name in ('organization_id','branch_id','team_id','assigned_user_id')
    group by c.table_name
    having bool_or(c.column_name = 'organization_id')
  loop
    execute format('alter table public.%I enable row level security', t.table_name);
    execute format('alter table public.%I force row level security', t.table_name);
    expression := format(
      'app_private.can_access_record(organization_id, %s, %s, %s)',
      case when t.has_branch then 'branch_id' else 'null' end,
      case when t.has_team then 'team_id' else 'null' end,
      case when t.has_owner then 'assigned_user_id' else 'null' end
    );
    execute format('create policy tenant_record_scope on public.%I for all to authenticated using (%s) with check (%s)', t.table_name, expression, expression);
  end loop;
end $$;

alter table public.organizations enable row level security;
alter table public.organizations force row level security;
create policy organization_scope on public.organizations for select to authenticated using (app_private.can_access_organization(id));

alter table public.permissions enable row level security;
alter table public.modules enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.plan_modules enable row level security;
create policy authenticated_permission_catalog on public.permissions for select to authenticated using (true);
create policy authenticated_module_catalog on public.modules for select to authenticated using (true);
create policy platform_plan_access on public.subscription_plans for all to authenticated using (app_private.is_platform_admin()) with check (app_private.is_platform_admin());
create policy platform_plan_module_access on public.plan_modules for all to authenticated using (app_private.is_platform_admin()) with check (app_private.is_platform_admin());

commit;
