begin;

-- Department visibility is intentionally separate from mutation authority.
-- Sales Consultants can originate and follow only their own exchange request;
-- they do not receive the Exchange department's transition authority.
insert into public.permissions (permission_key, module, description) values
  ('finance.view', 'finance', 'View finance cases within authorized data scope'),
  ('finance.manage', 'finance', 'Create and progress finance cases within authorized data scope'),
  ('insurance.view', 'insurance', 'View insurance cases within authorized data scope'),
  ('insurance.manage', 'insurance', 'Create and progress insurance cases within authorized data scope'),
  ('rto.view', 'rto', 'View RTO cases within authorized data scope'),
  ('rto.manage', 'rto', 'Create and progress RTO cases within authorized data scope'),
  ('exchange.view', 'exchange', 'View exchange cases within authorized data scope'),
  ('exchange.request', 'exchange', 'Originate a booking-linked exchange request'),
  ('exchange.manage', 'exchange', 'Evaluate and progress exchange cases within authorized data scope'),
  ('delivery.view', 'delivery', 'View delivery cases within authorized data scope'),
  ('delivery.manage', 'delivery', 'Create and progress delivery cases within authorized data scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.system_role
  and (
    role_row.role_key in ('client_admin', 'system_administrator')
    or (
      role_row.role_key in ('business_owner', 'gm_sales')
      and permission_row.permission_key in (
        'finance.view', 'insurance.view', 'rto.view', 'exchange.view', 'delivery.view'
      )
    )
    or (
      role_row.role_key = 'finance_manager'
      and permission_row.permission_key in ('finance.view', 'finance.manage')
    )
    or (
      role_row.role_key = 'insurance_manager'
      and permission_row.permission_key in ('insurance.view', 'insurance.manage')
    )
    or (
      role_row.role_key = 'rto_manager'
      and permission_row.permission_key in ('rto.view', 'rto.manage')
    )
    or (
      role_row.role_key = 'exchange_manager'
      and permission_row.permission_key in ('exchange.view', 'exchange.request', 'exchange.manage')
    )
    or (
      role_row.role_key = 'delivery_manager'
      and permission_row.permission_key in ('delivery.view', 'delivery.manage')
    )
    or (
      role_row.role_key = 'sales_consultant'
      and permission_row.permission_key in ('exchange.view', 'exchange.request')
    )
  )
  and permission_row.permission_key in (
    'finance.view', 'finance.manage', 'insurance.view', 'insurance.manage',
    'rto.view', 'rto.manage', 'exchange.view', 'exchange.request',
    'exchange.manage', 'delivery.view', 'delivery.manage'
  )
on conflict do nothing;

create or replace function app_private.apply_default_operational_case_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is not null and new.system_role then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id
    from public.permissions permission_row
    where (
      new.role_key in ('client_admin', 'system_administrator')
      or (
        new.role_key in ('business_owner', 'gm_sales')
        and permission_row.permission_key in (
          'finance.view', 'insurance.view', 'rto.view', 'exchange.view', 'delivery.view'
        )
      )
      or (
        new.role_key = 'finance_manager'
        and permission_row.permission_key in ('finance.view', 'finance.manage')
      )
      or (
        new.role_key = 'insurance_manager'
        and permission_row.permission_key in ('insurance.view', 'insurance.manage')
      )
      or (
        new.role_key = 'rto_manager'
        and permission_row.permission_key in ('rto.view', 'rto.manage')
      )
      or (
        new.role_key = 'exchange_manager'
        and permission_row.permission_key in ('exchange.view', 'exchange.request', 'exchange.manage')
      )
      or (
        new.role_key = 'delivery_manager'
        and permission_row.permission_key in ('delivery.view', 'delivery.manage')
      )
      or (
        new.role_key = 'sales_consultant'
        and permission_row.permission_key in ('exchange.view', 'exchange.request')
      )
    )
    and permission_row.permission_key in (
      'finance.view', 'finance.manage', 'insurance.view', 'insurance.manage',
      'rto.view', 'rto.manage', 'exchange.view', 'exchange.request',
      'exchange.manage', 'delivery.view', 'delivery.manage'
    )
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists roles_apply_default_operational_case_permissions on public.roles;
create trigger roles_apply_default_operational_case_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_operational_case_permissions();

alter table public.finance_cases
  add column if not exists version bigint not null default 1,
  add column if not exists priority text not null default 'NORMAL',
  add column if not exists due_at timestamptz,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz;
alter table public.insurance_cases
  add column if not exists version bigint not null default 1,
  add column if not exists priority text not null default 'NORMAL',
  add column if not exists due_at timestamptz,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz;
alter table public.rto_cases
  add column if not exists version bigint not null default 1,
  add column if not exists priority text not null default 'NORMAL',
  add column if not exists due_at timestamptz,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz;
alter table public.exchange_cases
  add column if not exists version bigint not null default 1,
  add column if not exists priority text not null default 'NORMAL',
  add column if not exists due_at timestamptz,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz;
alter table public.delivery_cases
  add column if not exists version bigint not null default 1,
  add column if not exists priority text not null default 'NORMAL',
  add column if not exists due_at timestamptz,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz;
alter table public.delivery_checklist_items
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

update public.finance_cases set priority = 'NORMAL' where priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT');
update public.insurance_cases set priority = 'NORMAL' where priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT');
update public.rto_cases set priority = 'NORMAL' where priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT');
update public.exchange_cases set priority = 'NORMAL' where priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT');
update public.delivery_cases set priority = 'NORMAL' where priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT');

alter table public.finance_cases drop constraint if exists finance_cases_workflow_check;
alter table public.finance_cases add constraint finance_cases_workflow_check check (
  version > 0
  and priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  and status in (
    'DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED', 'UNDER_REVIEW',
    'APPROVED', 'DISBURSED', 'REJECTED', 'CANCELLED'
  )
  and (lender is null or char_length(btrim(lender)) between 2 and 160)
  and (application_reference is null or char_length(btrim(application_reference)) between 2 and 120)
  and (approved_amount is null or approved_amount between 0 and 10000000000)
  and (notes is null or char_length(btrim(notes)) <= 4000)
) not valid;
alter table public.insurance_cases drop constraint if exists insurance_cases_workflow_check;
alter table public.insurance_cases add constraint insurance_cases_workflow_check check (
  version > 0
  and priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  and status in ('QUOTE_PENDING', 'QUOTE_SHARED', 'CUSTOMER_ACCEPTED', 'POLICY_ISSUED', 'CANCELLED')
  and (insurer is null or char_length(btrim(insurer)) between 2 and 160)
  and (policy_number is null or char_length(btrim(policy_number)) between 2 and 120)
  and (policy_end is null or policy_start is null or policy_end >= policy_start)
  and (notes is null or char_length(btrim(notes)) <= 4000)
) not valid;
alter table public.rto_cases drop constraint if exists rto_cases_workflow_check;
alter table public.rto_cases add constraint rto_cases_workflow_check check (
  version > 0
  and priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  and status in ('NEW', 'DOCUMENTS_PENDING', 'SUBMITTED', 'IN_PROCESS', 'REGISTERED', 'CANCELLED')
  and (registration_number is null or char_length(btrim(registration_number)) between 4 and 24)
  and (completed_at is null or submitted_at is null or completed_at >= submitted_at)
  and (notes is null or char_length(btrim(notes)) <= 4000)
) not valid;
alter table public.exchange_cases drop constraint if exists exchange_cases_workflow_check;
alter table public.exchange_cases add constraint exchange_cases_workflow_check check (
  version > 0
  and priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  and status in (
    'REQUESTED', 'INSPECTION_SCHEDULED', 'EVALUATED', 'OFFERED',
    'ACCEPTED', 'REJECTED', 'CANCELLED'
  )
  and (estimated_value is null or estimated_value between 0 and 10000000000)
  and (accepted_value is null or accepted_value between 0 and 10000000000)
  and (notes is null or char_length(btrim(notes)) <= 4000)
) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_workflow_check;
alter table public.delivery_cases add constraint delivery_cases_workflow_check check (
  version > 0
  and priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  and status in ('PLANNING', 'CHECKLIST_PENDING', 'READY', 'SCHEDULED', 'DELIVERED', 'CANCELLED')
  and (notes is null or char_length(btrim(notes)) <= 4000)
  and (delivered_at is null or scheduled_at is null or delivered_at >= scheduled_at)
) not valid;

create unique index if not exists customer_vehicles_org_customer_id_unique_idx
  on public.customer_vehicles (organization_id, customer_id, id);
create unique index if not exists finance_cases_org_id_unique_idx
  on public.finance_cases (organization_id, id);
create unique index if not exists insurance_cases_org_id_unique_idx
  on public.insurance_cases (organization_id, id);
create unique index if not exists rto_cases_org_id_unique_idx
  on public.rto_cases (organization_id, id);
create unique index if not exists exchange_cases_org_id_unique_idx
  on public.exchange_cases (organization_id, id);
create unique index if not exists delivery_cases_org_id_unique_idx
  on public.delivery_cases (organization_id, id);

create index if not exists finance_cases_workspace_idx
  on public.finance_cases (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists insurance_cases_workspace_idx
  on public.insurance_cases (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists rto_cases_workspace_idx
  on public.rto_cases (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists exchange_cases_workspace_idx
  on public.exchange_cases (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists delivery_cases_workspace_idx
  on public.delivery_cases (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists operational_case_documents_lookup_idx
  on public.object_files (organization_id, resource_type, resource_id, created_at desc, id)
  where deleted_at is null;
create unique index if not exists operational_case_mutation_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null and action like 'case.%';

-- Composite references make tenant identity part of every operational link.
alter table public.finance_cases drop constraint if exists finance_cases_branch_org_fk;
alter table public.finance_cases add constraint finance_cases_branch_org_fk
  foreign key (organization_id, branch_id) references public.branches (organization_id, id) not valid;
alter table public.finance_cases drop constraint if exists finance_cases_booking_org_fk;
alter table public.finance_cases add constraint finance_cases_booking_org_fk
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) not valid;
alter table public.finance_cases drop constraint if exists finance_cases_customer_org_fk;
alter table public.finance_cases add constraint finance_cases_customer_org_fk
  foreign key (organization_id, customer_id) references public.customers (organization_id, id) not valid;
alter table public.finance_cases drop constraint if exists finance_cases_assignee_org_fk;
alter table public.finance_cases add constraint finance_cases_assignee_org_fk
  foreign key (organization_id, assigned_user_id) references public.profiles (organization_id, id) not valid;
alter table public.finance_cases drop constraint if exists finance_cases_creator_org_fk;
alter table public.finance_cases add constraint finance_cases_creator_org_fk
  foreign key (organization_id, created_by) references public.profiles (organization_id, id) not valid;

alter table public.insurance_cases drop constraint if exists insurance_cases_branch_org_fk;
alter table public.insurance_cases add constraint insurance_cases_branch_org_fk
  foreign key (organization_id, branch_id) references public.branches (organization_id, id) not valid;
alter table public.insurance_cases drop constraint if exists insurance_cases_booking_org_fk;
alter table public.insurance_cases add constraint insurance_cases_booking_org_fk
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) not valid;
alter table public.insurance_cases drop constraint if exists insurance_cases_customer_org_fk;
alter table public.insurance_cases add constraint insurance_cases_customer_org_fk
  foreign key (organization_id, customer_id) references public.customers (organization_id, id) not valid;
alter table public.insurance_cases drop constraint if exists insurance_cases_assignee_org_fk;
alter table public.insurance_cases add constraint insurance_cases_assignee_org_fk
  foreign key (organization_id, assigned_user_id) references public.profiles (organization_id, id) not valid;
alter table public.insurance_cases drop constraint if exists insurance_cases_creator_org_fk;
alter table public.insurance_cases add constraint insurance_cases_creator_org_fk
  foreign key (organization_id, created_by) references public.profiles (organization_id, id) not valid;
alter table public.insurance_cases drop constraint if exists insurance_cases_vehicle_org_fk;
alter table public.insurance_cases add constraint insurance_cases_vehicle_org_fk
  foreign key (organization_id, customer_id, vehicle_id)
  references public.customer_vehicles (organization_id, customer_id, id) not valid;

alter table public.rto_cases drop constraint if exists rto_cases_branch_org_fk;
alter table public.rto_cases add constraint rto_cases_branch_org_fk
  foreign key (organization_id, branch_id) references public.branches (organization_id, id) not valid;
alter table public.rto_cases drop constraint if exists rto_cases_booking_org_fk;
alter table public.rto_cases add constraint rto_cases_booking_org_fk
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) not valid;
alter table public.rto_cases drop constraint if exists rto_cases_customer_org_fk;
alter table public.rto_cases add constraint rto_cases_customer_org_fk
  foreign key (organization_id, customer_id) references public.customers (organization_id, id) not valid;
alter table public.rto_cases drop constraint if exists rto_cases_assignee_org_fk;
alter table public.rto_cases add constraint rto_cases_assignee_org_fk
  foreign key (organization_id, assigned_user_id) references public.profiles (organization_id, id) not valid;
alter table public.rto_cases drop constraint if exists rto_cases_creator_org_fk;
alter table public.rto_cases add constraint rto_cases_creator_org_fk
  foreign key (organization_id, created_by) references public.profiles (organization_id, id) not valid;
alter table public.rto_cases drop constraint if exists rto_cases_vehicle_org_fk;
alter table public.rto_cases add constraint rto_cases_vehicle_org_fk
  foreign key (organization_id, customer_id, vehicle_id)
  references public.customer_vehicles (organization_id, customer_id, id) not valid;

alter table public.exchange_cases drop constraint if exists exchange_cases_branch_org_fk;
alter table public.exchange_cases add constraint exchange_cases_branch_org_fk
  foreign key (organization_id, branch_id) references public.branches (organization_id, id) not valid;
alter table public.exchange_cases drop constraint if exists exchange_cases_booking_org_fk;
alter table public.exchange_cases add constraint exchange_cases_booking_org_fk
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) not valid;
alter table public.exchange_cases drop constraint if exists exchange_cases_customer_org_fk;
alter table public.exchange_cases add constraint exchange_cases_customer_org_fk
  foreign key (organization_id, customer_id) references public.customers (organization_id, id) not valid;
alter table public.exchange_cases drop constraint if exists exchange_cases_assignee_org_fk;
alter table public.exchange_cases add constraint exchange_cases_assignee_org_fk
  foreign key (organization_id, assigned_user_id) references public.profiles (organization_id, id) not valid;
alter table public.exchange_cases drop constraint if exists exchange_cases_creator_org_fk;
alter table public.exchange_cases add constraint exchange_cases_creator_org_fk
  foreign key (organization_id, created_by) references public.profiles (organization_id, id) not valid;
alter table public.exchange_cases drop constraint if exists exchange_cases_vehicle_org_fk;
alter table public.exchange_cases add constraint exchange_cases_vehicle_org_fk
  foreign key (organization_id, customer_id, vehicle_id)
  references public.customer_vehicles (organization_id, customer_id, id) not valid;

alter table public.delivery_cases drop constraint if exists delivery_cases_branch_org_fk;
alter table public.delivery_cases add constraint delivery_cases_branch_org_fk
  foreign key (organization_id, branch_id) references public.branches (organization_id, id) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_booking_org_fk;
alter table public.delivery_cases add constraint delivery_cases_booking_org_fk
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_customer_org_fk;
alter table public.delivery_cases add constraint delivery_cases_customer_org_fk
  foreign key (organization_id, customer_id) references public.customers (organization_id, id) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_assignee_org_fk;
alter table public.delivery_cases add constraint delivery_cases_assignee_org_fk
  foreign key (organization_id, assigned_user_id) references public.profiles (organization_id, id) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_creator_org_fk;
alter table public.delivery_cases add constraint delivery_cases_creator_org_fk
  foreign key (organization_id, created_by) references public.profiles (organization_id, id) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_vehicle_org_fk;
alter table public.delivery_cases add constraint delivery_cases_vehicle_org_fk
  foreign key (organization_id, customer_id, vehicle_id)
  references public.customer_vehicles (organization_id, customer_id, id) not valid;
alter table public.delivery_cases drop constraint if exists delivery_cases_signature_org_fk;
alter table public.delivery_cases add constraint delivery_cases_signature_org_fk
  foreign key (organization_id, signature_file_id)
  references public.object_files (organization_id, id) not valid;

alter table public.exchange_evaluations drop constraint if exists exchange_evaluations_case_org_fk;
alter table public.exchange_evaluations add constraint exchange_evaluations_case_org_fk
  foreign key (organization_id, exchange_case_id)
  references public.exchange_cases (organization_id, id) not valid;
alter table public.exchange_evaluations drop constraint if exists exchange_evaluations_evaluator_org_fk;
alter table public.exchange_evaluations add constraint exchange_evaluations_evaluator_org_fk
  foreign key (organization_id, evaluator_id) references public.profiles (organization_id, id) not valid;
alter table public.delivery_checklist_items drop constraint if exists delivery_checklist_case_org_fk;
alter table public.delivery_checklist_items add constraint delivery_checklist_case_org_fk
  foreign key (organization_id, delivery_id) references public.delivery_cases (organization_id, id) not valid;
alter table public.delivery_checklist_items drop constraint if exists delivery_checklist_actor_org_fk;
alter table public.delivery_checklist_items add constraint delivery_checklist_actor_org_fk
  foreign key (organization_id, completed_by) references public.profiles (organization_id, id) not valid;
alter table public.finance_case_documents drop constraint if exists finance_case_documents_case_org_fk;
alter table public.finance_case_documents add constraint finance_case_documents_case_org_fk
  foreign key (organization_id, finance_case_id)
  references public.finance_cases (organization_id, id) not valid;
alter table public.finance_case_documents drop constraint if exists finance_case_documents_file_org_fk;
alter table public.finance_case_documents add constraint finance_case_documents_file_org_fk
  foreign key (organization_id, object_file_id)
  references public.object_files (organization_id, id) not valid;
alter table public.insurance_case_documents drop constraint if exists insurance_case_documents_case_org_fk;
alter table public.insurance_case_documents add constraint insurance_case_documents_case_org_fk
  foreign key (organization_id, insurance_case_id)
  references public.insurance_cases (organization_id, id) not valid;
alter table public.insurance_case_documents drop constraint if exists insurance_case_documents_file_org_fk;
alter table public.insurance_case_documents add constraint insurance_case_documents_file_org_fk
  foreign key (organization_id, object_file_id)
  references public.object_files (organization_id, id) not valid;
alter table public.rto_case_documents drop constraint if exists rto_case_documents_case_org_fk;
alter table public.rto_case_documents add constraint rto_case_documents_case_org_fk
  foreign key (organization_id, rto_case_id)
  references public.rto_cases (organization_id, id) not valid;
alter table public.rto_case_documents drop constraint if exists rto_case_documents_file_org_fk;
alter table public.rto_case_documents add constraint rto_case_documents_file_org_fk
  foreign key (organization_id, object_file_id)
  references public.object_files (organization_id, id) not valid;

create or replace function app_private.operational_case_permission(
  target_organization_id uuid,
  target_department text,
  target_action text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then app_private.has_permission(
      target_organization_id,
      case when upper(target_action) = 'MANAGE' then 'finance.manage' else 'finance.view' end
    )
    when 'INSURANCE' then app_private.has_permission(
      target_organization_id,
      case when upper(target_action) = 'MANAGE' then 'insurance.manage' else 'insurance.view' end
    )
    when 'RTO' then app_private.has_permission(
      target_organization_id,
      case when upper(target_action) = 'MANAGE' then 'rto.manage' else 'rto.view' end
    )
    when 'EXCHANGE' then case upper(target_action)
      when 'MANAGE' then app_private.has_permission(target_organization_id, 'exchange.manage')
      when 'REQUEST' then app_private.has_permission(target_organization_id, 'exchange.request')
      else app_private.has_permission(target_organization_id, 'exchange.view')
    end
    when 'DELIVERY' then app_private.has_permission(
      target_organization_id,
      case when upper(target_action) = 'MANAGE' then 'delivery.manage' else 'delivery.view' end
    )
    else false
  end;
$$;

create or replace function app_private.operational_case_status_valid(
  target_department text,
  target_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then upper(coalesce(target_status, '')) in (
      'DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED', 'UNDER_REVIEW',
      'APPROVED', 'DISBURSED', 'REJECTED', 'CANCELLED'
    )
    when 'INSURANCE' then upper(coalesce(target_status, '')) in (
      'QUOTE_PENDING', 'QUOTE_SHARED', 'CUSTOMER_ACCEPTED', 'POLICY_ISSUED', 'CANCELLED'
    )
    when 'RTO' then upper(coalesce(target_status, '')) in (
      'NEW', 'DOCUMENTS_PENDING', 'SUBMITTED', 'IN_PROCESS', 'REGISTERED', 'CANCELLED'
    )
    when 'EXCHANGE' then upper(coalesce(target_status, '')) in (
      'REQUESTED', 'INSPECTION_SCHEDULED', 'EVALUATED', 'OFFERED',
      'ACCEPTED', 'REJECTED', 'CANCELLED'
    )
    when 'DELIVERY' then upper(coalesce(target_status, '')) in (
      'PLANNING', 'CHECKLIST_PENDING', 'READY', 'SCHEDULED', 'DELIVERED', 'CANCELLED'
    )
    else false
  end;
$$;

create or replace function app_private.operational_case_transition_allowed(
  target_department text,
  current_status text,
  next_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then (upper(current_status), upper(next_status)) in (
      ('DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED'),
      ('APPLICATION_SUBMITTED', 'UNDER_REVIEW'),
      ('UNDER_REVIEW', 'APPROVED'),
      ('APPROVED', 'DISBURSED'),
      ('DOCUMENTS_PENDING', 'REJECTED'), ('APPLICATION_SUBMITTED', 'REJECTED'),
      ('UNDER_REVIEW', 'REJECTED'), ('DOCUMENTS_PENDING', 'CANCELLED'),
      ('APPLICATION_SUBMITTED', 'CANCELLED'), ('UNDER_REVIEW', 'CANCELLED'),
      ('APPROVED', 'CANCELLED')
    )
    when 'INSURANCE' then (upper(current_status), upper(next_status)) in (
      ('QUOTE_PENDING', 'QUOTE_SHARED'), ('QUOTE_SHARED', 'CUSTOMER_ACCEPTED'),
      ('CUSTOMER_ACCEPTED', 'POLICY_ISSUED'), ('QUOTE_PENDING', 'CANCELLED'),
      ('QUOTE_SHARED', 'CANCELLED'), ('CUSTOMER_ACCEPTED', 'CANCELLED')
    )
    when 'RTO' then (upper(current_status), upper(next_status)) in (
      ('NEW', 'DOCUMENTS_PENDING'), ('DOCUMENTS_PENDING', 'SUBMITTED'),
      ('SUBMITTED', 'IN_PROCESS'), ('IN_PROCESS', 'REGISTERED'),
      ('NEW', 'CANCELLED'), ('DOCUMENTS_PENDING', 'CANCELLED'),
      ('SUBMITTED', 'CANCELLED'), ('IN_PROCESS', 'CANCELLED')
    )
    when 'EXCHANGE' then (upper(current_status), upper(next_status)) in (
      ('REQUESTED', 'INSPECTION_SCHEDULED'), ('INSPECTION_SCHEDULED', 'EVALUATED'),
      ('EVALUATED', 'OFFERED'), ('OFFERED', 'ACCEPTED'),
      ('REQUESTED', 'REJECTED'), ('INSPECTION_SCHEDULED', 'REJECTED'),
      ('EVALUATED', 'REJECTED'), ('OFFERED', 'REJECTED'),
      ('REQUESTED', 'CANCELLED'), ('INSPECTION_SCHEDULED', 'CANCELLED')
    )
    when 'DELIVERY' then (upper(current_status), upper(next_status)) in (
      ('PLANNING', 'CHECKLIST_PENDING'), ('CHECKLIST_PENDING', 'READY'),
      ('READY', 'SCHEDULED'), ('SCHEDULED', 'DELIVERED'),
      ('PLANNING', 'CANCELLED'), ('CHECKLIST_PENDING', 'CANCELLED'),
      ('READY', 'CANCELLED'), ('SCHEDULED', 'CANCELLED')
    )
    else false
  end;
$$;

create or replace function app_private.operational_case_terminal(
  target_department text,
  target_status text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(target_department, ''))
    when 'FINANCE' then upper(target_status) in ('DISBURSED', 'REJECTED', 'CANCELLED')
    when 'INSURANCE' then upper(target_status) in ('POLICY_ISSUED', 'CANCELLED')
    when 'RTO' then upper(target_status) in ('REGISTERED', 'CANCELLED')
    when 'EXCHANGE' then upper(target_status) in ('ACCEPTED', 'REJECTED', 'CANCELLED')
    when 'DELIVERY' then upper(target_status) in ('DELIVERED', 'CANCELLED')
    else false
  end;
$$;

create or replace function app_private.operational_case_request_fingerprint(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(coalesce(payload, '{}'::jsonb)::text, 'UTF8')),
    'hex'
  );
$$;

create or replace function app_private.replay_operational_case_request(
  target_organization_id uuid,
  target_action text,
  target_request_id uuid,
  target_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_action text;
  previous_metadata jsonb;
begin
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  select audit_row.action, audit_row.metadata
    into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action like 'case.%'
  limit 1;
  if previous_action is null then return null; end if;
  if previous_action <> target_action
    or previous_metadata->>'fingerprint' is distinct from target_fingerprint
  then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return coalesce(previous_metadata->'result', '{}'::jsonb)
    || jsonb_build_object('replayed', true);
end;
$$;

create or replace function app_private.operational_case_rows(
  target_organization_id uuid,
  target_department text
)
returns table (
  department text,
  resource_type text,
  id uuid,
  organization_id uuid,
  branch_id uuid,
  booking_id uuid,
  customer_id uuid,
  assigned_user_id uuid,
  status text,
  version bigint,
  priority text,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  booking_number text,
  customer_name text,
  phone text,
  assigned_user_name text,
  details jsonb,
  document_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'FINANCE'::text, 'finance_case'::text, case_row.id,
    case_row.organization_id, case_row.branch_id, case_row.booking_id,
    case_row.customer_id, case_row.assigned_user_id, case_row.status,
    case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
    case_row.updated_at, booking_row.booking_number, customer_row.full_name,
    customer_row.primary_phone, profile_row.full_name,
    jsonb_strip_nulls(jsonb_build_object(
      'lender', case_row.lender,
      'application_reference', case_row.application_reference,
      'approved_amount', case_row.approved_amount,
      'disbursed_at', case_row.disbursed_at,
      'notes', case_row.notes
    )),
    (select count(*) from public.object_files file_row
      where file_row.organization_id = case_row.organization_id
        and file_row.resource_type = 'finance_case'
        and file_row.resource_id = case_row.id and file_row.deleted_at is null)
  from public.finance_cases case_row
  join public.bookings booking_row
    on booking_row.organization_id = case_row.organization_id
   and booking_row.id = case_row.booking_id and booking_row.deleted_at is null
  join public.customers customer_row
    on customer_row.organization_id = case_row.organization_id
   and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
  left join public.profiles profile_row
    on profile_row.organization_id = case_row.organization_id
   and profile_row.id = case_row.assigned_user_id
  where upper(target_department) = 'FINANCE'
    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
    and app_private.can_access_record(
      case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
    )
    and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  union all
  select 'INSURANCE'::text, 'insurance_case'::text, case_row.id,
    case_row.organization_id, case_row.branch_id, case_row.booking_id,
    case_row.customer_id, case_row.assigned_user_id, case_row.status,
    case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
    case_row.updated_at, booking_row.booking_number, customer_row.full_name,
    customer_row.primary_phone, profile_row.full_name,
    jsonb_strip_nulls(jsonb_build_object(
      'vehicle_id', case_row.vehicle_id,
      'insurer', case_row.insurer,
      'policy_number', case_row.policy_number,
      'policy_start', case_row.policy_start,
      'policy_end', case_row.policy_end,
      'notes', case_row.notes
    )),
    (select count(*) from public.object_files file_row
      where file_row.organization_id = case_row.organization_id
        and file_row.resource_type = 'insurance_case'
        and file_row.resource_id = case_row.id and file_row.deleted_at is null)
  from public.insurance_cases case_row
  join public.bookings booking_row
    on booking_row.organization_id = case_row.organization_id
   and booking_row.id = case_row.booking_id and booking_row.deleted_at is null
  join public.customers customer_row
    on customer_row.organization_id = case_row.organization_id
   and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
  left join public.profiles profile_row
    on profile_row.organization_id = case_row.organization_id
   and profile_row.id = case_row.assigned_user_id
  where upper(target_department) = 'INSURANCE'
    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
    and app_private.can_access_record(
      case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
    )
    and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  union all
  select 'RTO'::text, 'rto_case'::text, case_row.id,
    case_row.organization_id, case_row.branch_id, case_row.booking_id,
    case_row.customer_id, case_row.assigned_user_id, case_row.status,
    case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
    case_row.updated_at, booking_row.booking_number, customer_row.full_name,
    customer_row.primary_phone, profile_row.full_name,
    jsonb_strip_nulls(jsonb_build_object(
      'vehicle_id', case_row.vehicle_id,
      'registration_number', case_row.registration_number,
      'submitted_at', case_row.submitted_at,
      'completed_at', case_row.completed_at,
      'notes', case_row.notes
    )),
    (select count(*) from public.object_files file_row
      where file_row.organization_id = case_row.organization_id
        and file_row.resource_type = 'rto_case'
        and file_row.resource_id = case_row.id and file_row.deleted_at is null)
  from public.rto_cases case_row
  join public.bookings booking_row
    on booking_row.organization_id = case_row.organization_id
   and booking_row.id = case_row.booking_id and booking_row.deleted_at is null
  join public.customers customer_row
    on customer_row.organization_id = case_row.organization_id
   and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
  left join public.profiles profile_row
    on profile_row.organization_id = case_row.organization_id
   and profile_row.id = case_row.assigned_user_id
  where upper(target_department) = 'RTO'
    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
    and app_private.can_access_record(
      case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
    )
    and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  union all
  select 'EXCHANGE'::text, 'exchange_case'::text, case_row.id,
    case_row.organization_id, case_row.branch_id, case_row.booking_id,
    case_row.customer_id, case_row.assigned_user_id, case_row.status,
    case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
    case_row.updated_at, booking_row.booking_number, customer_row.full_name,
    customer_row.primary_phone, profile_row.full_name,
    jsonb_strip_nulls(jsonb_build_object(
      'vehicle_id', case_row.vehicle_id,
      'estimated_value', case_row.estimated_value,
      'accepted_value', case_row.accepted_value,
      'notes', case_row.notes,
      'evaluation', (
        select jsonb_build_object(
          'inspection', evaluation_row.inspection,
          'quoted_value', evaluation_row.quoted_value,
          'created_at', evaluation_row.created_at
        )
        from public.exchange_evaluations evaluation_row
        where evaluation_row.organization_id = case_row.organization_id
          and evaluation_row.exchange_case_id = case_row.id
        order by evaluation_row.created_at desc, evaluation_row.id desc limit 1
      )
    )),
    (select count(*) from public.object_files file_row
      where file_row.organization_id = case_row.organization_id
        and file_row.resource_type = 'exchange_case'
        and file_row.resource_id = case_row.id and file_row.deleted_at is null)
  from public.exchange_cases case_row
  left join public.bookings booking_row
    on booking_row.organization_id = case_row.organization_id
   and booking_row.id = case_row.booking_id and booking_row.deleted_at is null
  join public.customers customer_row
    on customer_row.organization_id = case_row.organization_id
   and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
  left join public.profiles profile_row
    on profile_row.organization_id = case_row.organization_id
   and profile_row.id = case_row.assigned_user_id
  where upper(target_department) = 'EXCHANGE'
    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
    and app_private.can_access_record(
      case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
    )
    and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  union all
  select 'DELIVERY'::text, 'delivery_case'::text, case_row.id,
    case_row.organization_id, case_row.branch_id, case_row.booking_id,
    case_row.customer_id, case_row.assigned_user_id, case_row.status,
    case_row.version, case_row.priority, case_row.due_at, case_row.created_at,
    case_row.updated_at, booking_row.booking_number, customer_row.full_name,
    customer_row.primary_phone, profile_row.full_name,
    jsonb_strip_nulls(jsonb_build_object(
      'vehicle_id', case_row.vehicle_id,
      'scheduled_at', case_row.scheduled_at,
      'delivered_at', case_row.delivered_at,
      'signature_file_id', case_row.signature_file_id,
      'notes', case_row.notes,
      'checklist_total', (select count(*) from public.delivery_checklist_items item_row
        where item_row.organization_id = case_row.organization_id
          and item_row.delivery_id = case_row.id),
      'checklist_completed', (select count(*) from public.delivery_checklist_items item_row
        where item_row.organization_id = case_row.organization_id
          and item_row.delivery_id = case_row.id and item_row.completed)
    )),
    (select count(*) from public.object_files file_row
      where file_row.organization_id = case_row.organization_id
        and file_row.resource_type = 'delivery_case'
        and file_row.resource_id = case_row.id and file_row.deleted_at is null)
  from public.delivery_cases case_row
  join public.bookings booking_row
    on booking_row.organization_id = case_row.organization_id
   and booking_row.id = case_row.booking_id and booking_row.deleted_at is null
  join public.customers customer_row
    on customer_row.organization_id = case_row.organization_id
   and customer_row.id = case_row.customer_id and customer_row.deleted_at is null
  left join public.profiles profile_row
    on profile_row.organization_id = case_row.organization_id
   and profile_row.id = case_row.assigned_user_id
  where upper(target_department) = 'DELIVERY'
    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
    and app_private.can_access_record(
      case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
    )
    and app_private.can_access_customer(case_row.organization_id, case_row.customer_id);
$$;

create or replace function public.get_operational_case_workspace_page(
  target_department text,
  target_status text default 'OPEN',
  target_search text default '',
  target_from_date date default null,
  target_to_date date default null,
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc',
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or (
      normalized_status not in ('ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'COMPLETED')
      and not app_private.operational_case_status_valid(normalized_department, normalized_status)
    )
    or char_length(normalized_search) > 160
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_sort is null
    or target_sort not in ('updated:desc', 'updated:asc', 'due:asc', 'customer:asc', 'priority:desc')
    or target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC')
    or (target_from_date is not null and target_to_date is not null and target_from_date > target_to_date)
    or (target_from_date is not null and target_to_date is not null and target_to_date > target_from_date + 366)
  then
    raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(
      current_organization_id, normalized_department, 'VIEW'
    )
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED';
  end if;

  with authorized as materialized (
    select case_row.*
    from app_private.operational_case_rows(
      current_organization_id, normalized_department
    ) case_row
    where (target_from_date is null
        or timezone(target_timezone, case_row.updated_at)::date >= target_from_date)
      and (target_to_date is null
        or timezone(target_timezone, case_row.updated_at)::date <= target_to_date)
      and (
        normalized_search = ''
        or position(normalized_search in lower(case_row.id::text)) > 0
        or position(normalized_search in lower(coalesce(case_row.booking_number, ''))) > 0
        or position(normalized_search in lower(case_row.customer_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(case_row.phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), filtered as materialized (
    select authorized_row.*
    from authorized authorized_row
    where case normalized_status
      when 'ALL' then true
      when 'OPEN' then not app_private.operational_case_terminal(
        normalized_department, authorized_row.status
      )
      when 'DOCUMENTS' then authorized_row.status in ('DOCUMENTS_PENDING', 'QUOTE_PENDING', 'NEW')
        or authorized_row.document_count = 0
      when 'ACTION_DUE' then not app_private.operational_case_terminal(
          normalized_department, authorized_row.status
        ) and authorized_row.due_at is not null and authorized_row.due_at <= now()
      when 'COMPLETED' then app_private.operational_case_terminal(
        normalized_department, authorized_row.status
      )
      else authorized_row.status = normalized_status
    end
  ), numbered as (
    select filtered_row.*,
      row_number() over (order by
        case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
        case when target_sort = 'updated:asc' then filtered_row.updated_at end asc,
        case when target_sort = 'due:asc' then filtered_row.due_at end asc nulls last,
        case when target_sort = 'customer:asc' then lower(filtered_row.customer_name) end asc,
        case filtered_row.priority when 'URGENT' then 4 when 'HIGH' then 3
          when 'NORMAL' then 2 else 1 end desc,
        filtered_row.id desc
      ) as page_order
    from filtered filtered_row
  ), page_rows as (
    select numbered_row.* from numbered numbered_row
    order by numbered_row.page_order
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_row.page_order)
      from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'organization_id', current_organization_id,
    'department', normalized_department,
    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where not app_private.operational_case_terminal(
        normalized_department, status
      )),
      'pending_documents', (select count(*) from authorized
        where status in ('DOCUMENTS_PENDING', 'QUOTE_PENDING', 'NEW') or document_count = 0),
      'overdue', (select count(*) from authorized where due_at < now()
        and not app_private.operational_case_terminal(normalized_department, status)),
      'due_today', (select count(*) from authorized where due_at is not null
        and timezone(target_timezone, due_at)::date = timezone(target_timezone, now())::date
        and not app_private.operational_case_terminal(normalized_department, status)),
      'completed_this_month', (select count(*) from authorized
        where app_private.operational_case_terminal(normalized_department, status)
          and date_trunc('month', timezone(target_timezone, updated_at))
            = date_trunc('month', timezone(target_timezone, now())))
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.get_operational_case_booking_options(
  target_department text,
  target_search text default '',
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or char_length(normalized_search) > 160
    or target_limit is null or target_limit not between 1 and 25
  then raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_BOOKING_QUERY'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not (
      app_private.operational_case_permission(current_organization_id, normalized_department, 'MANAGE')
      or (
        normalized_department = 'EXCHANGE'
        and app_private.operational_case_permission(current_organization_id, 'EXCHANGE', 'REQUEST')
      )
    )
  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
    into result
  from (
    select booking_row.id as booking_id, booking_row.booking_number,
      booking_row.branch_id, booking_row.customer_id,
      booking_row.assigned_user_id, customer_row.full_name as customer_name,
      customer_row.primary_phone as phone, booking_row.expected_delivery_date,
      booking_row.updated_at
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.organization_id = booking_row.organization_id
     and customer_row.id = booking_row.customer_id and customer_row.deleted_at is null
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and booking_row.status in (
        'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY'
      )
      and (normalized_department <> 'FINANCE' or booking_row.finance_required)
      and (normalized_department <> 'EXCHANGE' or booking_row.exchange_required)
      and app_private.can_access_record(
        booking_row.organization_id, booking_row.branch_id,
        booking_row.team_id, booking_row.assigned_user_id
      )
      and app_private.can_access_customer(booking_row.organization_id, booking_row.customer_id)
      and not exists (
        select 1 from public.finance_cases existing_row
        where normalized_department = 'FINANCE'
          and existing_row.organization_id = booking_row.organization_id
          and existing_row.booking_id = booking_row.id and existing_row.deleted_at is null
      )
      and not exists (
        select 1 from public.insurance_cases existing_row
        where normalized_department = 'INSURANCE'
          and existing_row.organization_id = booking_row.organization_id
          and existing_row.booking_id = booking_row.id and existing_row.deleted_at is null
      )
      and not exists (
        select 1 from public.rto_cases existing_row
        where normalized_department = 'RTO'
          and existing_row.organization_id = booking_row.organization_id
          and existing_row.booking_id = booking_row.id and existing_row.deleted_at is null
      )
      and not exists (
        select 1 from public.exchange_cases existing_row
        where normalized_department = 'EXCHANGE'
          and existing_row.organization_id = booking_row.organization_id
          and existing_row.booking_id = booking_row.id and existing_row.deleted_at is null
      )
      and not exists (
        select 1 from public.delivery_cases existing_row
        where normalized_department = 'DELIVERY'
          and existing_row.organization_id = booking_row.organization_id
          and existing_row.booking_id = booking_row.id and existing_row.deleted_at is null
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
    order by booking_row.updated_at desc, booking_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.create_operational_case(
  target_department text,
  target_booking_id uuid,
  target_vehicle_id uuid,
  target_assigned_user_id uuid,
  target_priority text,
  target_due_at timestamptz,
  target_notes text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  normalized_priority text := upper(btrim(coalesce(target_priority, 'NORMAL')));
  normalized_notes text := nullif(btrim(coalesce(target_notes, '')), '');
  booking_row public.bookings%rowtype;
  effective_assignee_id uuid;
  case_id uuid;
  initial_status text;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
  can_manage boolean;
begin
  if target_booking_id is null or target_request_id is null
    or normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or normalized_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    or char_length(coalesce(normalized_notes, '')) > 4000
    or (target_due_at is not null and (
      target_due_at < now() - interval '1 year' or target_due_at > now() + interval '10 years'
    ))
  then raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_INPUT'; end if;
  current_organization_id := app_private.current_tenant_organization();
  can_manage := current_organization_id is not null and app_private.operational_case_permission(
    current_organization_id, normalized_department, 'MANAGE'
  );
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not (
      can_manage
      or (
        normalized_department = 'EXCHANGE'
        and app_private.operational_case_permission(current_organization_id, 'EXCHANGE', 'REQUEST')
      )
    )
  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;

  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'department', normalized_department, 'booking_id', target_booking_id,
    'vehicle_id', target_vehicle_id, 'assigned_user_id', target_assigned_user_id,
    'priority', normalized_priority, 'due_at', target_due_at, 'notes', normalized_notes
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.created.' || lower(normalized_department),
    target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':case:' || normalized_department || ':' || target_booking_id::text, 0
  ));

  select * into booking_row
  from public.bookings source_row
  where source_row.id = target_booking_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
    and source_row.status in (
      'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY'
    )
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'OPERATIONAL_CASE_BOOKING_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    booking_row.organization_id, booking_row.branch_id,
    booking_row.team_id, booking_row.assigned_user_id
  ) or not app_private.can_access_customer(
    booking_row.organization_id, booking_row.customer_id
  ) then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_SCOPE_DENIED'; end if;
  if normalized_department = 'FINANCE' and not booking_row.finance_required then
    raise exception using errcode = '23514', message = 'FINANCE_NOT_REQUIRED_FOR_BOOKING';
  end if;
  if normalized_department = 'EXCHANGE' and not booking_row.exchange_required then
    raise exception using errcode = '23514', message = 'EXCHANGE_NOT_REQUIRED_FOR_BOOKING';
  end if;

  if not can_manage then
    if booking_row.assigned_user_id <> auth.uid()
      or (target_assigned_user_id is not null and target_assigned_user_id <> auth.uid())
    then raise exception using errcode = '42501', message = 'EXCHANGE_REQUEST_OWNER_REQUIRED'; end if;
    effective_assignee_id := auth.uid();
  else
    effective_assignee_id := coalesce(target_assigned_user_id, auth.uid());
  end if;
  if not exists (
    select 1
    from public.profiles profile_row
    where profile_row.id = effective_assignee_id
      and profile_row.organization_id = current_organization_id
      and profile_row.active and profile_row.deleted_at is null
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        where assignment_row.organization_id = current_organization_id
          and assignment_row.user_id = profile_row.id and assignment_row.active
          and (
            assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
            or (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = booking_row.branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and booking_row.branch_id = any(assignment_row.selected_branch_ids)
            )
            or profile_row.id = auth.uid()
          )
      )
  ) then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_ASSIGNEE_INELIGIBLE'; end if;
  if target_vehicle_id is not null and not exists (
    select 1 from public.customer_vehicles vehicle_row
    where vehicle_row.id = target_vehicle_id
      and vehicle_row.organization_id = current_organization_id
      and vehicle_row.customer_id = booking_row.customer_id
  ) then raise exception using errcode = '23514', message = 'OPERATIONAL_CASE_VEHICLE_MISMATCH'; end if;

  initial_status := case normalized_department
    when 'FINANCE' then 'DOCUMENTS_PENDING'
    when 'INSURANCE' then 'QUOTE_PENDING'
    when 'RTO' then 'NEW'
    when 'EXCHANGE' then 'REQUESTED'
    when 'DELIVERY' then 'PLANNING'
  end;
  case normalized_department
    when 'FINANCE' then
      insert into public.finance_cases (
        organization_id, branch_id, booking_id, customer_id, assigned_user_id,
        status, priority, due_at, notes, created_by
      ) values (
        current_organization_id, booking_row.branch_id, booking_row.id,
        booking_row.customer_id, effective_assignee_id, initial_status,
        normalized_priority, target_due_at, normalized_notes, auth.uid()
      ) returning id into case_id;
    when 'INSURANCE' then
      insert into public.insurance_cases (
        organization_id, branch_id, booking_id, customer_id, vehicle_id,
        assigned_user_id, status, priority, due_at, notes, created_by
      ) values (
        current_organization_id, booking_row.branch_id, booking_row.id,
        booking_row.customer_id, target_vehicle_id, effective_assignee_id,
        initial_status, normalized_priority, target_due_at, normalized_notes, auth.uid()
      ) returning id into case_id;
    when 'RTO' then
      insert into public.rto_cases (
        organization_id, branch_id, booking_id, customer_id, vehicle_id,
        assigned_user_id, status, priority, due_at, notes, created_by
      ) values (
        current_organization_id, booking_row.branch_id, booking_row.id,
        booking_row.customer_id, target_vehicle_id, effective_assignee_id,
        initial_status, normalized_priority, target_due_at, normalized_notes, auth.uid()
      ) returning id into case_id;
    when 'EXCHANGE' then
      insert into public.exchange_cases (
        organization_id, branch_id, booking_id, customer_id, vehicle_id,
        assigned_user_id, status, priority, due_at, notes, created_by
      ) values (
        current_organization_id, booking_row.branch_id, booking_row.id,
        booking_row.customer_id, target_vehicle_id, effective_assignee_id,
        initial_status, normalized_priority, target_due_at, normalized_notes, auth.uid()
      ) returning id into case_id;
    when 'DELIVERY' then
      insert into public.delivery_cases (
        organization_id, branch_id, booking_id, customer_id, vehicle_id,
        assigned_user_id, status, priority, due_at, notes, created_by
      ) values (
        current_organization_id, booking_row.branch_id, booking_row.id,
        booking_row.customer_id, target_vehicle_id, effective_assignee_id,
        initial_status, normalized_priority, target_due_at, normalized_notes, auth.uid()
      ) returning id into case_id;
      insert into public.delivery_checklist_items (
        organization_id, delivery_id, category, item
      ) values
        (current_organization_id, case_id, 'DOCUMENTS', 'Customer and vehicle documents verified'),
        (current_organization_id, case_id, 'VEHICLE', 'Pre-delivery inspection completed'),
        (current_organization_id, case_id, 'VEHICLE', 'Accessories and fuel level verified'),
        (current_organization_id, case_id, 'CUSTOMER', 'Delivery date and time confirmed'),
        (current_organization_id, case_id, 'HANDOVER', 'Handover documents and keys prepared');
  end case;

  result := jsonb_build_object(
    'id', case_id, 'department', normalized_department, 'status', initial_status,
    'version', 1, 'assigned_user_id', effective_assignee_id, 'replayed', false
  );
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, booking_row.customer_id, booking_row.lead_id,
    normalized_department || '_CASE_CREATED', auth.uid(),
    jsonb_build_object('case_id', case_id, 'booking_id', booking_row.id)
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.created.' || lower(normalized_department),
    lower(normalized_department) || '_case', case_id::text, booking_row.branch_id,
    target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.update_operational_case(
  target_department text,
  target_case_id uuid,
  expected_version bigint,
  target_status text,
  target_patch jsonb,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  normalized_reason text := nullif(btrim(coalesce(target_reason, '')), '');
  normalized_patch jsonb := coalesce(target_patch, '{}'::jsonb);
  target_table text;
  resource_type text;
  current_payload jsonb;
  merged_payload jsonb;
  current_status text;
  current_version bigint;
  case_branch_id uuid;
  case_customer_id uuid;
  case_booking_id uuid;
  case_assignee_id uuid;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
  parsed_due_at timestamptz;
  parsed_amount numeric;
  parsed_secondary_amount numeric;
  parsed_timestamp timestamptz;
  parsed_second_timestamp timestamptz;
  parsed_date date;
  parsed_second_date date;
  parsed_signature_id uuid;
begin
  if target_case_id is null or expected_version is null or expected_version < 1
    or target_request_id is null
    or normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
    or not app_private.operational_case_status_valid(normalized_department, normalized_status)
    or jsonb_typeof(normalized_patch) <> 'object'
    or octet_length(normalized_patch::text) > 50000
    or char_length(coalesce(normalized_reason, '')) > 1000
  then raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_UPDATE'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(
      current_organization_id, normalized_department, 'MANAGE'
    )
  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_MANAGE_PERMISSION_REQUIRED'; end if;

  target_table := case normalized_department
    when 'FINANCE' then 'finance_cases'
    when 'INSURANCE' then 'insurance_cases'
    when 'RTO' then 'rto_cases'
    when 'EXCHANGE' then 'exchange_cases'
    when 'DELIVERY' then 'delivery_cases'
  end;
  resource_type := lower(normalized_department) || '_case';
  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'department', normalized_department, 'case_id', target_case_id,
    'expected_version', expected_version, 'status', normalized_status,
    'patch', normalized_patch, 'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.updated.' || lower(normalized_department),
    target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  execute format(
    'select to_jsonb(source_row) from public.%I source_row where source_row.id = $1 and source_row.organization_id = $2 and source_row.deleted_at is null for update',
    target_table
  ) into current_payload using target_case_id, current_organization_id;
  if current_payload is null then
    raise exception using errcode = 'P0002', message = 'OPERATIONAL_CASE_NOT_FOUND';
  end if;
  current_status := current_payload->>'status';
  current_version := (current_payload->>'version')::bigint;
  case_branch_id := (current_payload->>'branch_id')::uuid;
  case_customer_id := (current_payload->>'customer_id')::uuid;
  case_booking_id := nullif(current_payload->>'booking_id', '')::uuid;
  case_assignee_id := nullif(current_payload->>'assigned_user_id', '')::uuid;
  if not app_private.can_access_record(
    current_organization_id, case_branch_id, null, case_assignee_id
  ) or not app_private.can_access_customer(current_organization_id, case_customer_id)
  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_SCOPE_DENIED'; end if;
  if current_version <> expected_version then
    raise exception using errcode = '40001', message = 'OPERATIONAL_CASE_VERSION_CONFLICT';
  end if;
  if normalized_status <> current_status and not app_private.operational_case_transition_allowed(
    normalized_department, current_status, normalized_status
  ) then raise exception using errcode = '23514', message = 'INVALID_OPERATIONAL_CASE_TRANSITION'; end if;
  if normalized_status <> current_status and char_length(coalesce(normalized_reason, '')) < 3 then
    raise exception using errcode = '22023', message = 'OPERATIONAL_CASE_CHANGE_REASON_REQUIRED';
  end if;
  if normalized_status in ('REJECTED', 'CANCELLED')
    and char_length(coalesce(normalized_reason, '')) < 5
  then raise exception using errcode = '22023', message = 'OPERATIONAL_CASE_TERMINAL_REASON_REQUIRED'; end if;

  if normalized_department = 'FINANCE'
    and normalized_patch - array[
      'priority', 'due_at', 'notes', 'lender', 'application_reference',
      'approved_amount', 'disbursed_at'
    ] <> '{}'::jsonb
  then raise exception using errcode = '22023', message = 'INVALID_FINANCE_CASE_PATCH'; end if;
  if normalized_department = 'INSURANCE'
    and normalized_patch - array[
      'priority', 'due_at', 'notes', 'vehicle_id', 'insurer',
      'policy_number', 'policy_start', 'policy_end'
    ] <> '{}'::jsonb
  then raise exception using errcode = '22023', message = 'INVALID_INSURANCE_CASE_PATCH'; end if;
  if normalized_department = 'RTO'
    and normalized_patch - array[
      'priority', 'due_at', 'notes', 'vehicle_id', 'registration_number',
      'submitted_at', 'completed_at'
    ] <> '{}'::jsonb
  then raise exception using errcode = '22023', message = 'INVALID_RTO_CASE_PATCH'; end if;
  if normalized_department = 'EXCHANGE'
    and normalized_patch - array[
      'priority', 'due_at', 'notes', 'vehicle_id', 'estimated_value',
      'accepted_value', 'inspection', 'quoted_value'
    ] <> '{}'::jsonb
  then raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_CASE_PATCH'; end if;
  if normalized_department = 'DELIVERY'
    and normalized_patch - array[
      'priority', 'due_at', 'notes', 'vehicle_id', 'scheduled_at',
      'delivered_at', 'signature_file_id'
    ] <> '{}'::jsonb
  then raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CASE_PATCH'; end if;

  merged_payload := current_payload || normalized_patch || jsonb_build_object('status', normalized_status);
  if upper(coalesce(merged_payload->>'priority', '')) not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    or char_length(btrim(coalesce(merged_payload->>'notes', ''))) > 4000
  then raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_METADATA'; end if;
  begin
    parsed_due_at := nullif(merged_payload->>'due_at', '')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_DUE_AT';
  end;
  if parsed_due_at is not null
    and (parsed_due_at < now() - interval '1 year' or parsed_due_at > now() + interval '10 years')
  then raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_DUE_AT'; end if;

  if normalized_patch ? 'vehicle_id' then
    if normalized_department = 'FINANCE' then
      raise exception using errcode = '22023', message = 'INVALID_FINANCE_CASE_PATCH';
    end if;
    if normalized_patch->>'vehicle_id' is not null and not exists (
      select 1 from public.customer_vehicles vehicle_row
      where vehicle_row.organization_id = current_organization_id
        and vehicle_row.customer_id = case_customer_id
        and vehicle_row.id = (normalized_patch->>'vehicle_id')::uuid
    ) then raise exception using errcode = '23514', message = 'OPERATIONAL_CASE_VEHICLE_MISMATCH'; end if;
  end if;

  if normalized_department = 'FINANCE' then
    begin
      parsed_amount := nullif(merged_payload->>'approved_amount', '')::numeric;
      parsed_timestamp := nullif(merged_payload->>'disbursed_at', '')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_FINANCE_CASE_DETAILS';
    end;
    if char_length(btrim(coalesce(merged_payload->>'lender', ''))) > 160
      or char_length(btrim(coalesce(merged_payload->>'application_reference', ''))) > 120
      or (parsed_amount is not null and parsed_amount not between 0 and 10000000000)
      or (normalized_status = 'APPLICATION_SUBMITTED' and (
        char_length(btrim(coalesce(merged_payload->>'lender', ''))) < 2
        or char_length(btrim(coalesce(merged_payload->>'application_reference', ''))) < 2
      ))
      or (normalized_status in ('APPROVED', 'DISBURSED') and parsed_amount is null)
      or (normalized_status = 'DISBURSED' and parsed_timestamp is null)
    then raise exception using errcode = '22023', message = 'INVALID_FINANCE_CASE_DETAILS'; end if;
    if normalized_status in ('APPLICATION_SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'DISBURSED')
      and not exists (
        select 1 from public.object_files file_row
        where file_row.organization_id = current_organization_id
          and file_row.resource_type = 'finance_case'
          and file_row.resource_id = target_case_id
          and file_row.deleted_at is null
      )
    then raise exception using errcode = '23514', message = 'FINANCE_CASE_DOCUMENT_REQUIRED'; end if;
    update public.finance_cases set
      status = normalized_status,
      priority = upper(merged_payload->>'priority'),
      due_at = parsed_due_at,
      notes = nullif(btrim(coalesce(merged_payload->>'notes', '')), ''),
      lender = nullif(btrim(coalesce(merged_payload->>'lender', '')), ''),
      application_reference = nullif(btrim(coalesce(merged_payload->>'application_reference', '')), ''),
      approved_amount = parsed_amount,
      disbursed_at = parsed_timestamp,
      version = version + 1, updated_at = now()
    where id = target_case_id and organization_id = current_organization_id;
  elsif normalized_department = 'INSURANCE' then
    begin
      parsed_date := nullif(merged_payload->>'policy_start', '')::date;
      parsed_second_date := nullif(merged_payload->>'policy_end', '')::date;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_INSURANCE_CASE_DETAILS';
    end;
    if char_length(btrim(coalesce(merged_payload->>'insurer', ''))) > 160
      or char_length(btrim(coalesce(merged_payload->>'policy_number', ''))) > 120
      or (parsed_date is not null and parsed_second_date is not null and parsed_second_date < parsed_date)
      or (normalized_status in ('QUOTE_SHARED', 'CUSTOMER_ACCEPTED', 'POLICY_ISSUED')
        and char_length(btrim(coalesce(merged_payload->>'insurer', ''))) < 2)
      or (normalized_status = 'POLICY_ISSUED' and (
        char_length(btrim(coalesce(merged_payload->>'policy_number', ''))) < 2
        or parsed_date is null or parsed_second_date is null
      ))
    then raise exception using errcode = '22023', message = 'INVALID_INSURANCE_CASE_DETAILS'; end if;
    if normalized_status = 'POLICY_ISSUED' and not exists (
      select 1 from public.object_files file_row
      where file_row.organization_id = current_organization_id
        and file_row.resource_type = 'insurance_case'
        and file_row.resource_id = target_case_id
        and file_row.deleted_at is null
    ) then raise exception using errcode = '23514', message = 'INSURANCE_POLICY_DOCUMENT_REQUIRED'; end if;
    update public.insurance_cases set
      status = normalized_status,
      priority = upper(merged_payload->>'priority'), due_at = parsed_due_at,
      notes = nullif(btrim(coalesce(merged_payload->>'notes', '')), ''),
      vehicle_id = nullif(merged_payload->>'vehicle_id', '')::uuid,
      insurer = nullif(btrim(coalesce(merged_payload->>'insurer', '')), ''),
      policy_number = nullif(btrim(coalesce(merged_payload->>'policy_number', '')), ''),
      policy_start = parsed_date, policy_end = parsed_second_date,
      version = version + 1, updated_at = now()
    where id = target_case_id and organization_id = current_organization_id;
  elsif normalized_department = 'RTO' then
    begin
      parsed_timestamp := nullif(merged_payload->>'submitted_at', '')::timestamptz;
      parsed_second_timestamp := nullif(merged_payload->>'completed_at', '')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_RTO_CASE_DETAILS';
    end;
    if char_length(btrim(coalesce(merged_payload->>'registration_number', ''))) > 24
      or (normalized_status in ('SUBMITTED', 'IN_PROCESS', 'REGISTERED') and parsed_timestamp is null)
      or (normalized_status = 'REGISTERED' and (
        char_length(btrim(coalesce(merged_payload->>'registration_number', ''))) < 4
        or parsed_second_timestamp is null
      ))
      or (parsed_timestamp is not null and parsed_second_timestamp is not null
        and parsed_second_timestamp < parsed_timestamp)
    then raise exception using errcode = '22023', message = 'INVALID_RTO_CASE_DETAILS'; end if;
    if normalized_status in ('SUBMITTED', 'IN_PROCESS', 'REGISTERED') and not exists (
      select 1 from public.object_files file_row
      where file_row.organization_id = current_organization_id
        and file_row.resource_type = 'rto_case'
        and file_row.resource_id = target_case_id
        and file_row.deleted_at is null
    ) then raise exception using errcode = '23514', message = 'RTO_CASE_DOCUMENT_REQUIRED'; end if;
    update public.rto_cases set
      status = normalized_status,
      priority = upper(merged_payload->>'priority'), due_at = parsed_due_at,
      notes = nullif(btrim(coalesce(merged_payload->>'notes', '')), ''),
      vehicle_id = nullif(merged_payload->>'vehicle_id', '')::uuid,
      registration_number = nullif(upper(btrim(coalesce(merged_payload->>'registration_number', ''))), ''),
      submitted_at = parsed_timestamp, completed_at = parsed_second_timestamp,
      version = version + 1, updated_at = now()
    where id = target_case_id and organization_id = current_organization_id;
  elsif normalized_department = 'EXCHANGE' then
    begin
      parsed_amount := nullif(merged_payload->>'estimated_value', '')::numeric;
      parsed_secondary_amount := nullif(merged_payload->>'accepted_value', '')::numeric;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_CASE_DETAILS';
    end;
    if (parsed_amount is not null and parsed_amount not between 0 and 10000000000)
      or (parsed_secondary_amount is not null and parsed_secondary_amount not between 0 and 10000000000)
      or (normalized_status in ('EVALUATED', 'OFFERED', 'ACCEPTED') and parsed_amount is null)
      or (normalized_status = 'ACCEPTED' and parsed_secondary_amount is null)
    then raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_CASE_DETAILS'; end if;
    if normalized_patch ? 'inspection' or normalized_patch ? 'quoted_value' then
      if jsonb_typeof(normalized_patch->'inspection') <> 'object'
        or octet_length((normalized_patch->'inspection')::text) > 20000
      then raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_EVALUATION'; end if;
      begin
        parsed_amount := (normalized_patch->>'quoted_value')::numeric;
      exception when others then
        raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_EVALUATION';
      end;
      if parsed_amount not between 0 and 10000000000 then
        raise exception using errcode = '22023', message = 'INVALID_EXCHANGE_EVALUATION';
      end if;
      insert into public.exchange_evaluations (
        organization_id, exchange_case_id, evaluator_id, inspection, quoted_value
      ) values (
        current_organization_id, target_case_id, auth.uid(),
        normalized_patch->'inspection', parsed_amount
      );
    end if;
    update public.exchange_cases set
      status = normalized_status,
      priority = upper(merged_payload->>'priority'), due_at = parsed_due_at,
      notes = nullif(btrim(coalesce(merged_payload->>'notes', '')), ''),
      vehicle_id = nullif(merged_payload->>'vehicle_id', '')::uuid,
      estimated_value = nullif(merged_payload->>'estimated_value', '')::numeric,
      accepted_value = parsed_secondary_amount,
      version = version + 1, updated_at = now()
    where id = target_case_id and organization_id = current_organization_id;
  else
    begin
      parsed_timestamp := nullif(merged_payload->>'scheduled_at', '')::timestamptz;
      parsed_second_timestamp := nullif(merged_payload->>'delivered_at', '')::timestamptz;
      parsed_signature_id := nullif(merged_payload->>'signature_file_id', '')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CASE_DETAILS';
    end;
    if normalized_status in ('READY', 'SCHEDULED', 'DELIVERED') and exists (
      select 1 from public.delivery_checklist_items item_row
      where item_row.organization_id = current_organization_id
        and item_row.delivery_id = target_case_id and not item_row.completed
    ) then raise exception using errcode = '23514', message = 'DELIVERY_CHECKLIST_INCOMPLETE'; end if;
    if normalized_status in ('READY', 'SCHEDULED', 'DELIVERED') and not exists (
      select 1 from public.delivery_checklist_items item_row
      where item_row.organization_id = current_organization_id
        and item_row.delivery_id = target_case_id
    ) then raise exception using errcode = '23514', message = 'DELIVERY_CHECKLIST_REQUIRED'; end if;
    if normalized_status in ('SCHEDULED', 'DELIVERED') and parsed_timestamp is null then
      raise exception using errcode = '22023', message = 'DELIVERY_SCHEDULE_REQUIRED';
    end if;
    if normalized_status = 'DELIVERED' and (
      parsed_second_timestamp is null or parsed_signature_id is null
    ) then raise exception using errcode = '22023', message = 'DELIVERY_EVIDENCE_REQUIRED'; end if;
    if parsed_timestamp is not null and parsed_second_timestamp is not null
      and parsed_second_timestamp < parsed_timestamp
    then raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CASE_DETAILS'; end if;
    if parsed_signature_id is not null and not exists (
      select 1 from public.object_files file_row
      where file_row.id = parsed_signature_id
        and file_row.organization_id = current_organization_id
        and file_row.resource_type = 'delivery_case'
        and file_row.resource_id = target_case_id and file_row.deleted_at is null
    ) then raise exception using errcode = '23514', message = 'DELIVERY_SIGNATURE_MISMATCH'; end if;
    update public.delivery_cases set
      status = normalized_status,
      priority = upper(merged_payload->>'priority'), due_at = parsed_due_at,
      notes = nullif(btrim(coalesce(merged_payload->>'notes', '')), ''),
      vehicle_id = nullif(merged_payload->>'vehicle_id', '')::uuid,
      scheduled_at = parsed_timestamp, delivered_at = parsed_second_timestamp,
      signature_file_id = parsed_signature_id,
      version = version + 1, updated_at = now()
    where id = target_case_id and organization_id = current_organization_id;
  end if;

  result := jsonb_build_object(
    'id', target_case_id, 'department', normalized_department,
    'status', normalized_status, 'version', current_version + 1, 'replayed', false
  );
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  )
  select current_organization_id, case_customer_id, booking_row.lead_id,
    normalized_department || '_CASE_UPDATED', auth.uid(),
    jsonb_build_object(
      'case_id', target_case_id, 'from_status', current_status,
      'to_status', normalized_status, 'reason', normalized_reason
    )
  from public.bookings booking_row
  where booking_row.organization_id = current_organization_id and booking_row.id = case_booking_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.updated.' || lower(normalized_department),
    resource_type, target_case_id::text, case_branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', fingerprint, 'result', result, 'from_status', current_status,
      'to_status', normalized_status, 'reason', normalized_reason,
      'changed_fields', (select coalesce(
        jsonb_agg(changed_field.key order by changed_field.key), '[]'::jsonb
      ) from jsonb_object_keys(normalized_patch) as changed_field(key))
    )
  );
  return result;
end;
$$;

create or replace function public.get_operational_case_detail(
  target_department text,
  target_case_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_department text := upper(btrim(coalesce(target_department, '')));
  record_data jsonb;
  documents jsonb;
  checklist jsonb;
begin
  if target_case_id is null
    or normalized_department not in ('FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY')
  then raise exception using errcode = '22023', message = 'INVALID_OPERATIONAL_CASE_DETAIL_QUERY'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(
      current_organization_id, normalized_department, 'VIEW'
    )
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_VIEW_PERMISSION_REQUIRED'; end if;
  select to_jsonb(case_row) into record_data
  from app_private.operational_case_rows(current_organization_id, normalized_department) case_row
  where case_row.id = target_case_id;
  if record_data is null then
    raise exception using errcode = 'P0002', message = 'OPERATIONAL_CASE_NOT_FOUND';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', file_row.id,
      'file_name', coalesce(file_row.original_file_name, 'Document'),
      'mime_type', file_row.mime_type,
      'size_bytes', file_row.size_bytes,
      'created_at', file_row.created_at
    ) order by file_row.created_at desc, file_row.id), '[]'::jsonb)
    into documents
  from public.object_files file_row
  where file_row.organization_id = current_organization_id
    and file_row.resource_type = lower(normalized_department) || '_case'
    and file_row.resource_id = target_case_id and file_row.deleted_at is null;
  if normalized_department = 'DELIVERY' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', item_row.id,
        'category', item_row.category,
        'item', item_row.item,
        'completed', item_row.completed,
        'completed_by', item_row.completed_by,
        'completed_at', item_row.completed_at,
        'version', item_row.version
      ) order by item_row.category, item_row.created_at, item_row.id), '[]'::jsonb)
      into checklist
    from public.delivery_checklist_items item_row
    where item_row.organization_id = current_organization_id
      and item_row.delivery_id = target_case_id;
  else
    checklist := '[]'::jsonb;
  end if;
  return record_data || jsonb_build_object('documents', documents, 'checklist', checklist);
end;
$$;

create or replace function public.set_delivery_checklist_item(
  target_item_id uuid,
  expected_version bigint,
  target_completed boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  item_row public.delivery_checklist_items%rowtype;
  case_row public.delivery_cases%rowtype;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_item_id is null or expected_version is null or expected_version < 1
    or target_completed is null or target_request_id is null
  then raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CHECKLIST_UPDATE'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(current_organization_id, 'DELIVERY', 'MANAGE')
  then raise exception using errcode = '42501', message = 'DELIVERY_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'item_id', target_item_id, 'expected_version', expected_version,
    'completed', target_completed
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.delivery_checklist.updated', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into item_row
  from public.delivery_checklist_items source_row
  where source_row.id = target_item_id and source_row.organization_id = current_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'DELIVERY_CHECKLIST_ITEM_NOT_FOUND'; end if;
  select * into case_row
  from public.delivery_cases source_row
  where source_row.id = item_row.delivery_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'DELIVERY_CASE_NOT_FOUND'; end if;
  if not app_private.can_access_record(
    case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
  ) or not app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  then raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_SCOPE_DENIED'; end if;
  if case_row.status not in ('PLANNING', 'CHECKLIST_PENDING') then
    raise exception using errcode = '23514', message = 'DELIVERY_CHECKLIST_LOCKED';
  end if;
  if item_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'DELIVERY_CHECKLIST_VERSION_CONFLICT';
  end if;
  update public.delivery_checklist_items set
    completed = target_completed,
    completed_by = case when target_completed then auth.uid() else null end,
    completed_at = case when target_completed then now() else null end,
    version = version + 1,
    updated_at = now()
  where id = item_row.id
  returning * into item_row;
  if case_row.status = 'PLANNING' then
    update public.delivery_cases set status = 'CHECKLIST_PENDING',
      version = version + 1, updated_at = now()
    where id = case_row.id returning * into case_row;
  end if;
  result := jsonb_build_object(
    'id', item_row.id, 'delivery_id', case_row.id,
    'completed', item_row.completed, 'version', item_row.version,
    'case_version', case_row.version, 'case_status', case_row.status, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.delivery_checklist.updated',
    'delivery_case', case_row.id::text, case_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'item_id', item_row.id)
  );
  return result;
end;
$$;

-- Extend the private invalidation topic without changing payload semantics.
create or replace function app_private.realtime_topic_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_topic text;
  topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(
    current_topic,
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales|operations)$'
  );
  return case when topic_match is null then null else topic_match[1]::uuid end;
exception when others then
  return null;
end;
$$;

create or replace function app_private.realtime_topic_resource()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_topic text;
  topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(
    current_topic,
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales|operations)$'
  );
  return case when topic_match is null then null else topic_match[1] end;
exception when others then
  return null;
end;
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists crm_tenant_broadcast_read on realtime.messages';
    execute $policy$
      create policy crm_tenant_broadcast_read on realtime.messages
      for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and app_private.can_access_organization(app_private.realtime_topic_organization())
        and case app_private.realtime_topic_resource()
          when 'leads' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'lead.view'
          )
          when 'customers' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'customer.view'
          )
          when 'communications' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'message.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'call.view')
          when 'work' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'followup.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'appointment.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'task.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'test_drive.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'test_drive.manage')
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'integration.view'
          )
          when 'support' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'support.request')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'support.approve')
          when 'administration' then
            app_private.tenant_user_mode_allowed(auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'branch.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'team.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'user.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'role.manage')
          when 'inventory' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'inventory.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'inventory.stock_check')
          when 'sales' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'booking.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'booking.manage')
          when 'operations' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'finance.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'finance.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'insurance.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'insurance.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'rto.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'rto.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'exchange.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'exchange.manage')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'delivery.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'delivery.manage')
          else false
        end
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_finance_cases_operations_invalidate on public.finance_cases;
create trigger realtime_finance_cases_operations_invalidate
after insert or update on public.finance_cases
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_insurance_cases_operations_invalidate on public.insurance_cases;
create trigger realtime_insurance_cases_operations_invalidate
after insert or update on public.insurance_cases
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_rto_cases_operations_invalidate on public.rto_cases;
create trigger realtime_rto_cases_operations_invalidate
after insert or update on public.rto_cases
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_exchange_cases_operations_invalidate on public.exchange_cases;
create trigger realtime_exchange_cases_operations_invalidate
after insert or update on public.exchange_cases
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_exchange_evaluations_operations_invalidate on public.exchange_evaluations;
create trigger realtime_exchange_evaluations_operations_invalidate
after insert or update on public.exchange_evaluations
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_delivery_cases_operations_invalidate on public.delivery_cases;
create trigger realtime_delivery_cases_operations_invalidate
after insert or update on public.delivery_cases
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_delivery_checklist_operations_invalidate on public.delivery_checklist_items;
create trigger realtime_delivery_checklist_operations_invalidate
after insert or update on public.delivery_checklist_items
for each row execute function app_private.broadcast_tenant_invalidation('operations');
drop trigger if exists realtime_object_files_operations_invalidate on public.object_files;
create trigger realtime_object_files_operations_invalidate
after insert or update on public.object_files
for each row execute function app_private.broadcast_tenant_invalidation('operations');

