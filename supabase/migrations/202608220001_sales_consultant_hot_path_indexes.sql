-- Sales Consultant hot-path indexes.
--
-- This file intentionally has no surrounding transaction: PostgreSQL requires
-- CREATE INDEX CONCURRENTLY to run outside a transaction block.  The indexes
-- are additive and can be built without blocking normal writes on large tenant
-- tables.

create index concurrently if not exists leads_sc_owner_updated_idx
  on public.leads (organization_id, assigned_user_id, updated_at desc, id desc)
  where deleted_at is null;

create index concurrently if not exists leads_sc_owner_created_idx
  on public.leads (organization_id, assigned_user_id, created_at desc, id desc)
  include (branch_id, lifecycle_status, temperature, first_contacted_at, next_followup_at)
  where deleted_at is null;

create index concurrently if not exists appointments_sc_owner_scheduled_idx
  on public.appointments (organization_id, assigned_user_id, scheduled_at, id)
  include (branch_id, status, appointment_type, customer_id, lead_id);

create index concurrently if not exists followups_sc_owner_created_idx
  on public.followups (organization_id, assigned_user_id, created_at desc, id desc)
  include (branch_id, status, lead_id);

create index concurrently if not exists test_drive_appts_sc_owner_scheduled_idx
  on public.test_drive_appointments (organization_id, assigned_user_id, scheduled_at, id)
  include (branch_id, status, customer_id, lead_id, stock_unit_id)
  where status <> 'CANCELLED';

create index concurrently if not exists test_drive_appts_sc_owner_created_idx
  on public.test_drive_appointments (
    organization_id,
    assigned_user_id,
    created_at desc,
    id desc
  )
  include (branch_id, status, lead_id);

create index concurrently if not exists followups_sc_owner_due_idx
  on public.followups (organization_id, assigned_user_id, due_at, id)
  include (branch_id, team_id, status, priority, customer_id, lead_id, updated_at);

create index concurrently if not exists followups_sc_owner_updated_idx
  on public.followups (organization_id, assigned_user_id, updated_at desc, id)
  include (branch_id, team_id, status, priority, customer_id, lead_id, due_at);

create index concurrently if not exists appointments_sc_owner_updated_idx
  on public.appointments (organization_id, assigned_user_id, updated_at desc, id)
  include (branch_id, team_id, status, appointment_type, customer_id, lead_id, scheduled_at);

create index concurrently if not exists tasks_sc_owner_due_idx
  on public.tasks (organization_id, assigned_user_id, due_at, id)
  include (branch_id, team_id, status, priority, customer_id, lead_id, updated_at)
  where deleted_at is null;

create index concurrently if not exists tasks_sc_owner_updated_idx
  on public.tasks (organization_id, assigned_user_id, updated_at desc, id)
  include (branch_id, team_id, status, priority, customer_id, lead_id, due_at)
  where deleted_at is null;

create index concurrently if not exists quotations_sc_owner_updated_idx
  on public.quotations (organization_id, assigned_user_id, updated_at desc, id desc)
  include (
    branch_id,
    customer_id,
    team_id,
    lead_id,
    quotation_number,
    status,
    current_version,
    version,
    total_amount,
    approval_status,
    created_at
  )
  where deleted_at is null;

create index concurrently if not exists quotations_sc_owner_status_updated_idx
  on public.quotations (
    organization_id,
    assigned_user_id,
    status,
    updated_at desc,
    id desc
  )
  include (branch_id, customer_id, quotation_number, total_amount, approval_status)
  where deleted_at is null;

create index concurrently if not exists quotations_sc_owner_created_idx
  on public.quotations (organization_id, assigned_user_id, created_at desc, id desc)
  include (branch_id, status, lead_id, customer_id)
  where deleted_at is null;

create index concurrently if not exists bookings_sc_owner_updated_idx
  on public.bookings (organization_id, assigned_user_id, updated_at desc, id desc)
  include (
    branch_id,
    customer_id,
    team_id,
    lead_id,
    quotation_id,
    booking_number,
    status,
    booking_amount,
    total_value,
    finance_required,
    exchange_required,
    expected_delivery_date,
    version,
    created_at
  )
  where deleted_at is null;

create index concurrently if not exists bookings_sc_owner_status_updated_idx
  on public.bookings (
    organization_id,
    assigned_user_id,
    status,
    updated_at desc,
    id desc
  )
  include (
    branch_id,
    customer_id,
    quotation_id,
    booking_number,
    total_value,
    expected_delivery_date,
    created_at
  )
  where deleted_at is null;

create index concurrently if not exists bookings_sc_owner_created_idx
  on public.bookings (organization_id, assigned_user_id, created_at desc, id desc)
  include (branch_id, status, lead_id, customer_id, quotation_id, total_value)
  where deleted_at is null;

create index concurrently if not exists stock_units_sc_active_group_idx
  on public.stock_units (
    organization_id,
    branch_id,
    variant_id,
    color,
    status
  )
  where deleted_at is null and status <> 'DELIVERED';

create index concurrently if not exists activities_org_lead_occurred_idx
  on public.activities (organization_id, lead_id, occurred_at desc, id desc)
  where lead_id is not null;

create index concurrently if not exists notes_org_resource_created_idx
  on public.notes (organization_id, lower(resource_type), resource_id, created_at desc, id desc)
  where deleted_at is null;

create index concurrently if not exists test_drive_appts_org_lead_scheduled_idx
  on public.test_drive_appointments (organization_id, lead_id, scheduled_at desc, id desc)
  where lead_id is not null;

create index concurrently if not exists bookings_org_lead_updated_active_idx
  on public.bookings (organization_id, lead_id, updated_at desc, id desc)
  where deleted_at is null and lead_id is not null;

create index concurrently if not exists exchange_cases_org_booking_updated_idx
  on public.exchange_cases (organization_id, booking_id, updated_at desc, id desc)
  where deleted_at is null and booking_id is not null;

create index concurrently if not exists exchange_evaluations_org_case_created_idx
  on public.exchange_evaluations (organization_id, exchange_case_id, created_at desc, id desc);

create index concurrently if not exists customer_addresses_org_customer_created_idx
  on public.customer_addresses (
    organization_id,
    customer_id,
    address_type,
    created_at desc,
    id desc
  );
