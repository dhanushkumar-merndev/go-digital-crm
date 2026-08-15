begin;

insert into public.permissions (permission_key, module, description)
values
  ('quotation.view', 'quotations', 'View quotations within authorized data scope'),
  ('quotation.manage', 'quotations', 'Manage quotations within authorized data scope'),
  ('booking.view', 'bookings', 'View bookings within authorized data scope'),
  ('booking.manage', 'bookings', 'Manage bookings within authorized data scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row on (
  role_row.organization_id is not null
  and role_row.system_role
  and (
    role_row.role_key in ('client_admin', 'system_administrator')
    or (
      role_row.role_key in ('business_owner', 'gm_sales')
      and permission_row.permission_key in ('quotation.view', 'booking.view')
    )
    or (
      role_row.role_key in ('showroom_manager', 'team_manager', 'sales_consultant')
      and permission_row.permission_key in (
        'quotation.view', 'quotation.manage', 'booking.view', 'booking.manage'
      )
    )
  )
)
where permission_row.permission_key in (
  'quotation.view', 'quotation.manage', 'booking.view', 'booking.manage'
)
on conflict do nothing;

alter table public.quotations
  add column if not exists version bigint not null default 1;
alter table public.quotation_items
  add column if not exists deleted_at timestamptz,
  add column if not exists created_at timestamptz not null default now();
alter table public.bookings
  add column if not exists version bigint not null default 1;

alter table public.quotations drop constraint if exists quotations_status_check;
alter table public.quotations
  add constraint quotations_status_check
  check (status in (
    'DRAFT', 'PENDING_APPROVAL', 'SENT', 'ACCEPTED',
    'REJECTED', 'EXPIRED', 'CONVERTED'
  )) not valid;
alter table public.quotations drop constraint if exists quotations_approval_status_check;
alter table public.quotations
  add constraint quotations_approval_status_check
  check (approval_status is null or approval_status in (
    'NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'
  )) not valid;
alter table public.quotations drop constraint if exists quotations_amount_check;
alter table public.quotations
  add constraint quotations_amount_check
  check (total_amount >= 0 and total_amount <= 10000000000) not valid;
alter table public.quotations drop constraint if exists quotations_version_check;
alter table public.quotations
  add constraint quotations_version_check
  check (version > 0 and current_version > 0) not valid;

alter table public.quotation_items drop constraint if exists quotation_items_type_check;
alter table public.quotation_items
  add constraint quotation_items_type_check
  check (item_type in ('VEHICLE', 'ACCESSORY', 'INSURANCE', 'SERVICE', 'DISCOUNT', 'OTHER'))
  not valid;
alter table public.quotation_items drop constraint if exists quotation_items_amount_check;
alter table public.quotation_items
  add constraint quotation_items_amount_check
  check (
    quantity > 0 and quantity <= 1000
    and unit_price >= 0 and unit_price <= 1000000000
    and adjustment between -1000000000 and 1000000000
    and char_length(btrim(description)) between 1 and 240
  ) not valid;

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in (
    'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED',
    'READY_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'
  )) not valid;
alter table public.bookings drop constraint if exists bookings_amount_check;
alter table public.bookings
  add constraint bookings_amount_check
  check (
    booking_amount > 0 and booking_amount <= 10000000000
    and (total_value is null or (total_value >= booking_amount and total_value <= 10000000000))
    and version > 0
  ) not valid;

create unique index if not exists quotations_org_id_unique_idx
  on public.quotations (organization_id, id);
create unique index if not exists bookings_org_id_unique_idx
  on public.bookings (organization_id, id);
create index if not exists quotations_workspace_idx
  on public.quotations (organization_id, branch_id, status, updated_at desc, id desc);
create index if not exists quotations_owner_workspace_idx
  on public.quotations (organization_id, assigned_user_id, status, updated_at desc, id desc);
create index if not exists quotation_items_active_idx
  on public.quotation_items (organization_id, quotation_id, created_at, id)
  where deleted_at is null;