-- Every direct row read applies module permission plus organization, branch,
-- record-owner and customer scope. Mutations remain RPC-only below.
drop policy if exists finance_cases_read on public.finance_cases;
create policy finance_cases_read on public.finance_cases for select to authenticated using (
  deleted_at is null
  and app_private.operational_case_permission(organization_id, 'FINANCE', 'VIEW')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, null, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
);
drop policy if exists insurance_cases_read on public.insurance_cases;
create policy insurance_cases_read on public.insurance_cases for select to authenticated using (
  deleted_at is null
  and app_private.operational_case_permission(organization_id, 'INSURANCE', 'VIEW')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, null, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
);
drop policy if exists rto_cases_read on public.rto_cases;
create policy rto_cases_read on public.rto_cases for select to authenticated using (
  deleted_at is null
  and app_private.operational_case_permission(organization_id, 'RTO', 'VIEW')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, null, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
);
drop policy if exists exchange_cases_read on public.exchange_cases;
create policy exchange_cases_read on public.exchange_cases for select to authenticated using (
  deleted_at is null
  and app_private.operational_case_permission(organization_id, 'EXCHANGE', 'VIEW')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, null, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
);
drop policy if exists delivery_cases_read on public.delivery_cases;
create policy delivery_cases_read on public.delivery_cases for select to authenticated using (
  deleted_at is null
  and app_private.operational_case_permission(organization_id, 'DELIVERY', 'VIEW')
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(organization_id, branch_id, null, assigned_user_id)
  and app_private.can_access_customer(organization_id, customer_id)
);

revoke insert, update, delete, truncate on public.finance_cases from anon, authenticated;
revoke insert, update, delete, truncate on public.insurance_cases from anon, authenticated;
revoke insert, update, delete, truncate on public.rto_cases from anon, authenticated;
revoke insert, update, delete, truncate on public.exchange_cases from anon, authenticated;
revoke insert, update, delete, truncate on public.exchange_evaluations from anon, authenticated;
revoke insert, update, delete, truncate on public.delivery_cases from anon, authenticated;
revoke insert, update, delete, truncate on public.delivery_checklist_items from anon, authenticated;
revoke insert, update, delete, truncate on public.finance_case_documents from anon, authenticated;
revoke insert, update, delete, truncate on public.insurance_case_documents from anon, authenticated;
revoke insert, update, delete, truncate on public.rto_case_documents from anon, authenticated;

alter table public.finance_cases validate constraint finance_cases_workflow_check;
alter table public.insurance_cases validate constraint insurance_cases_workflow_check;
alter table public.rto_cases validate constraint rto_cases_workflow_check;
alter table public.exchange_cases validate constraint exchange_cases_workflow_check;
alter table public.delivery_cases validate constraint delivery_cases_workflow_check;

alter table public.finance_cases validate constraint finance_cases_branch_org_fk;
alter table public.finance_cases validate constraint finance_cases_booking_org_fk;
alter table public.finance_cases validate constraint finance_cases_customer_org_fk;
alter table public.finance_cases validate constraint finance_cases_assignee_org_fk;
alter table public.finance_cases validate constraint finance_cases_creator_org_fk;
alter table public.insurance_cases validate constraint insurance_cases_branch_org_fk;
alter table public.insurance_cases validate constraint insurance_cases_booking_org_fk;
alter table public.insurance_cases validate constraint insurance_cases_customer_org_fk;
alter table public.insurance_cases validate constraint insurance_cases_assignee_org_fk;
alter table public.insurance_cases validate constraint insurance_cases_creator_org_fk;
alter table public.insurance_cases validate constraint insurance_cases_vehicle_org_fk;
alter table public.rto_cases validate constraint rto_cases_branch_org_fk;
alter table public.rto_cases validate constraint rto_cases_booking_org_fk;
alter table public.rto_cases validate constraint rto_cases_customer_org_fk;
alter table public.rto_cases validate constraint rto_cases_assignee_org_fk;
alter table public.rto_cases validate constraint rto_cases_creator_org_fk;
alter table public.rto_cases validate constraint rto_cases_vehicle_org_fk;
alter table public.exchange_cases validate constraint exchange_cases_branch_org_fk;
alter table public.exchange_cases validate constraint exchange_cases_booking_org_fk;
alter table public.exchange_cases validate constraint exchange_cases_customer_org_fk;
alter table public.exchange_cases validate constraint exchange_cases_assignee_org_fk;
alter table public.exchange_cases validate constraint exchange_cases_creator_org_fk;
alter table public.exchange_cases validate constraint exchange_cases_vehicle_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_branch_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_booking_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_customer_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_assignee_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_creator_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_vehicle_org_fk;
alter table public.delivery_cases validate constraint delivery_cases_signature_org_fk;
alter table public.exchange_evaluations validate constraint exchange_evaluations_case_org_fk;
alter table public.exchange_evaluations validate constraint exchange_evaluations_evaluator_org_fk;
alter table public.delivery_checklist_items validate constraint delivery_checklist_case_org_fk;
alter table public.delivery_checklist_items validate constraint delivery_checklist_actor_org_fk;
alter table public.finance_case_documents validate constraint finance_case_documents_case_org_fk;
alter table public.finance_case_documents validate constraint finance_case_documents_file_org_fk;
alter table public.insurance_case_documents validate constraint insurance_case_documents_case_org_fk;
alter table public.insurance_case_documents validate constraint insurance_case_documents_file_org_fk;
alter table public.rto_case_documents validate constraint rto_case_documents_case_org_fk;
alter table public.rto_case_documents validate constraint rto_case_documents_file_org_fk;