create index if not exists bookings_workspace_idx
  on public.bookings (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists bookings_owner_workspace_idx
  on public.bookings (organization_id, assigned_user_id, status, updated_at desc, id desc)
  where deleted_at is null;
create index if not exists bookings_expected_delivery_idx
  on public.bookings (organization_id, expected_delivery_date, id)
  where deleted_at is null and status not in ('DELIVERED', 'CANCELLED');
create unique index if not exists approvals_pending_quotation_unique_idx
  on public.approvals (organization_id, resource_id)
  where resource_type = 'quotation' and status = 'PENDING';

alter table public.quotations drop constraint if exists quotations_branch_org_fk;
alter table public.quotations
  add constraint quotations_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.quotations drop constraint if exists quotations_team_branch_org_fk;
alter table public.quotations
  add constraint quotations_team_branch_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.quotations drop constraint if exists quotations_customer_org_fk;
alter table public.quotations
  add constraint quotations_customer_org_fk foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.quotations drop constraint if exists quotations_lead_org_fk;
alter table public.quotations
  add constraint quotations_lead_org_fk foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.quotations drop constraint if exists quotations_assignee_org_fk;
alter table public.quotations
  add constraint quotations_assignee_org_fk foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;

alter table public.quotation_items drop constraint if exists quotation_items_quotation_org_fk;
alter table public.quotation_items
  add constraint quotation_items_quotation_org_fk foreign key (organization_id, quotation_id)
  references public.quotations (organization_id, id) not valid;
alter table public.quotation_versions drop constraint if exists quotation_versions_quotation_org_fk;
alter table public.quotation_versions
  add constraint quotation_versions_quotation_org_fk foreign key (organization_id, quotation_id)
  references public.quotations (organization_id, id) not valid;

alter table public.bookings drop constraint if exists bookings_branch_org_fk;
alter table public.bookings
  add constraint bookings_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.bookings drop constraint if exists bookings_team_branch_org_fk;
alter table public.bookings
  add constraint bookings_team_branch_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.bookings drop constraint if exists bookings_customer_org_fk;
alter table public.bookings
  add constraint bookings_customer_org_fk foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.bookings drop constraint if exists bookings_lead_org_fk;
alter table public.bookings
  add constraint bookings_lead_org_fk foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.bookings drop constraint if exists bookings_quotation_org_fk;
alter table public.bookings
  add constraint bookings_quotation_org_fk foreign key (organization_id, quotation_id)
  references public.quotations (organization_id, id) not valid;
alter table public.bookings drop constraint if exists bookings_assignee_org_fk;
alter table public.bookings
  add constraint bookings_assignee_org_fk foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.booking_status_history drop constraint if exists booking_history_booking_org_fk;
alter table public.booking_status_history
  add constraint booking_history_booking_org_fk foreign key (organization_id, booking_id)
  references public.bookings (organization_id, id) not valid;

create or replace function app_private.can_access_quotation(
  target_organization_id uuid,
  target_quotation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quotations quotation_row
    where quotation_row.id = target_quotation_id
      and quotation_row.organization_id = target_organization_id
      and (
        app_private.has_permission(target_organization_id, 'quotation.view')
        or app_private.has_permission(target_organization_id, 'quotation.manage')
      )
      and app_private.can_access_record(
        quotation_row.organization_id,
        quotation_row.branch_id,
        quotation_row.team_id,
        quotation_row.assigned_user_id
      )
  );
$$;

create or replace function app_private.can_access_booking(
  target_organization_id uuid,
  target_booking_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bookings booking_row
    where booking_row.id = target_booking_id
      and booking_row.organization_id = target_organization_id
      and booking_row.deleted_at is null
      and (
        app_private.has_permission(target_organization_id, 'booking.view')
        or app_private.has_permission(target_organization_id, 'booking.manage')
      )
      and app_private.can_access_record(
        booking_row.organization_id,
        booking_row.branch_id,
        booking_row.team_id,
        booking_row.assigned_user_id
      )
  );
$$;

drop policy if exists quotation_items_read on public.quotation_items;
create policy quotation_items_read on public.quotation_items
for select to authenticated using (
  deleted_at is null
  and app_private.can_access_quotation(organization_id, quotation_id)
);

create or replace function app_private.sales_request_fingerprint(payload jsonb)
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

create or replace function app_private.replay_sales_request(
  target_organization_id uuid,
  target_action text,
  target_request_id uuid,
  target_fingerprint text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  audit_metadata jsonb;
begin
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  select audit_row.metadata into audit_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = target_action
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if found then
    if audit_metadata->>'request_fingerprint' is distinct from target_fingerprint then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(audit_metadata->'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;
  return null;
end;
$$;

create or replace function public.get_quotation_workspace_page(
  target_search text default '',
  target_status text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  search_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_status not in (
      'ALL', 'DRAFT', 'PENDING_APPROVAL', 'SENT', 'ACCEPTED',
      'REJECTED', 'EXPIRED', 'CONVERTED'
    )
    or target_sort not in (
      'updated:desc', 'updated:asc', 'amount:desc', 'amount:asc',
      'customer:asc', 'customer:desc'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not (
    app_private.has_permission(current_organization_id, 'quotation.view')
    or app_private.has_permission(current_organization_id, 'quotation.manage')
  ) then
    raise exception using errcode = '42501', message = 'QUOTATION_VIEW_PERMISSION_REQUIRED';
  end if;

  with authorized as materialized (
    select
      quotation_row.id,
      quotation_row.organization_id,
      quotation_row.branch_id,
      quotation_row.team_id,
      quotation_row.customer_id,
      quotation_row.lead_id,
      quotation_row.assigned_user_id,
      quotation_row.quotation_number,
      quotation_row.status,
      quotation_row.current_version,
      quotation_row.version,
      quotation_row.total_amount,
      coalesce(quotation_row.approval_status, 'NOT_REQUIRED') as approval_status,
      quotation_row.created_at,
      quotation_row.updated_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      lead_row.interested_model,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'item_type', item_row.item_type,
          'description', item_row.description,
          'quantity', item_row.quantity,
          'unit_price', item_row.unit_price,
          'adjustment', item_row.adjustment
        ) order by item_row.created_at, item_row.id)
        from public.quotation_items item_row
        where item_row.organization_id = quotation_row.organization_id
          and item_row.quotation_id = quotation_row.id
          and item_row.deleted_at is null
      ), '[]'::jsonb) as items
    from public.quotations quotation_row
    join public.customers customer_row
      on customer_row.id = quotation_row.customer_id
     and customer_row.organization_id = quotation_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = quotation_row.branch_id
     and branch_row.organization_id = quotation_row.organization_id
    left join public.teams team_row
      on team_row.id = quotation_row.team_id
     and team_row.organization_id = quotation_row.organization_id
    join public.profiles profile_row
      on profile_row.id = quotation_row.assigned_user_id
     and profile_row.organization_id = quotation_row.organization_id
    left join public.leads lead_row
      on lead_row.id = quotation_row.lead_id
     and lead_row.organization_id = quotation_row.organization_id
    where quotation_row.organization_id = current_organization_id
      and app_private.can_access_record(
        quotation_row.organization_id,
        quotation_row.branch_id,
        quotation_row.team_id,
        quotation_row.assigned_user_id
      )
      and (target_status = 'ALL' or quotation_row.status = target_status)
      and (
        normalized_search = ''
        or quotation_row.id = search_uuid
        or position(normalized_search in lower(quotation_row.quotation_number)) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), page_rows as (
    select authorized_row.*
    from authorized authorized_row
    order by
      case when target_sort = 'updated:desc' then authorized_row.updated_at end desc,
      case when target_sort = 'updated:asc' then authorized_row.updated_at end asc,
      case when target_sort = 'amount:desc' then authorized_row.total_amount end desc,
      case when target_sort = 'amount:asc' then authorized_row.total_amount end asc,
      case when target_sort = 'customer:asc' then lower(authorized_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(authorized_row.customer_name) end desc,
      authorized_row.id desc
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when target_sort = 'updated:desc' then page_row.updated_at end desc,
      case when target_sort = 'updated:asc' then page_row.updated_at end asc,
      case when target_sort = 'amount:desc' then page_row.total_amount end desc,
      case when target_sort = 'amount:asc' then page_row.total_amount end asc,
      case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
      page_row.id desc
    ) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from authorized),
    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where status in ('DRAFT', 'PENDING_APPROVAL', 'SENT')),
      'sent', (select count(*) from authorized where status = 'SENT'),
      'approval_required', (select count(*) from authorized where approval_status = 'PENDING'),
      'converted', (select count(*) from authorized where status = 'CONVERTED'),
      'pipeline_value', (select coalesce(sum(total_amount), 0) from authorized where status in ('SENT', 'ACCEPTED'))
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.get_booking_workspace_page(
  target_search text default '',
  target_status text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  search_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_status not in (
      'ALL', 'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED',
      'READY_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'
    )
    or target_sort not in (
      'updated:desc', 'updated:asc', 'amount:desc', 'amount:asc',
      'delivery:asc', 'delivery:desc', 'customer:asc', 'customer:desc'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_QUERY';
  end if;
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not (
    app_private.has_permission(current_organization_id, 'booking.view')
    or app_private.has_permission(current_organization_id, 'booking.manage')
  ) then
    raise exception using errcode = '42501', message = 'BOOKING_VIEW_PERMISSION_REQUIRED';
  end if;

  with authorized as materialized (
    select
      booking_row.id,
      booking_row.organization_id,
      booking_row.branch_id,
      booking_row.team_id,
      booking_row.customer_id,
      booking_row.lead_id,
      booking_row.quotation_id,
      booking_row.assigned_user_id,
      booking_row.booking_number,
      quotation_row.quotation_number,
      booking_row.status,
      booking_row.booking_amount,
      booking_row.total_value,
      booking_row.finance_required,
      booking_row.exchange_required,
      booking_row.expected_delivery_date,
      booking_row.version,
      booking_row.created_at,
      booking_row.updated_at,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as assigned_user_name,
      lead_row.interested_model
    from public.bookings booking_row
    join public.customers customer_row
      on customer_row.id = booking_row.customer_id
     and customer_row.organization_id = booking_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = booking_row.branch_id
     and branch_row.organization_id = booking_row.organization_id
    left join public.teams team_row
      on team_row.id = booking_row.team_id
     and team_row.organization_id = booking_row.organization_id
    join public.profiles profile_row
      on profile_row.id = booking_row.assigned_user_id
     and profile_row.organization_id = booking_row.organization_id
    left join public.quotations quotation_row
      on quotation_row.id = booking_row.quotation_id
     and quotation_row.organization_id = booking_row.organization_id
    left join public.leads lead_row
      on lead_row.id = booking_row.lead_id
     and lead_row.organization_id = booking_row.organization_id
    where booking_row.organization_id = current_organization_id
      and booking_row.deleted_at is null
      and app_private.can_access_record(
        booking_row.organization_id,
        booking_row.branch_id,
        booking_row.team_id,
        booking_row.assigned_user_id
      )
      and (target_status = 'ALL' or booking_row.status = target_status)
      and (
        normalized_search = ''
        or booking_row.id = search_uuid
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or position(normalized_search in lower(coalesce(quotation_row.quotation_number, ''))) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), page_rows as (
    select authorized_row.*
    from authorized authorized_row
    order by
      case when target_sort = 'updated:desc' then authorized_row.updated_at end desc,
      case when target_sort = 'updated:asc' then authorized_row.updated_at end asc,
      case when target_sort = 'amount:desc' then authorized_row.total_value end desc nulls last,
      case when target_sort = 'amount:asc' then authorized_row.total_value end asc nulls last,
      case when target_sort = 'delivery:asc' then authorized_row.expected_delivery_date end asc nulls last,
      case when target_sort = 'delivery:desc' then authorized_row.expected_delivery_date end desc nulls last,
      case when target_sort = 'customer:asc' then lower(authorized_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(authorized_row.customer_name) end desc,
      authorized_row.id desc
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when target_sort = 'updated:desc' then page_row.updated_at end desc,
      case when target_sort = 'updated:asc' then page_row.updated_at end asc,
      case when target_sort = 'amount:desc' then page_row.total_value end desc nulls last,
      case when target_sort = 'amount:asc' then page_row.total_value end asc nulls last,
      case when target_sort = 'delivery:asc' then page_row.expected_delivery_date end asc nulls last,
      case when target_sort = 'delivery:desc' then page_row.expected_delivery_date end desc nulls last,
      case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
      case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc,
      page_row.id desc
    ) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from authorized),
    'kpis', jsonb_build_object(
      'bookings', (select count(*) from authorized where status <> 'CANCELLED'),
      'booking_value', (select coalesce(sum(total_value), 0) from authorized where status <> 'CANCELLED'),
      'awaiting_allocation', (select count(*) from authorized where status in ('CONFIRMED', 'AWAITING_ALLOCATION')),
      'delivery_this_week', (select count(*) from authorized where status = 'READY_FOR_DELIVERY' and expected_delivery_date between current_date and current_date + 7),
      'delivered', (select count(*) from authorized where status = 'DELIVERED')
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.get_quotation_lead_options(
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'quotation.manage')
  then
    raise exception using errcode = '42501', message = 'QUOTATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
  into result
  from (
    select
      lead_row.id as lead_id,
      lead_row.customer_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      branch_row.name as branch_name,
      lead_row.lifecycle_status,
      lead_row.updated_at
    from public.leads lead_row
    join public.customers customer_row
      on customer_row.id = lead_row.customer_id
     and customer_row.organization_id = lead_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
      and app_private.can_access_record(
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.assigned_user_id
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(coalesce(lead_row.interested_model, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
        or position(normalized_search in lower(lead_row.id::text)) > 0
      )
    order by lead_row.updated_at desc, lead_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.get_booking_quotation_options(
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'booking.manage')
  then
    raise exception using errcode = '42501', message = 'BOOKING_MANAGE_PERMISSION_REQUIRED';
  end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
  into result
  from (
    select
      quotation_row.id as quotation_id,
      quotation_row.quotation_number,
      quotation_row.customer_id,
      quotation_row.lead_id,
      quotation_row.branch_id,
      quotation_row.team_id,
      quotation_row.assigned_user_id,
      quotation_row.version,
      quotation_row.total_amount,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      branch_row.name as branch_name,
      quotation_row.updated_at
    from public.quotations quotation_row
    join public.customers customer_row
      on customer_row.id = quotation_row.customer_id
     and customer_row.organization_id = quotation_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = quotation_row.branch_id
     and branch_row.organization_id = quotation_row.organization_id
    left join public.leads lead_row
      on lead_row.id = quotation_row.lead_id
     and lead_row.organization_id = quotation_row.organization_id
    where quotation_row.organization_id = current_organization_id
      and quotation_row.status = 'ACCEPTED'
      and app_private.can_access_record(
        quotation_row.organization_id,
        quotation_row.branch_id,
        quotation_row.team_id,
        quotation_row.assigned_user_id
      )
      and not exists (
        select 1 from public.bookings booking_row
        where booking_row.organization_id = quotation_row.organization_id
          and booking_row.quotation_id = quotation_row.id
          and booking_row.deleted_at is null
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(quotation_row.quotation_number)) > 0
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
    order by quotation_row.updated_at desc, quotation_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.save_quotation(
  target_quotation_id uuid,
  expected_version bigint,
  target_lead_id uuid,
  target_items jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_row public.leads%rowtype;
  quotation_row public.quotations%rowtype;
  item jsonb;
  normalized_items jsonb := '[]'::jsonb;
  normalized_type text;
  normalized_description text;
  item_quantity numeric(10,2);
  item_unit_price numeric(14,2);
  item_adjustment numeric(14,2);
  gross_amount numeric := 0;
  discount_amount numeric := 0;
  computed_total_amount numeric := 0;
  requires_approval boolean := false;
  assigned_user_id uuid;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
  action_name text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'quotation.manage')
  then
    raise exception using errcode = '42501', message = 'QUOTATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null
    or target_lead_id is null
    or (target_quotation_id is not null and expected_version is null)
    or jsonb_typeof(target_items) <> 'array'
    or jsonb_array_length(target_items) not between 1 and 50
  then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_INPUT';
  end if;

  select * into lead_row
  from public.leads source_row
  where source_row.id = target_lead_id
    and source_row.organization_id = current_organization_id
    and source_row.customer_id is not null
    and source_row.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'QUOTATION_LEAD_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
    lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'QUOTATION_SCOPE_DENIED';
  end if;
  assigned_user_id := coalesce(lead_row.assigned_user_id, auth.uid());
  if not exists (
    select 1 from public.profiles profile_row
    where profile_row.id = assigned_user_id
      and profile_row.organization_id = current_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
  ) or not app_private.can_access_record(
    current_organization_id, lead_row.branch_id, lead_row.team_id, assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'QUOTATION_ASSIGNEE_DENIED';
  end if;

  for item in select value from jsonb_array_elements(target_items)
  loop
    if jsonb_typeof(item) <> 'object'
      or item - array['item_type', 'description', 'quantity', 'unit_price', 'adjustment']::text[] <> '{}'::jsonb
      or coalesce(item->>'quantity', '') !~ '^[0-9]{1,4}([.][0-9]{1,2})?$'
      or coalesce(item->>'unit_price', '') !~ '^[0-9]{1,10}([.][0-9]{1,2})?$'
      or coalesce(item->>'adjustment', '0') !~ '^-?[0-9]{1,10}([.][0-9]{1,2})?$'
    then
      raise exception using errcode = '22023', message = 'INVALID_QUOTATION_ITEM';
    end if;
    normalized_type := upper(btrim(coalesce(item->>'item_type', '')));
    normalized_description := btrim(coalesce(item->>'description', ''));
    item_quantity := (item->>'quantity')::numeric;
    item_unit_price := (item->>'unit_price')::numeric;
    item_adjustment := coalesce((item->>'adjustment')::numeric, 0);
    if normalized_type not in ('VEHICLE', 'ACCESSORY', 'INSURANCE', 'SERVICE', 'DISCOUNT', 'OTHER')
      or char_length(normalized_description) not between 1 and 240
      or item_quantity <= 0 or item_quantity > 1000
      or item_unit_price < 0 or item_unit_price > 1000000000
      or item_adjustment < -1000000000 or item_adjustment > 1000000000
      or (normalized_type = 'DISCOUNT' and (item_unit_price <> 0 or item_adjustment >= 0))
    then
      raise exception using errcode = '22023', message = 'INVALID_QUOTATION_ITEM';
    end if;
    gross_amount := gross_amount + item_quantity * item_unit_price;
    discount_amount := discount_amount + greatest(-item_adjustment, 0);
    computed_total_amount := computed_total_amount
      + item_quantity * item_unit_price + item_adjustment;
    normalized_items := normalized_items || jsonb_build_array(jsonb_build_object(
      'item_type', normalized_type,
      'description', normalized_description,
      'quantity', item_quantity,
      'unit_price', item_unit_price,
      'adjustment', item_adjustment
    ));
  end loop;
  if gross_amount <= 0
    or computed_total_amount < 0
    or computed_total_amount > 10000000000
  then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_TOTAL';
  end if;
  requires_approval := discount_amount > gross_amount * 0.10;
  action_name := case when target_quotation_id is null then 'quotation.created' else 'quotation.updated' end;
  request_fingerprint := app_private.sales_request_fingerprint(jsonb_build_object(
    'quotation_id', target_quotation_id,
    'expected_version', expected_version,
    'lead_id', target_lead_id,
    'items', normalized_items
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':' || action_name || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_sales_request(
    current_organization_id, action_name, target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  if target_quotation_id is null then
    insert into public.quotations (
      organization_id, branch_id, team_id, customer_id, lead_id,
      assigned_user_id, quotation_number, status, current_version,
      version, total_amount, approval_status
    ) values (
      current_organization_id, lead_row.branch_id, lead_row.team_id, lead_row.customer_id,
      lead_row.id, assigned_user_id,
      'QT-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      case when requires_approval then 'PENDING_APPROVAL' else 'DRAFT' end,
      1, 1, computed_total_amount,
      case when requires_approval then 'PENDING' else 'NOT_REQUIRED' end
    ) returning * into quotation_row;
  else
    select * into quotation_row
    from public.quotations source_row
    where source_row.id = target_quotation_id
      and source_row.organization_id = current_organization_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'QUOTATION_NOT_FOUND';
    end if;
    if quotation_row.version <> expected_version then
      raise exception using errcode = '40001', message = 'QUOTATION_VERSION_CONFLICT';
    end if;
    if quotation_row.status not in ('DRAFT', 'PENDING_APPROVAL') then
      raise exception using errcode = '23514', message = 'QUOTATION_NOT_EDITABLE';
    end if;
    if quotation_row.lead_id is distinct from lead_row.id
      or quotation_row.customer_id is distinct from lead_row.customer_id
      or quotation_row.branch_id is distinct from lead_row.branch_id
      or quotation_row.team_id is distinct from lead_row.team_id
    then
      raise exception using errcode = '23514', message = 'QUOTATION_CONTEXT_IMMUTABLE';
    end if;
    if not app_private.can_access_record(
      quotation_row.organization_id, quotation_row.branch_id,
      quotation_row.team_id, quotation_row.assigned_user_id
    ) then
      raise exception using errcode = '42501', message = 'QUOTATION_SCOPE_DENIED';
    end if;
    update public.approvals
    set status = 'CANCELLED', decided_at = now()
    where organization_id = current_organization_id
      and resource_type = 'quotation'
      and resource_id = quotation_row.id
      and status = 'PENDING';
    update public.quotation_items
    set deleted_at = now()
    where organization_id = current_organization_id
      and quotation_id = quotation_row.id
      and deleted_at is null;
    update public.quotations
    set status = case when requires_approval then 'PENDING_APPROVAL' else 'DRAFT' end,
        approval_status = case when requires_approval then 'PENDING' else 'NOT_REQUIRED' end,
        total_amount = computed_total_amount,
        current_version = current_version + 1,
        version = version + 1,
        updated_at = now()
    where id = quotation_row.id
    returning * into quotation_row;
  end if;

  insert into public.quotation_items (
    organization_id, quotation_id, item_type, description,
    quantity, unit_price, adjustment
  )
  select
    current_organization_id,
    quotation_row.id,
    item_row->>'item_type',
    item_row->>'description',
    (item_row->>'quantity')::numeric,
    (item_row->>'unit_price')::numeric,
    (item_row->>'adjustment')::numeric
  from jsonb_array_elements(normalized_items) item_row;

  insert into public.quotation_versions (
    organization_id, quotation_id, version, snapshot, created_by
  ) values (
    current_organization_id,
    quotation_row.id,
    quotation_row.current_version,
    jsonb_build_object(
      'quotation_number', quotation_row.quotation_number,
      'lead_id', quotation_row.lead_id,
      'customer_id', quotation_row.customer_id,
      'status', quotation_row.status,
      'approval_status', quotation_row.approval_status,
      'total_amount', quotation_row.total_amount,
      'items', normalized_items
    ),
    auth.uid()
  );

  if requires_approval then
    insert into public.approvals (
      organization_id, branch_id, resource_type, resource_id,
      approval_type, requested_change, requester_id, status
    ) values (
      current_organization_id,
      quotation_row.branch_id,
      'quotation',
      quotation_row.id,
      'QUOTATION_DISCOUNT',
      jsonb_build_object(
        'quotation_version', quotation_row.current_version,
        'gross_amount', gross_amount,
        'discount_amount', discount_amount,
        'total_amount', computed_total_amount,
        'discount_percent', round((discount_amount / gross_amount) * 100, 2)
      ),
      auth.uid(),
      'PENDING'
    );
  end if;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, quotation_row.customer_id, quotation_row.lead_id,
    case when target_quotation_id is null then 'QUOTATION_CREATED' else 'QUOTATION_UPDATED' end,
    auth.uid(),
    jsonb_build_object(
      'quotation_id', quotation_row.id,
      'quotation_number', quotation_row.quotation_number,
      'version', quotation_row.current_version,
      'total_amount', quotation_row.total_amount,
      'approval_status', quotation_row.approval_status
    )
  );
  result := jsonb_build_object(
    'id', quotation_row.id,
    'version', quotation_row.version,
    'current_version', quotation_row.current_version,
    'status', quotation_row.status,
    'approval_status', quotation_row.approval_status,
    'total_amount', quotation_row.total_amount,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), action_name, 'quotation', quotation_row.id::text,
    quotation_row.branch_id, target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'current_version', quotation_row.current_version,
      'approval_required', requires_approval
    )
  );
  return result;
end;
$$;

create or replace function public.transition_quotation_status(
  target_quotation_id uuid,
  expected_version bigint,
  target_status text,
  change_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  quotation_row public.quotations%rowtype;
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  normalized_reason text := nullif(btrim(coalesce(change_reason, '')), '');
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'quotation.manage')
  then
    raise exception using errcode = '42501', message = 'QUOTATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_quotation_id is null or expected_version is null or target_request_id is null
    or normalized_status not in ('SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED')
    or char_length(coalesce(normalized_reason, '')) > 500
  then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_TRANSITION';
  end if;
  if normalized_status in ('REJECTED', 'EXPIRED') and normalized_reason is null then
    raise exception using errcode = '22023', message = 'QUOTATION_REASON_REQUIRED';
  end if;
  request_fingerprint := app_private.sales_request_fingerprint(jsonb_build_object(
    'quotation_id', target_quotation_id,
    'expected_version', expected_version,
    'status', normalized_status,
    'reason', normalized_reason
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':quotation.transitioned:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_sales_request(
    current_organization_id, 'quotation.transitioned', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into quotation_row
  from public.quotations source_row
  where source_row.id = target_quotation_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'QUOTATION_NOT_FOUND';
  end if;
  if quotation_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'QUOTATION_VERSION_CONFLICT';
  end if;
  if not app_private.can_access_record(
    quotation_row.organization_id, quotation_row.branch_id,
    quotation_row.team_id, quotation_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'QUOTATION_SCOPE_DENIED';
  end if;
  if normalized_status = 'SENT' and (
    quotation_row.status <> 'DRAFT'
    or quotation_row.approval_status in ('PENDING', 'REJECTED')
  ) then
    raise exception using errcode = '23514', message = 'QUOTATION_NOT_READY_TO_SEND';
  elsif normalized_status in ('ACCEPTED', 'REJECTED') and quotation_row.status <> 'SENT' then
    raise exception using errcode = '23514', message = 'INVALID_QUOTATION_TRANSITION';
  elsif normalized_status = 'EXPIRED' and quotation_row.status not in ('DRAFT', 'SENT') then
    raise exception using errcode = '23514', message = 'INVALID_QUOTATION_TRANSITION';
  end if;

  update public.quotations
  set status = normalized_status,
      version = version + 1,
      updated_at = now()
  where id = quotation_row.id
  returning * into quotation_row;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, quotation_row.customer_id, quotation_row.lead_id,
    'QUOTATION_STATUS_CHANGED', auth.uid(),
    jsonb_build_object(
      'quotation_id', quotation_row.id,
      'status', quotation_row.status,
      'reason', normalized_reason
    )
  );
  result := jsonb_build_object(
    'id', quotation_row.id,
    'version', quotation_row.version,
    'status', quotation_row.status,
    'approval_status', quotation_row.approval_status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'quotation.transitioned', 'quotation',
    quotation_row.id::text, quotation_row.branch_id, target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'reason', normalized_reason
    )
  );
  return result;
end;
$$;

create or replace function public.decide_quotation_approval(
  target_quotation_id uuid,
  expected_version bigint,
  target_decision text,
  decision_comment text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  quotation_row public.quotations%rowtype;
  approval_row public.approvals%rowtype;
  normalized_decision text := upper(btrim(coalesce(target_decision, '')));
  normalized_comment text := nullif(btrim(coalesce(decision_comment, '')), '');
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'approval.decide')
  then
    raise exception using errcode = '42501', message = 'APPROVAL_DECIDE_PERMISSION_REQUIRED';
  end if;
  if target_quotation_id is null or expected_version is null or target_request_id is null
    or normalized_decision not in ('APPROVED', 'REJECTED')
    or char_length(coalesce(normalized_comment, '')) > 500
    or (normalized_decision = 'REJECTED' and normalized_comment is null)
  then
    raise exception using errcode = '22023', message = 'INVALID_APPROVAL_DECISION';
  end if;
  request_fingerprint := app_private.sales_request_fingerprint(jsonb_build_object(
    'quotation_id', target_quotation_id,
    'expected_version', expected_version,
    'decision', normalized_decision,
    'comment', normalized_comment
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':quotation.approval_decided:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_sales_request(
    current_organization_id, 'quotation.approval_decided',
    target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into quotation_row
  from public.quotations source_row
  where source_row.id = target_quotation_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'QUOTATION_NOT_FOUND';
  end if;
  if quotation_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'QUOTATION_VERSION_CONFLICT';
  end if;
  if quotation_row.status <> 'PENDING_APPROVAL'
    or quotation_row.approval_status <> 'PENDING'
    or not app_private.can_access_record(
      quotation_row.organization_id, quotation_row.branch_id,
      quotation_row.team_id, quotation_row.assigned_user_id
    )
  then
    raise exception using errcode = '23514', message = 'QUOTATION_APPROVAL_NOT_PENDING';
  end if;
  select * into approval_row
  from public.approvals source_row
  where source_row.organization_id = current_organization_id
    and source_row.resource_type = 'quotation'
    and source_row.resource_id = quotation_row.id
    and source_row.status = 'PENDING'
  order by source_row.created_at desc, source_row.id desc
  limit 1
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'QUOTATION_APPROVAL_NOT_FOUND';
  end if;
  if approval_row.requester_id = auth.uid() then
    raise exception using errcode = '42501', message = 'DISTINCT_APPROVER_REQUIRED';
  end if;

  update public.approvals
  set status = normalized_decision,
      current_approver_id = auth.uid(),
      decided_at = now()
  where id = approval_row.id;
  insert into public.approval_history (
    organization_id, approval_id, actor_id, action, comment
  ) values (
    current_organization_id, approval_row.id, auth.uid(), normalized_decision,
    normalized_comment
  );
  update public.quotations
  set status = 'DRAFT',
      approval_status = normalized_decision,
      version = version + 1,
      updated_at = now()
  where id = quotation_row.id
  returning * into quotation_row;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, quotation_row.customer_id, quotation_row.lead_id,
    'QUOTATION_APPROVAL_DECIDED', auth.uid(),
    jsonb_build_object(
      'quotation_id', quotation_row.id,
      'decision', normalized_decision,
      'comment', normalized_comment
    )
  );
  result := jsonb_build_object(
    'id', quotation_row.id,
    'version', quotation_row.version,
    'status', quotation_row.status,
    'approval_status', quotation_row.approval_status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'quotation.approval_decided', 'quotation',
    quotation_row.id::text, quotation_row.branch_id, target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'approval_id', approval_row.id,
      'comment', normalized_comment
    )
  );
  return result;
end;
$$;

create or replace function public.create_booking_from_quotation(
  target_quotation_id uuid,
  expected_quotation_version bigint,
  target_booking_amount numeric,
  target_finance_required boolean,
  target_exchange_required boolean,
  target_expected_delivery_date date,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  quotation_row public.quotations%rowtype;
  booking_row public.bookings%rowtype;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'booking.manage')
  then
    raise exception using errcode = '42501', message = 'BOOKING_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_quotation_id is null or expected_quotation_version is null
    or target_booking_amount is null or target_booking_amount <= 0
    or target_booking_amount > 10000000000 or target_request_id is null
    or target_expected_delivery_date < current_date
    or target_expected_delivery_date > current_date + 1095
  then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_INPUT';
  end if;
  request_fingerprint := app_private.sales_request_fingerprint(jsonb_build_object(
    'quotation_id', target_quotation_id,
    'expected_version', expected_quotation_version,
    'booking_amount', target_booking_amount,
    'finance_required', coalesce(target_finance_required, false),
    'exchange_required', coalesce(target_exchange_required, false),
    'expected_delivery_date', target_expected_delivery_date
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':booking:' || target_quotation_id::text, 0
  ));
  replay_result := app_private.replay_sales_request(
    current_organization_id, 'booking.created', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into quotation_row
  from public.quotations source_row
  where source_row.id = target_quotation_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'QUOTATION_NOT_FOUND';
  end if;
  if quotation_row.version <> expected_quotation_version then
    raise exception using errcode = '40001', message = 'QUOTATION_VERSION_CONFLICT';
  end if;
  if quotation_row.status <> 'ACCEPTED'
    or target_booking_amount > quotation_row.total_amount
    or not app_private.can_access_record(
      quotation_row.organization_id, quotation_row.branch_id,
      quotation_row.team_id, quotation_row.assigned_user_id
    )
  then
    raise exception using errcode = '23514', message = 'QUOTATION_NOT_BOOKABLE';
  end if;
  if exists (
    select 1 from public.bookings existing_row
    where existing_row.organization_id = current_organization_id
      and existing_row.quotation_id = quotation_row.id
      and existing_row.deleted_at is null
  ) then
    raise exception using errcode = '23505', message = 'QUOTATION_ALREADY_BOOKED';
  end if;

  insert into public.bookings (
    organization_id, branch_id, team_id, customer_id, lead_id, quotation_id,
    assigned_user_id, booking_number, status, booking_amount, total_value,
    finance_required, exchange_required, expected_delivery_date, version
  ) values (
    current_organization_id, quotation_row.branch_id, quotation_row.team_id,
    quotation_row.customer_id, quotation_row.lead_id, quotation_row.id,
    quotation_row.assigned_user_id,
    'BK-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    'CONFIRMED', target_booking_amount, quotation_row.total_amount,
    coalesce(target_finance_required, false), coalesce(target_exchange_required, false),
    target_expected_delivery_date, 1
  ) returning * into booking_row;
  insert into public.booking_status_history (
    organization_id, booking_id, from_status, to_status, changed_by, reason
  ) values (
    current_organization_id, booking_row.id, null, booking_row.status,
    auth.uid(), 'Created from accepted quotation'
  );
  update public.quotations
  set status = 'CONVERTED', version = version + 1, updated_at = now()
  where id = quotation_row.id;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, booking_row.customer_id, booking_row.lead_id,
    'BOOKING_CREATED', auth.uid(),
    jsonb_build_object(
      'booking_id', booking_row.id,
      'booking_number', booking_row.booking_number,
      'quotation_id', quotation_row.id,
      'booking_amount', booking_row.booking_amount,
      'total_value', booking_row.total_value
    )
  );
  result := jsonb_build_object(
    'id', booking_row.id,
    'version', booking_row.version,
    'status', booking_row.status,
    'booking_number', booking_row.booking_number,
    'quotation_id', quotation_row.id,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'booking.created', 'booking',
    booking_row.id::text, booking_row.branch_id, target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'quotation_id', quotation_row.id,
      'booking_amount', booking_row.booking_amount
    )
  );
  return result;
end;
$$;

create or replace function public.transition_booking_status(
  target_booking_id uuid,
  expected_version bigint,
  target_status text,
  change_reason text,
  target_expected_delivery_date date,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  booking_row public.bookings%rowtype;
  previous_status text;
  normalized_status text := upper(btrim(coalesce(target_status, '')));
  normalized_reason text := nullif(btrim(coalesce(change_reason, '')), '');
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'booking.manage')
  then
    raise exception using errcode = '42501', message = 'BOOKING_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_booking_id is null or expected_version is null or target_request_id is null
    or normalized_status not in (
      'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'
    )
    or char_length(coalesce(normalized_reason, '')) > 500
    or (normalized_status = 'CANCELLED' and normalized_reason is null)
    or target_expected_delivery_date < current_date
    or target_expected_delivery_date > current_date + 1095
  then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING_TRANSITION';
  end if;
  request_fingerprint := app_private.sales_request_fingerprint(jsonb_build_object(
    'booking_id', target_booking_id,
    'expected_version', expected_version,
    'status', normalized_status,
    'reason', normalized_reason,
    'expected_delivery_date', target_expected_delivery_date
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':booking:' || target_booking_id::text, 0
  ));
  replay_result := app_private.replay_sales_request(
    current_organization_id, 'booking.transitioned', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into booking_row
  from public.bookings source_row
  where source_row.id = target_booking_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'BOOKING_NOT_FOUND';
  end if;
  if booking_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'BOOKING_VERSION_CONFLICT';
  end if;
  if not app_private.can_access_record(
    booking_row.organization_id, booking_row.branch_id,
    booking_row.team_id, booking_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'BOOKING_SCOPE_DENIED';
  end if;
  if booking_row.status in ('DELIVERED', 'CANCELLED')
    or (normalized_status = 'AWAITING_ALLOCATION' and booking_row.status <> 'CONFIRMED')
    or (normalized_status = 'ALLOCATED' and booking_row.status not in ('CONFIRMED', 'AWAITING_ALLOCATION'))
    or (normalized_status = 'READY_FOR_DELIVERY' and booking_row.status <> 'ALLOCATED')
    or (normalized_status = 'DELIVERED' and booking_row.status <> 'READY_FOR_DELIVERY')
  then
    raise exception using errcode = '23514', message = 'INVALID_BOOKING_TRANSITION';
  end if;
  if normalized_status = 'ALLOCATED' and not exists (
    select 1 from public.stock_allocations allocation_row
    where allocation_row.organization_id = current_organization_id
      and allocation_row.booking_id = booking_row.id
      and allocation_row.status in ('RESERVED', 'ALLOCATED')
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_STOCK_ALLOCATION_REQUIRED';
  end if;
  if normalized_status = 'READY_FOR_DELIVERY' and not exists (
    select 1
    from public.stock_allocations allocation_row
    join public.stock_units stock_row
      on stock_row.organization_id = allocation_row.organization_id
     and stock_row.id = allocation_row.stock_unit_id
    where allocation_row.organization_id = current_organization_id
      and allocation_row.booking_id = booking_row.id
      and allocation_row.status = 'ALLOCATED'
      and stock_row.status = 'READY_FOR_DELIVERY'
  ) then
    raise exception using errcode = '23514', message = 'DELIVERY_READY_STOCK_REQUIRED';
  end if;
  if normalized_status = 'DELIVERED' and not exists (
    select 1
    from public.stock_allocations allocation_row
    join public.stock_units stock_row
      on stock_row.organization_id = allocation_row.organization_id
     and stock_row.id = allocation_row.stock_unit_id
    where allocation_row.organization_id = current_organization_id
      and allocation_row.booking_id = booking_row.id
      and allocation_row.status = 'ALLOCATED'
      and stock_row.status = 'DELIVERED'
  ) then
    raise exception using errcode = '23514', message = 'DELIVERED_STOCK_REQUIRED';
  end if;
  if normalized_status = 'CANCELLED' and exists (
    select 1 from public.stock_allocations allocation_row
    where allocation_row.organization_id = current_organization_id
      and allocation_row.booking_id = booking_row.id
      and allocation_row.status in ('RESERVED', 'ALLOCATED')
  ) then
    raise exception using errcode = '23514', message = 'RELEASE_STOCK_BEFORE_CANCELLING';
  end if;
  previous_status := booking_row.status;
  update public.bookings
  set status = normalized_status,
      expected_delivery_date = coalesce(target_expected_delivery_date, expected_delivery_date),
      version = version + 1,
      updated_at = now()
  where id = booking_row.id
  returning * into booking_row;
  insert into public.booking_status_history (
    organization_id, booking_id, from_status, to_status, changed_by, reason
  ) values (
    current_organization_id, booking_row.id, previous_status,
    booking_row.status, auth.uid(), normalized_reason
  );
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, booking_row.customer_id, booking_row.lead_id,
    'BOOKING_STATUS_CHANGED', auth.uid(),
    jsonb_build_object(
      'booking_id', booking_row.id,
      'from_status', previous_status,
      'to_status', booking_row.status,
      'reason', normalized_reason
    )
  );
  result := jsonb_build_object(
    'id', booking_row.id,
    'version', booking_row.version,
    'status', booking_row.status,
    'expected_delivery_date', booking_row.expected_delivery_date,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'booking.transitioned', 'booking',
    booking_row.id::text, booking_row.branch_id, target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'from_status', previous_status,
      'reason', normalized_reason
    )
  );
  return result;
end;
$$;

-- Extend the private invalidation topic allow-list. Broadcast payloads contain
-- only resource/operation/record identifiers; clients refetch through RLS/RPCs.
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
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales)$'
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
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales)$'
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
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'test_drive.view'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'test_drive.manage'
            )
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'integration.view'
          )
          when 'support' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'support.request')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'support.approve'
            )
          when 'administration' then
            app_private.tenant_user_mode_allowed(auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'branch.manage')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'team.manage'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'user.manage'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'role.manage'
            )
          when 'inventory' then
            app_private.has_permission(
              app_private.realtime_topic_organization(), 'inventory.view'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'inventory.stock_check'
            )
          when 'sales' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.view')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'quotation.manage'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'booking.view'
            )
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'booking.manage'
            )
          else false
        end
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_quotations_sales_invalidate on public.quotations;
create trigger realtime_quotations_sales_invalidate
after insert or update on public.quotations
for each row execute function app_private.broadcast_tenant_invalidation('sales');
drop trigger if exists realtime_quotation_items_sales_invalidate on public.quotation_items;
create trigger realtime_quotation_items_sales_invalidate
after insert or update on public.quotation_items
for each row execute function app_private.broadcast_tenant_invalidation('sales');
drop trigger if exists realtime_quotation_versions_sales_invalidate on public.quotation_versions;
create trigger realtime_quotation_versions_sales_invalidate
after insert or update on public.quotation_versions
for each row execute function app_private.broadcast_tenant_invalidation('sales');
drop trigger if exists realtime_bookings_sales_invalidate on public.bookings;
create trigger realtime_bookings_sales_invalidate
after insert or update on public.bookings
for each row execute function app_private.broadcast_tenant_invalidation('sales');
drop trigger if exists realtime_booking_history_sales_invalidate on public.booking_status_history;
create trigger realtime_booking_history_sales_invalidate
after insert or update on public.booking_status_history
for each row execute function app_private.broadcast_tenant_invalidation('sales');
drop trigger if exists realtime_approvals_sales_invalidate on public.approvals;
create trigger realtime_approvals_sales_invalidate
after insert or update on public.approvals
for each row execute function app_private.broadcast_tenant_invalidation('sales');

revoke all on function public.get_quotation_workspace_page(text, text, integer, integer, text)
  from public, anon;
grant execute on function public.get_quotation_workspace_page(text, text, integer, integer, text)
  to authenticated;
revoke all on function public.get_booking_workspace_page(text, text, integer, integer, text)
  from public, anon;
grant execute on function public.get_booking_workspace_page(text, text, integer, integer, text)
  to authenticated;
revoke all on function public.get_quotation_lead_options(text, integer)
  from public, anon;
grant execute on function public.get_quotation_lead_options(text, integer)
  to authenticated;
revoke all on function public.get_booking_quotation_options(text, integer)
  from public, anon;
grant execute on function public.get_booking_quotation_options(text, integer)
  to authenticated;
revoke all on function public.save_quotation(uuid, bigint, uuid, jsonb, uuid)
  from public, anon;
grant execute on function public.save_quotation(uuid, bigint, uuid, jsonb, uuid)
  to authenticated;
revoke all on function public.transition_quotation_status(uuid, bigint, text, text, uuid)
  from public, anon;
grant execute on function public.transition_quotation_status(uuid, bigint, text, text, uuid)
  to authenticated;
revoke all on function public.decide_quotation_approval(uuid, bigint, text, text, uuid)
  from public, anon;
grant execute on function public.decide_quotation_approval(uuid, bigint, text, text, uuid)
  to authenticated;
revoke all on function public.create_booking_from_quotation(
  uuid, bigint, numeric, boolean, boolean, date, uuid
) from public, anon;
grant execute on function public.create_booking_from_quotation(
  uuid, bigint, numeric, boolean, boolean, date, uuid
) to authenticated;
revoke all on function public.transition_booking_status(
  uuid, bigint, text, text, date, uuid
) from public, anon;
grant execute on function public.transition_booking_status(
  uuid, bigint, text, text, date, uuid
) to authenticated;

revoke all on function app_private.sales_request_fingerprint(jsonb)
  from public, anon, authenticated;
revoke all on function app_private.replay_sales_request(uuid, text, uuid, text)
  from public, anon, authenticated;

commit;