revoke all on function public.get_operational_case_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) from public, anon;
grant execute on function public.get_operational_case_workspace_page(
  text, text, text, date, date, integer, integer, text, text
) to authenticated;
revoke all on function public.get_operational_case_booking_options(text, text, integer)
  from public, anon;
grant execute on function public.get_operational_case_booking_options(text, text, integer)
  to authenticated;
revoke all on function public.create_operational_case(
  text, uuid, uuid, uuid, text, timestamptz, text, uuid
) from public, anon;
grant execute on function public.create_operational_case(
  text, uuid, uuid, uuid, text, timestamptz, text, uuid
) to authenticated;
revoke all on function public.update_operational_case(
  text, uuid, bigint, text, jsonb, text, uuid
) from public, anon;
grant execute on function public.update_operational_case(
  text, uuid, bigint, text, jsonb, text, uuid
) to authenticated;
revoke all on function public.get_operational_case_detail(text, uuid) from public, anon;
grant execute on function public.get_operational_case_detail(text, uuid) to authenticated;
revoke all on function public.set_delivery_checklist_item(uuid, bigint, boolean, uuid)
  from public, anon;
grant execute on function public.set_delivery_checklist_item(uuid, bigint, boolean, uuid)
  to authenticated;

revoke all on function app_private.apply_default_operational_case_permissions()
  from public, anon, authenticated;
revoke all on function app_private.operational_case_permission(uuid, text, text)
  from public, anon, authenticated;
revoke all on function app_private.operational_case_status_valid(text, text)
  from public, anon, authenticated;
revoke all on function app_private.operational_case_transition_allowed(text, text, text)
  from public, anon, authenticated;
revoke all on function app_private.operational_case_terminal(text, text)
  from public, anon, authenticated;
revoke all on function app_private.operational_case_request_fingerprint(jsonb)
  from public, anon, authenticated;
revoke all on function app_private.replay_operational_case_request(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function app_private.operational_case_rows(uuid, text)
  from public, anon, authenticated;

commit;
