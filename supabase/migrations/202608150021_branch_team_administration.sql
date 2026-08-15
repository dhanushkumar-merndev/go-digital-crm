begin;

-- Branch and team administration has its own authority boundary. These
-- permissions are intentionally distinct from user/role management and from
-- ordinary directory visibility.
insert into public.permissions (permission_key, module, description) values
  ('branch.manage', 'administration', 'Create and configure branches within delegated scope'),
  ('team.manage', 'administration', 'Create and configure teams and team membership within delegated scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

-- Frozen administration roles receive the new permissions for existing
-- tenants. provision_default_roles already grants every current permission to
-- Client Admin and all non-excluded permissions to System Administrator, so
-- this also remains correct for tenants provisioned after this migration.
insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.system_role
  and role_row.role_key in ('client_admin', 'system_administrator')
  and permission_row.permission_key in ('branch.manage', 'team.manage')
on conflict do nothing;

alter table public.branches
  add column if not exists version bigint not null default 1 check (version > 0),
  add column if not exists contact_phone text,
  add column if not exists contact_email text,
  add column if not exists timezone text not null default 'Asia/Kolkata',
  add column if not exists working_hours jsonb not null default '{}'::jsonb,
  add column if not exists showroom_category text,
  add column if not exists latitude numeric(9, 6),
  add column if not exists longitude numeric(9, 6);

alter table public.teams
  add column if not exists version bigint not null default 1 check (version > 0);

alter table public.team_members
  add column if not exists version bigint not null default 1 check (version > 0),
  add column if not exists updated_at timestamptz not null default now();

alter table public.user_branch_access
  add column if not exists active boolean not null default true,
  add column if not exists version bigint not null default 1 check (version > 0),
  add column if not exists updated_at timestamptz not null default now();

alter table public.branches
  add constraint branches_coordinates_pair
  check (
    (latitude is null and longitude is null)
    or (
      latitude between -90 and 90
      and longitude between -180 and 180
    )
  ) not valid;
alter table public.branches validate constraint branches_coordinates_pair;

create index if not exists branches_admin_page_idx
  on public.branches (organization_id, active, updated_at desc, id)
  where deleted_at is null;
create index if not exists branches_admin_name_trgm_idx
  on public.branches using gin (lower(name) gin_trgm_ops)
  where deleted_at is null;
create index if not exists teams_admin_page_idx
  on public.teams (organization_id, branch_id, active, updated_at desc, id);
create index if not exists teams_admin_name_trgm_idx
  on public.teams using gin (lower(name) gin_trgm_ops);
create index if not exists team_members_admin_active_idx
  on public.team_members (organization_id, team_id, active, member_type, user_id);
create index if not exists user_branch_access_admin_idx
  on public.user_branch_access (organization_id, branch_id, active, user_id);

-- This helper deliberately ignores branch status. Administration RPCs use it
-- to list and reactivate an inactive branch without reopening that branch to
-- operational record queries.
create or replace function app_private.actor_scope_includes_branch(
  target_organization_id uuid,
  target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_branch_id is not null
    and app_private.can_access_organization(target_organization_id)
    and exists (
      select 1
      from public.branches branch_row
      where branch_row.id = target_branch_id
        and branch_row.organization_id = target_organization_id
        and branch_row.deleted_at is null
    )
    and (
      app_private.has_active_approved_support_session(target_organization_id)
      or exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = target_organization_id
          and assignment_row.active
          and (
            assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
            or (
              assignment_row.data_scope = 'ONE_BRANCH'
              and assignment_row.scope_branch_id = target_branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and target_branch_id = any(assignment_row.selected_branch_ids)
            )
            or exists (
              select 1
              from public.user_branch_access branch_access_row
              where branch_access_row.organization_id = target_organization_id
                and branch_access_row.user_id = auth.uid()
                and branch_access_row.branch_id = target_branch_id
                and branch_access_row.active
            )
            or exists (
              select 1
              from public.team_members member_row
              join public.teams team_row
                on team_row.id = member_row.team_id
               and team_row.organization_id = member_row.organization_id
              where member_row.organization_id = target_organization_id
                and member_row.user_id = auth.uid()
                and member_row.active
                and team_row.active
                and team_row.branch_id = target_branch_id
            )
          )
      )
    );
$$;

create or replace function app_private.user_scope_includes_branch(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile_row
    where profile_row.id = target_user_id
      and profile_row.organization_id = target_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
  ) and exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.user_id = target_user_id
      and assignment_row.organization_id = target_organization_id
      and assignment_row.active
      and (
        assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
        -- Team membership is the branch anchor for OWN_TEAM / OWN_RECORDS
        -- users, so an authorized administrator must be able to place a newly
        -- provisioned lower-level user into their first team.
        or assignment_row.data_scope in ('OWN_TEAM', 'OWN_RECORDS')
        or (
          assignment_row.data_scope = 'ONE_BRANCH'
          and assignment_row.scope_branch_id = target_branch_id
        )
        or (
          assignment_row.data_scope = 'SELECTED_BRANCHES'
          and target_branch_id = any(assignment_row.selected_branch_ids)
        )
        or exists (
          select 1
          from public.user_branch_access branch_access_row
          where branch_access_row.organization_id = target_organization_id
            and branch_access_row.user_id = target_user_id
            and branch_access_row.branch_id = target_branch_id
            and branch_access_row.active
        )
        or exists (
          select 1
          from public.team_members member_row
          join public.teams team_row
            on team_row.id = member_row.team_id
           and team_row.organization_id = member_row.organization_id
          where member_row.organization_id = target_organization_id
            and member_row.user_id = target_user_id
            and member_row.active
            and team_row.active
            and team_row.branch_id = target_branch_id
        )
      )
  );
$$;

-- Operational access now requires an active branch. The explicit management
-- exception is limited to actors with branch.manage and is used only for the
-- branch directory/configuration surface.
create or replace function app_private.can_access_branch(
  target_organization_id uuid,
  target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_branch_id is not null
    and app_private.can_access_organization(target_organization_id)
    and exists (
      select 1
      from public.branches branch_row
      where branch_row.id = target_branch_id
        and branch_row.organization_id = target_organization_id
        and branch_row.deleted_at is null
        and (
          app_private.has_active_approved_support_session(target_organization_id)
          or (
            app_private.actor_scope_includes_branch(target_organization_id, target_branch_id)
            and (
              branch_row.active
              or app_private.has_permission(target_organization_id, 'branch.manage')
            )
          )
        )
    );
$$;

-- Every operational record check now passes through the active-branch gate.
-- This closes paths that previously evaluated only the assignment enum.
create or replace function app_private.can_access_record(
  target_organization_id uuid,
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.can_access_organization(target_organization_id)
    and (
      target_branch_id is null
      or exists (
        select 1
        from public.branches branch_row
        where branch_row.id = target_branch_id
          and branch_row.organization_id = target_organization_id
          and branch_row.active
          and branch_row.deleted_at is null
          and app_private.actor_scope_includes_branch(
            target_organization_id, target_branch_id
          )
      )
    )
    and (
      app_private.has_active_approved_support_session(target_organization_id)
      or exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = target_organization_id
          and assignment_row.active
          and (
            assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
            or (
              assignment_row.data_scope = 'ONE_BRANCH'
              and target_branch_id = assignment_row.scope_branch_id
            )
            or (
              assignment_row.data_scope = 'SELECTED_BRANCHES'
              and target_branch_id = any(assignment_row.selected_branch_ids)
            )
            or (
              assignment_row.data_scope = 'OWN_RECORDS'
              and target_owner_id = auth.uid()
              and (
                target_branch_id is null
                or exists (
                  select 1
                  from public.user_branch_access branch_access_row
                  where branch_access_row.organization_id = target_organization_id
                    and branch_access_row.user_id = auth.uid()
                    and branch_access_row.branch_id = target_branch_id
                    and branch_access_row.active
                )
                or exists (
                  select 1
                  from public.team_members member_row
                  join public.teams team_row
                    on team_row.id = member_row.team_id
                   and team_row.organization_id = member_row.organization_id
                  where member_row.organization_id = target_organization_id
                    and member_row.user_id = auth.uid()
                    and member_row.active
                    and team_row.active
                    and team_row.branch_id = target_branch_id
                )
              )
            )
            or (
              assignment_row.data_scope = 'OWN_TEAM'
              and target_team_id in (
                select member_row.team_id
                from public.team_members member_row
                where member_row.organization_id = target_organization_id
                  and member_row.user_id = auth.uid()
                  and member_row.active
              )
            )
          )
      )
    );
$$;

create or replace function app_private.actor_can_administer_user(
  target_organization_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_organization_id = app_private.current_tenant_organization()
    and app_private.can_administer_tenant_user(
      auth.uid(), target_user_id, 'USER_ADMIN'
    );
$$;

create or replace function app_private.user_has_team_member_role(
  target_organization_id uuid,
  target_user_id uuid,
  target_member_type text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_member_type in ('TEAM_MANAGER', 'SALES_CONSULTANT', 'TELECALLER_BDC')
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.organization_id = target_organization_id
        and assignment_row.user_id = target_user_id
        and assignment_row.active
        and role_row.role_key = case target_member_type
          when 'TEAM_MANAGER' then 'team_manager'
          when 'SALES_CONSULTANT' then 'sales_consultant'
          when 'TELECALLER_BDC' then 'telecaller_bdc'
        end
    );
$$;

create or replace function app_private.administration_request_fingerprint(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(coalesce(payload, '{}'::jsonb)::text, 'UTF8')
    ),
    'hex'
  );
$$;

create or replace function app_private.replay_administration_request(
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
  audit_row public.audit_logs%rowtype;
begin
  select * into audit_row
  from public.audit_logs source_row
  where source_row.organization_id = target_organization_id
    and source_row.actor_id = auth.uid()
    and source_row.action = target_action
    and source_row.request_id = target_request_id
  order by source_row.id desc
  limit 1;
  if not found then return null; end if;
  if coalesce(audit_row.metadata->>'fingerprint', '') <> target_fingerprint then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return coalesce(audit_row.metadata->'result', '{}'::jsonb)
    || jsonb_build_object('replayed', true);
end;
$$;

create or replace function app_private.branch_has_active_dependencies(
  target_organization_id uuid,
  target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.teams row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id and row_data.active
    )
    or exists (
      select 1 from public.user_branch_access row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id and row_data.active
    )
    or exists (
      select 1 from public.user_role_assignments row_data
      where row_data.organization_id = target_organization_id and row_data.active
        and (
          row_data.scope_branch_id = target_branch_id
          or target_branch_id = any(row_data.selected_branch_ids)
        )
    )
    or exists (
      select 1 from public.leads row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.deleted_at is null
        and row_data.lifecycle_status <> 'Lost'
    )
    or exists (
      select 1 from public.followups row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status in ('OPEN', 'OVERDUE')
    )
    or exists (
      select 1 from public.appointments row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
    )
    or exists (
      select 1 from public.tasks row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status in ('OPEN', 'IN_PROGRESS')
    )
    or exists (
      select 1 from public.conversations row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status = 'OPEN'
    )
    or exists (
      select 1 from public.test_drive_appointments row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
    )
    or exists (
      select 1 from public.test_drives row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('COMPLETED', 'CANCELLED')
    )
    or exists (
      select 1 from public.stock_units row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.deleted_at is null
        and row_data.status not in ('SOLD', 'DELIVERED', 'RETIRED')
    )
    or exists (
      select 1 from public.stock_allocations row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status in (
          'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD'
        )
    )
    or exists (
      select 1 from public.quotations row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in (
          'CANCELLED', 'REJECTED', 'EXPIRED', 'CONVERTED'
        )
    )
    or exists (
      select 1 from public.bookings row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.deleted_at is null
        and row_data.status not in ('CANCELLED', 'DELIVERED', 'COMPLETED')
    )
    or exists (
      select 1 from public.integration_branch_mappings row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
    )
    or exists (
      select 1 from public.exchange_cases row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('COMPLETED', 'CANCELLED', 'REJECTED')
    )
    or exists (
      select 1 from public.finance_cases row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('DISBURSED', 'COMPLETED', 'CANCELLED', 'REJECTED')
    )
    or exists (
      select 1 from public.insurance_cases row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('ISSUED', 'COMPLETED', 'CANCELLED', 'REJECTED')
    )
    or exists (
      select 1 from public.rto_cases row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('COMPLETED', 'CANCELLED', 'REJECTED')
    )
    or exists (
      select 1 from public.delivery_cases row_data
      where row_data.organization_id = target_organization_id
        and row_data.branch_id = target_branch_id
        and row_data.status not in ('DELIVERED', 'COMPLETED', 'CANCELLED')
    );
$$;

create or replace function app_private.team_has_active_dependencies(
  target_organization_id uuid,
  target_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.team_members row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id and row_data.active
    )
    or exists (
      select 1 from public.leads row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.deleted_at is null
        and row_data.lifecycle_status <> 'Lost'
    )
    or exists (
      select 1 from public.followups row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.status in ('OPEN', 'OVERDUE')
    )
    or exists (
      select 1 from public.appointments row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
    )
    or exists (
      select 1 from public.tasks row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.status in ('OPEN', 'IN_PROGRESS')
    )
    or exists (
      select 1 from public.test_drive_appointments row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW')
    )
    or exists (
      select 1 from public.test_drives row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.status not in ('COMPLETED', 'CANCELLED')
    )
    or exists (
      select 1 from public.quotations row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.status not in (
          'CANCELLED', 'REJECTED', 'EXPIRED', 'CONVERTED'
        )
    )
    or exists (
      select 1 from public.bookings row_data
      where row_data.organization_id = target_organization_id
        and row_data.team_id = target_team_id
        and row_data.deleted_at is null
        and row_data.status not in ('CANCELLED', 'DELIVERED', 'COMPLETED')
    );
$$;

create or replace function app_private.validate_branch_administration_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.created_at is distinct from old.created_at
    or new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception using errcode = '42501', message = 'BRANCH_IDENTITY_IMMUTABLE';
  end if;
  if char_length(btrim(new.name)) not between 2 and 120
    or char_length(btrim(new.code)) not between 2 and 24
    or new.code !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
    or jsonb_typeof(new.address) <> 'object'
    or octet_length(new.address::text) > 16384
    or jsonb_typeof(new.working_hours) <> 'object'
    or octet_length(new.working_hours::text) > 16384
    or char_length(coalesce(new.contact_phone, '')) > 32
    or char_length(coalesce(new.contact_email, '')) > 254
    or char_length(coalesce(new.showroom_category, '')) > 120
    or (
      new.contact_email is not null
      and new.contact_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone)
  then
    raise exception using errcode = '23514', message = 'INVALID_BRANCH_CONFIGURATION';
  end if;
  if tg_op = 'UPDATE' and old.active and not new.active
    and app_private.branch_has_active_dependencies(new.organization_id, new.id)
  then
    raise exception using errcode = '23514', message = 'BRANCH_HAS_ACTIVE_DEPENDENCIES';
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_team_administration_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.branch_id is distinct from old.branch_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '42501', message = 'TEAM_IDENTITY_IMMUTABLE';
  end if;
  if char_length(btrim(new.name)) not between 2 and 120 then
    raise exception using errcode = '23514', message = 'INVALID_TEAM_NAME';
  end if;
  if new.active and not exists (
    select 1 from public.branches branch_row
    where branch_row.id = new.branch_id
      and branch_row.organization_id = new.organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_TEAM_REQUIRES_ACTIVE_BRANCH';
  end if;
  if new.manager_id is not null and (
    not app_private.user_has_team_member_role(
      new.organization_id, new.manager_id, 'TEAM_MANAGER'
    )
    or not app_private.user_scope_includes_branch(
      new.organization_id, new.manager_id, new.branch_id
    )
  ) then
    raise exception using errcode = '23514', message = 'INVALID_TEAM_MANAGER';
  end if;
  if tg_op = 'UPDATE' and old.active and not new.active
    and app_private.team_has_active_dependencies(new.organization_id, new.id)
  then
    raise exception using errcode = '23514', message = 'TEAM_HAS_ACTIVE_DEPENDENCIES';
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_team_member_administration_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_branch_id uuid;
begin
  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.user_id is distinct from old.user_id
    or new.joined_at is distinct from old.joined_at
  ) then
    raise exception using errcode = '42501', message = 'TEAM_MEMBER_IDENTITY_IMMUTABLE';
  end if;
  select team_row.branch_id into target_branch_id
  from public.teams team_row
  where team_row.id = new.team_id
    and team_row.organization_id = new.organization_id;
  if not found then
    raise exception using errcode = '23503', message = 'TEAM_NOT_IN_ORGANIZATION';
  end if;
  if new.active and (
    not app_private.user_has_team_member_role(
      new.organization_id, new.user_id, new.member_type
    )
    or not app_private.user_scope_includes_branch(
      new.organization_id, new.user_id, target_branch_id
    )
  ) then
    raise exception using errcode = '23514', message = 'INVALID_TEAM_MEMBER';
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_user_branch_access_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.branch_id is distinct from old.branch_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '42501', message = 'BRANCH_ACCESS_IDENTITY_IMMUTABLE';
  end if;
  if not exists (
    select 1 from public.branches branch_row
    where branch_row.id = new.branch_id
      and branch_row.organization_id = new.organization_id
      and branch_row.deleted_at is null
  ) or not exists (
    select 1 from public.profiles profile_row
    where profile_row.id = new.user_id
      and profile_row.organization_id = new.organization_id
      and (not new.active or (profile_row.active and profile_row.deleted_at is null))
  ) then
    raise exception using errcode = '23503', message = 'INVALID_BRANCH_ACCESS_MAPPING';
  end if;
  return new;
end;
$$;

-- Other focused administration workflows (for example user provisioning) may
-- legitimately update these mappings. Keep their aggregate concurrency tokens
-- correct even when that workflow predates the version columns.
create or replace function app_private.bump_administration_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.version = old.version then
    new.version := old.version + 1;
  elsif new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'INVALID_VERSION_INCREMENT';
  end if;
  if to_jsonb(new) ? 'updated_at' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists a_branches_bump_administration_version on public.branches;
create trigger a_branches_bump_administration_version
before update on public.branches
for each row execute function app_private.bump_administration_version();

drop trigger if exists a_teams_bump_administration_version on public.teams;
create trigger a_teams_bump_administration_version
before update on public.teams
for each row execute function app_private.bump_administration_version();

drop trigger if exists a_team_members_bump_administration_version on public.team_members;
create trigger a_team_members_bump_administration_version
before update on public.team_members
for each row execute function app_private.bump_administration_version();

drop trigger if exists a_branch_access_bump_administration_version
on public.user_branch_access;
create trigger a_branch_access_bump_administration_version
before update on public.user_branch_access
for each row execute function app_private.bump_administration_version();

drop trigger if exists branches_validate_administration on public.branches;
create trigger branches_validate_administration
before insert or update on public.branches
for each row execute function app_private.validate_branch_administration_row();

drop trigger if exists teams_validate_administration on public.teams;
create trigger teams_validate_administration
before insert or update on public.teams
for each row execute function app_private.validate_team_administration_row();

drop trigger if exists team_members_validate_administration on public.team_members;
create trigger team_members_validate_administration
before insert or update on public.team_members
for each row execute function app_private.validate_team_member_administration_row();

drop trigger if exists user_branch_access_validate_administration on public.user_branch_access;
create trigger user_branch_access_validate_administration
before insert or update on public.user_branch_access
for each row execute function app_private.validate_user_branch_access_row();

revoke insert, update, delete on public.branches from anon, authenticated;
revoke insert, update, delete on public.teams from anon, authenticated;
revoke insert, update, delete on public.team_members from anon, authenticated;
revoke insert, update, delete on public.user_branch_access from anon, authenticated;

create or replace function public.get_branch_administration_page(
  target_search text default '',
  target_status text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'updated:desc',
  target_preset text default 'MANAGE'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  normalized_status text;
  normalized_preset text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  normalized_status := upper(btrim(coalesce(target_status, 'ALL')));
  normalized_preset := upper(btrim(coalesce(target_preset, 'MANAGE')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  if normalized_status not in ('ALL', 'ACTIVE', 'INACTIVE')
    or normalized_preset not in ('MANAGE', 'ACCESS')
    or target_page < 1
    or target_page_size not in (25, 50, 100)
    or target_sort not in (
      'updated:desc', 'updated:asc', 'name:asc', 'name:desc',
      'created:desc', 'teams:desc', 'users:desc'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  with scoped as materialized (
    select
      branch_row.id,
      branch_row.version,
      branch_row.code,
      branch_row.name,
      branch_row.address,
      nullif(branch_row.address->>'city', '') as city,
      nullif(branch_row.address->>'state', '') as state,
      nullif(branch_row.address->>'postal_code', '') as postal_code,
      branch_row.contact_phone,
      branch_row.contact_email,
      branch_row.timezone,
      branch_row.working_hours,
      branch_row.showroom_category,
      branch_row.latitude,
      branch_row.longitude,
      branch_row.active,
      branch_row.created_at,
      branch_row.updated_at,
      coalesce(team_counts.total, 0)::integer as team_count,
      coalesce(team_counts.active, 0)::integer as active_team_count,
      coalesce(user_counts.total, 0)::integer as user_count,
      coalesce(manager_counts.names, '') as manager_names,
      coalesce(integration_counts.total, 0)::integer as integration_count,
      coalesce(access_counts.total, 0)::integer as explicit_access_count,
      greatest(
        branch_row.updated_at,
        coalesce(team_counts.last_updated_at, branch_row.updated_at),
        coalesce(access_counts.last_updated_at, branch_row.updated_at)
      ) as last_configured_at
    from public.branches branch_row
    left join lateral (
      select
        count(*) as total,
        count(*) filter (where team_row.active) as active,
        max(team_row.updated_at) as last_updated_at
      from public.teams team_row
      where team_row.organization_id = branch_row.organization_id
        and team_row.branch_id = branch_row.id
    ) team_counts on true
    left join lateral (
      select count(distinct assigned_user.user_id) as total
      from (
        select member_row.user_id
        from public.team_members member_row
        join public.teams member_team
          on member_team.id = member_row.team_id
         and member_team.organization_id = member_row.organization_id
        where member_row.organization_id = branch_row.organization_id
          and member_team.branch_id = branch_row.id
          and member_row.active
          and member_team.active
        union
        select branch_access_row.user_id
        from public.user_branch_access branch_access_row
        where branch_access_row.organization_id = branch_row.organization_id
          and branch_access_row.branch_id = branch_row.id
          and branch_access_row.active
        union
        select assignment_row.user_id
        from public.user_role_assignments assignment_row
        where assignment_row.organization_id = branch_row.organization_id
          and assignment_row.active
          and (
            assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
            or assignment_row.scope_branch_id = branch_row.id
            or branch_row.id = any(assignment_row.selected_branch_ids)
          )
      ) assigned_user
    ) user_counts on true
    left join lateral (
      select string_agg(distinct profile_row.full_name, ', ' order by profile_row.full_name) as names
      from public.teams team_row
      join public.profiles profile_row
        on profile_row.id = team_row.manager_id
       and profile_row.organization_id = team_row.organization_id
      where team_row.organization_id = branch_row.organization_id
        and team_row.branch_id = branch_row.id
        and team_row.active
    ) manager_counts on true
    left join lateral (
      select count(distinct mapping_row.connected_account_id) as total
      from public.integration_branch_mappings mapping_row
      join public.connected_accounts account_row
        on account_row.id = mapping_row.connected_account_id
       and account_row.organization_id = mapping_row.organization_id
       and account_row.deleted_at is null
      where mapping_row.organization_id = branch_row.organization_id
        and mapping_row.branch_id = branch_row.id
    ) integration_counts on true
    left join lateral (
      select count(*) as total, max(access_row.updated_at) as last_updated_at
      from public.user_branch_access access_row
      where access_row.organization_id = branch_row.organization_id
        and access_row.branch_id = branch_row.id
        and access_row.active
    ) access_counts on true
    where branch_row.organization_id = current_organization_id
      and branch_row.deleted_at is null
      and app_private.actor_scope_includes_branch(
        branch_row.organization_id, branch_row.id
      )
  ), filtered as materialized (
    select scoped_row.*
    from scoped scoped_row
    where (
      normalized_status = 'ALL'
      or (normalized_status = 'ACTIVE' and scoped_row.active)
      or (normalized_status = 'INACTIVE' and not scoped_row.active)
    ) and (
      normalized_search = ''
      or lower(scoped_row.name) like '%' || normalized_search || '%'
      or lower(scoped_row.code) like '%' || normalized_search || '%'
      or lower(coalesce(scoped_row.city, '')) like '%' || normalized_search || '%'
      or lower(coalesce(scoped_row.state, '')) like '%' || normalized_search || '%'
      or lower(coalesce(scoped_row.contact_phone, '')) like '%' || normalized_search || '%'
      or lower(coalesce(scoped_row.contact_email, '')) like '%' || normalized_search || '%'
    )
  ), paged as materialized (
    select filtered_row.*
    from filtered filtered_row
    order by
      case when target_sort = 'updated:desc' then filtered_row.last_configured_at end desc,
      case when target_sort = 'updated:asc' then filtered_row.last_configured_at end asc,
      case when target_sort = 'name:asc' then lower(filtered_row.name) end asc,
      case when target_sort = 'name:desc' then lower(filtered_row.name) end desc,
      case when target_sort = 'created:desc' then filtered_row.created_at end desc,
      case when target_sort = 'teams:desc' then filtered_row.team_count end desc,
      case when target_sort = 'users:desc' then filtered_row.user_count end desc,
      filtered_row.id
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(paged_row) order by
        case when target_sort = 'updated:desc' then paged_row.last_configured_at end desc,
        case when target_sort = 'updated:asc' then paged_row.last_configured_at end asc,
        case when target_sort = 'name:asc' then lower(paged_row.name) end asc,
        case when target_sort = 'name:desc' then lower(paged_row.name) end desc,
        case when target_sort = 'created:desc' then paged_row.created_at end desc,
        case when target_sort = 'teams:desc' then paged_row.team_count end desc,
        case when target_sort = 'users:desc' then paged_row.user_count end desc,
        paged_row.id
      ) from paged paged_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'kpis', jsonb_build_object(
      'total', (select count(*) from scoped),
      'active', (select count(*) from scoped where active),
      'inactive', (select count(*) from scoped where not active),
      'users_assigned', coalesce((select sum(user_count) from scoped), 0)
    ),
    'preset', normalized_preset
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_branch_administration_page(
  text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.get_branch_administration_page(
  text, text, integer, integer, text, text
) to authenticated;

create or replace function public.get_team_administration_page(
  target_search text default '',
  target_status text default 'ALL',
  target_branch_id uuid default null,
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
  normalized_search text;
  normalized_status text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  normalized_status := upper(btrim(coalesce(target_status, 'ALL')));
  if char_length(normalized_search) > 160
    or normalized_status not in ('ALL', 'ACTIVE', 'INACTIVE')
    or target_page < 1
    or target_page_size not in (25, 50, 100)
    or target_sort not in (
      'updated:desc', 'updated:asc', 'name:asc', 'name:desc',
      'members:desc', 'leads:desc'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_TEAM_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'team.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_branch_id is not null and not app_private.actor_scope_includes_branch(
    current_organization_id, target_branch_id
  ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  with scoped as materialized (
    select
      team_row.id,
      team_row.version,
      team_row.branch_id,
      branch_row.name as branch_name,
      branch_row.active as branch_active,
      team_row.name,
      team_row.manager_id,
      manager_row.full_name as manager_name,
      team_row.fresh_assignment_mode::text as fresh_assignment_mode,
      team_row.qualified_assignment_mode::text as qualified_assignment_mode,
      team_row.active,
      team_row.created_at,
      team_row.updated_at,
      coalesce(member_counts.total, 0)::integer as member_count,
      coalesce(member_counts.telecallers, 0)::integer as telecaller_count,
      coalesce(member_counts.consultants, 0)::integer as consultant_count,
      coalesce(member_counts.managers, 0)::integer as manager_count,
      coalesce(work_counts.active_leads, 0)::integer as active_lead_count,
      coalesce(work_counts.open_followups, 0)::integer as open_followup_count
    from public.teams team_row
    join public.branches branch_row
      on branch_row.id = team_row.branch_id
     and branch_row.organization_id = team_row.organization_id
     and branch_row.deleted_at is null
    left join public.profiles manager_row
      on manager_row.id = team_row.manager_id
     and manager_row.organization_id = team_row.organization_id
    left join lateral (
      select
        count(*) filter (where member_row.active) as total,
        count(*) filter (
          where member_row.active and member_row.member_type = 'TELECALLER_BDC'
        ) as telecallers,
        count(*) filter (
          where member_row.active and member_row.member_type = 'SALES_CONSULTANT'
        ) as consultants,
        count(*) filter (
          where member_row.active and member_row.member_type = 'TEAM_MANAGER'
        ) as managers
      from public.team_members member_row
      where member_row.organization_id = team_row.organization_id
        and member_row.team_id = team_row.id
    ) member_counts on true
    left join lateral (
      select
        count(*) filter (
          where lead_row.deleted_at is null and lead_row.lifecycle_status <> 'Lost'
        ) as active_leads,
        (
          select count(*) from public.followups followup_row
          where followup_row.organization_id = team_row.organization_id
            and followup_row.team_id = team_row.id
            and followup_row.status in ('OPEN', 'OVERDUE')
        ) as open_followups
      from public.leads lead_row
      where lead_row.organization_id = team_row.organization_id
        and lead_row.team_id = team_row.id
    ) work_counts on true
    where team_row.organization_id = current_organization_id
      and app_private.actor_scope_includes_branch(
        team_row.organization_id, team_row.branch_id
      )
      and (target_branch_id is null or team_row.branch_id = target_branch_id)
  ), filtered as materialized (
    select scoped_row.* from scoped scoped_row
    where (
      normalized_status = 'ALL'
      or (normalized_status = 'ACTIVE' and scoped_row.active)
      or (normalized_status = 'INACTIVE' and not scoped_row.active)
    ) and (
      normalized_search = ''
      or lower(scoped_row.name) like '%' || normalized_search || '%'
      or lower(scoped_row.branch_name) like '%' || normalized_search || '%'
      or lower(coalesce(scoped_row.manager_name, '')) like '%' || normalized_search || '%'
    )
  ), paged as materialized (
    select filtered_row.* from filtered filtered_row
    order by
      case when target_sort = 'updated:desc' then filtered_row.updated_at end desc,
      case when target_sort = 'updated:asc' then filtered_row.updated_at end asc,
      case when target_sort = 'name:asc' then lower(filtered_row.name) end asc,
      case when target_sort = 'name:desc' then lower(filtered_row.name) end desc,
      case when target_sort = 'members:desc' then filtered_row.member_count end desc,
      case when target_sort = 'leads:desc' then filtered_row.active_lead_count end desc,
      filtered_row.id
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(to_jsonb(paged_row) order by
        case when target_sort = 'updated:desc' then paged_row.updated_at end desc,
        case when target_sort = 'updated:asc' then paged_row.updated_at end asc,
        case when target_sort = 'name:asc' then lower(paged_row.name) end asc,
        case when target_sort = 'name:desc' then lower(paged_row.name) end desc,
        case when target_sort = 'members:desc' then paged_row.member_count end desc,
        case when target_sort = 'leads:desc' then paged_row.active_lead_count end desc,
        paged_row.id
      ) from paged paged_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'kpis', jsonb_build_object(
      'total', (select count(*) from scoped),
      'active', (select count(*) from scoped where active),
      'telecallers', coalesce((select sum(telecaller_count) from scoped), 0),
      'consultants', coalesce((select sum(consultant_count) from scoped), 0)
    ),
    'branches', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', branch_row.id, 'name', branch_row.name)
        order by branch_row.name
      )
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.deleted_at is null
        and app_private.actor_scope_includes_branch(
          branch_row.organization_id, branch_row.id
        )
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_team_administration_page(
  text, text, uuid, integer, integer, text
) from public, anon;
grant execute on function public.get_team_administration_page(
  text, text, uuid, integer, integer, text
) to authenticated;

create or replace function public.get_team_administration_options(
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_search text default ''
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  resolved_branch_id uuid;
  normalized_search text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'team.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_team_id is not null then
    select team_row.branch_id into resolved_branch_id
    from public.teams team_row
    where team_row.id = target_team_id
      and team_row.organization_id = current_organization_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'TEAM_NOT_FOUND';
    end if;
    if target_branch_id is not null and target_branch_id <> resolved_branch_id then
      raise exception using errcode = '23514', message = 'TEAM_BRANCH_MISMATCH';
    end if;
  else
    resolved_branch_id := target_branch_id;
  end if;
  if resolved_branch_id is not null and not app_private.actor_scope_includes_branch(
    current_organization_id, resolved_branch_id
  ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  select jsonb_build_object(
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', branch_row.id,
        'name', branch_row.name,
        'code', branch_row.code,
        'active', branch_row.active
      ) order by branch_row.name)
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.deleted_at is null
        and app_private.actor_scope_includes_branch(
          branch_row.organization_id, branch_row.id
        )
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(to_jsonb(candidate_row) order by candidate_row.name)
      from (
        select
          profile_row.id,
          profile_row.full_name as name,
          profile_row.email,
          case
            when bool_or(role_row.role_key = 'team_manager') then 'TEAM_MANAGER'
            when bool_or(role_row.role_key = 'sales_consultant') then 'SALES_CONSULTANT'
            when bool_or(role_row.role_key = 'telecaller_bdc') then 'TELECALLER_BDC'
          end as member_type,
          member_row.active as membership_active,
          member_row.version as membership_version,
          member_row.eligible_for_fresh_leads,
          member_row.eligible_for_qualified_leads,
          other_team.id as other_team_id,
          other_team.name as other_team_name
        from public.profiles profile_row
        join public.user_role_assignments assignment_row
          on assignment_row.organization_id = profile_row.organization_id
         and assignment_row.user_id = profile_row.id
         and assignment_row.active
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
         and role_row.role_key in ('team_manager', 'sales_consultant', 'telecaller_bdc')
        left join public.team_members member_row
          on member_row.organization_id = profile_row.organization_id
         and member_row.team_id = target_team_id
         and member_row.user_id = profile_row.id
        left join lateral (
          select team_row.id, team_row.name
          from public.team_members other_member
          join public.teams team_row
            on team_row.id = other_member.team_id
           and team_row.organization_id = other_member.organization_id
          where other_member.organization_id = profile_row.organization_id
            and other_member.user_id = profile_row.id
            and other_member.active
            and (target_team_id is null or other_member.team_id <> target_team_id)
          order by other_member.updated_at desc
          limit 1
        ) other_team on true
        where profile_row.organization_id = current_organization_id
          and profile_row.active
          and profile_row.deleted_at is null
          and resolved_branch_id is not null
          and app_private.user_scope_includes_branch(
            current_organization_id, profile_row.id, resolved_branch_id
          )
          and app_private.actor_can_administer_user(
            current_organization_id, profile_row.id
          )
          and (
            normalized_search = ''
            or lower(profile_row.full_name) like '%' || normalized_search || '%'
            or lower(profile_row.email) like '%' || normalized_search || '%'
            or lower(coalesce(profile_row.employee_id, '')) like '%' || normalized_search || '%'
          )
        group by
          profile_row.id, profile_row.full_name, profile_row.email,
          member_row.active, member_row.version,
          member_row.eligible_for_fresh_leads,
          member_row.eligible_for_qualified_leads,
          other_team.id, other_team.name
        order by profile_row.full_name
        limit 100
      ) candidate_row
      where candidate_row.member_type is not null
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_team_administration_options(uuid, uuid, text)
from public, anon;
grant execute on function public.get_team_administration_options(uuid, uuid, text)
to authenticated;

create or replace function public.get_branch_access_options(
  target_branch_id uuid,
  target_search text default ''
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if target_branch_id is null or char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_ACCESS_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
    or not app_private.has_permission(current_organization_id, 'user.manage')
    or not app_private.actor_scope_includes_branch(
      current_organization_id, target_branch_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select jsonb_build_object(
    'users', coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.name), '[]'::jsonb)
  ) into result
  from (
    select
      profile_row.id,
      profile_row.full_name as name,
      profile_row.email,
      coalesce(string_agg(distinct role_row.name, ', ' order by role_row.name), 'No active role') as roles,
      coalesce(access_row.active, false) as explicit_access,
      coalesce(access_row.version, 0) as access_version,
      exists (
        select 1
        from public.user_role_assignments inherited_assignment
        where inherited_assignment.organization_id = current_organization_id
          and inherited_assignment.user_id = profile_row.id
          and inherited_assignment.active
          and (
            inherited_assignment.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
            or inherited_assignment.scope_branch_id = target_branch_id
            or target_branch_id = any(inherited_assignment.selected_branch_ids)
          )
      ) or exists (
        select 1
        from public.team_members inherited_member
        join public.teams inherited_team
          on inherited_team.id = inherited_member.team_id
         and inherited_team.organization_id = inherited_member.organization_id
        where inherited_member.organization_id = current_organization_id
          and inherited_member.user_id = profile_row.id
          and inherited_member.active
          and inherited_team.active
          and inherited_team.branch_id = target_branch_id
      ) as inherited_access
    from public.profiles profile_row
    left join public.user_role_assignments assignment_row
      on assignment_row.organization_id = profile_row.organization_id
     and assignment_row.user_id = profile_row.id
     and assignment_row.active
    left join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    left join public.user_branch_access access_row
      on access_row.organization_id = profile_row.organization_id
     and access_row.user_id = profile_row.id
     and access_row.branch_id = target_branch_id
    where profile_row.organization_id = current_organization_id
      and profile_row.active
      and profile_row.deleted_at is null
      and app_private.actor_can_administer_user(
        current_organization_id, profile_row.id
      )
      and (
        normalized_search = ''
        or lower(profile_row.full_name) like '%' || normalized_search || '%'
        or lower(profile_row.email) like '%' || normalized_search || '%'
        or lower(coalesce(profile_row.employee_id, '')) like '%' || normalized_search || '%'
      )
    group by profile_row.id, profile_row.full_name, profile_row.email,
      access_row.active, access_row.version
    order by profile_row.full_name
    limit 100
  ) option_row;
  return result;
end;
$$;

revoke all on function public.get_branch_access_options(uuid, text) from public, anon;
grant execute on function public.get_branch_access_options(uuid, text) to authenticated;

create or replace function public.create_branch(
  branch_name text,
  branch_code text,
  branch_address jsonb default '{}'::jsonb,
  branch_contact_phone text default null,
  branch_contact_email text default null,
  branch_timezone text default 'Asia/Kolkata',
  branch_working_hours jsonb default '{}'::jsonb,
  branch_showroom_category text default null,
  branch_latitude numeric default null,
  branch_longitude numeric default null,
  target_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_code text;
  request_fingerprint text;
  replay_result jsonb;
  new_branch public.branches%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
    or not app_private.has_organization_wide_scope(current_organization_id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  normalized_code := upper(btrim(coalesce(branch_code, '')));
  if char_length(btrim(coalesce(branch_name, ''))) not between 2 and 120
    or char_length(normalized_code) not between 2 and 24
    or normalized_code !~ '^[A-Z0-9][A-Z0-9_-]*$'
    or branch_address is null or jsonb_typeof(branch_address) <> 'object'
    or branch_working_hours is null or jsonb_typeof(branch_working_hours) <> 'object'
    or branch_timezone is null or char_length(branch_timezone) > 64
    or char_length(coalesce(branch_contact_phone, '')) > 32
    or char_length(coalesce(branch_contact_email, '')) > 254
    or char_length(coalesce(branch_showroom_category, '')) > 120
    or (
      nullif(btrim(coalesce(branch_contact_email, '')), '') is not null
      and btrim(branch_contact_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_INPUT';
  end if;
  request_fingerprint := app_private.administration_request_fingerprint(jsonb_build_object(
    'name', btrim(branch_name), 'code', normalized_code,
    'address', branch_address, 'phone', nullif(btrim(branch_contact_phone), ''),
    'email', nullif(lower(btrim(branch_contact_email)), ''),
    'timezone', branch_timezone, 'working_hours', branch_working_hours,
    'showroom_category', nullif(btrim(branch_showroom_category), ''),
    'latitude', branch_latitude, 'longitude', branch_longitude
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':branch.created:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_administration_request(
    current_organization_id, 'branch.created', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if exists (
    select 1 from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.deleted_at is null
      and (lower(branch_row.code) = lower(normalized_code)
        or lower(branch_row.name) = lower(btrim(branch_name)))
  ) then
    raise exception using errcode = '23505', message = 'BRANCH_NAME_OR_CODE_EXISTS';
  end if;

  insert into public.branches (
    organization_id, code, name, address, contact_phone, contact_email,
    timezone, working_hours, showroom_category, latitude, longitude
  ) values (
    current_organization_id, normalized_code, btrim(branch_name), branch_address,
    nullif(btrim(branch_contact_phone), ''), nullif(lower(btrim(branch_contact_email)), ''),
    branch_timezone, branch_working_hours, nullif(btrim(branch_showroom_category), ''),
    branch_latitude, branch_longitude
  ) returning * into new_branch;
  result := jsonb_build_object(
    'id', new_branch.id, 'version', new_branch.version,
    'active', new_branch.active, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'branch.created', 'branch',
    new_branch.id::text, new_branch.id, target_request_id,
    jsonb_build_object(
      'fingerprint', request_fingerprint, 'result', result,
      'code', new_branch.code, 'name', new_branch.name
    )
  );
  return result;
end;
$$;

revoke all on function public.create_branch(
  text, text, jsonb, text, text, text, jsonb, text, numeric, numeric, uuid
) from public, anon;
grant execute on function public.create_branch(
  text, text, jsonb, text, text, text, jsonb, text, numeric, numeric, uuid
) to authenticated;

create or replace function public.update_branch(
  target_branch_id uuid,
  expected_version bigint,
  branch_name text,
  branch_code text,
  branch_address jsonb,
  branch_contact_phone text,
  branch_contact_email text,
  branch_timezone text,
  branch_working_hours jsonb,
  branch_showroom_category text,
  branch_latitude numeric,
  branch_longitude numeric,
  branch_active boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_branch public.branches%rowtype;
  updated_branch public.branches%rowtype;
  normalized_code text;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_branch_id is null or expected_version is null or target_request_id is null then
    raise exception using errcode = '22023', message = 'BRANCH_UPDATE_INPUT_REQUIRED';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
    or not app_private.actor_scope_includes_branch(
      current_organization_id, target_branch_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  normalized_code := upper(btrim(coalesce(branch_code, '')));
  if char_length(btrim(coalesce(branch_name, ''))) not between 2 and 120
    or char_length(normalized_code) not between 2 and 24
    or normalized_code !~ '^[A-Z0-9][A-Z0-9_-]*$'
    or branch_address is null or jsonb_typeof(branch_address) <> 'object'
    or branch_working_hours is null or jsonb_typeof(branch_working_hours) <> 'object'
    or branch_timezone is null or char_length(branch_timezone) > 64
    or branch_active is null
    or char_length(coalesce(branch_contact_phone, '')) > 32
    or char_length(coalesce(branch_contact_email, '')) > 254
    or char_length(coalesce(branch_showroom_category, '')) > 120
    or (
      nullif(btrim(coalesce(branch_contact_email, '')), '') is not null
      and btrim(branch_contact_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_INPUT';
  end if;
  request_fingerprint := app_private.administration_request_fingerprint(jsonb_build_object(
    'id', target_branch_id, 'expected_version', expected_version,
    'name', btrim(branch_name), 'code', normalized_code,
    'address', branch_address, 'phone', nullif(btrim(branch_contact_phone), ''),
    'email', nullif(lower(btrim(branch_contact_email)), ''),
    'timezone', branch_timezone, 'working_hours', branch_working_hours,
    'showroom_category', nullif(btrim(branch_showroom_category), ''),
    'latitude', branch_latitude, 'longitude', branch_longitude, 'active', branch_active
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':branch.updated:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_administration_request(
    current_organization_id, 'branch.updated', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into current_branch
  from public.branches source_row
  where source_row.id = target_branch_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'BRANCH_NOT_FOUND';
  end if;
  if current_branch.version <> expected_version then
    raise exception using errcode = '40001', message = 'BRANCH_VERSION_CONFLICT';
  end if;
  if exists (
    select 1 from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.id <> target_branch_id
      and branch_row.deleted_at is null
      and (lower(branch_row.code) = lower(normalized_code)
        or lower(branch_row.name) = lower(btrim(branch_name)))
  ) then
    raise exception using errcode = '23505', message = 'BRANCH_NAME_OR_CODE_EXISTS';
  end if;
  if current_branch.active and not branch_active
    and app_private.branch_has_active_dependencies(
      current_organization_id, target_branch_id
    )
  then
    raise exception using errcode = '23514', message = 'BRANCH_HAS_ACTIVE_DEPENDENCIES';
  end if;
  update public.branches
  set name = btrim(branch_name),
      code = normalized_code,
      address = branch_address,
      contact_phone = nullif(btrim(branch_contact_phone), ''),
      contact_email = nullif(lower(btrim(branch_contact_email)), ''),
      timezone = branch_timezone,
      working_hours = branch_working_hours,
      showroom_category = nullif(btrim(branch_showroom_category), ''),
      latitude = branch_latitude,
      longitude = branch_longitude,
      active = branch_active,
      version = version + 1,
      updated_at = now()
  where id = target_branch_id
    and organization_id = current_organization_id
  returning * into updated_branch;
  result := jsonb_build_object(
    'id', updated_branch.id, 'version', updated_branch.version,
    'active', updated_branch.active, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'branch.updated', 'branch',
    updated_branch.id::text, updated_branch.id, target_request_id,
    jsonb_build_object(
      'fingerprint', request_fingerprint, 'result', result,
      'previous_version', current_branch.version,
      'previous_active', current_branch.active,
      'active', updated_branch.active,
      'code', updated_branch.code, 'name', updated_branch.name
    )
  );
  return result;
end;
$$;

revoke all on function public.update_branch(
  uuid, bigint, text, text, jsonb, text, text, text, jsonb, text,
  numeric, numeric, boolean, uuid
) from public, anon;
grant execute on function public.update_branch(
  uuid, bigint, text, text, jsonb, text, text, text, jsonb, text,
  numeric, numeric, boolean, uuid
) to authenticated;

create or replace function public.create_team(
  target_branch_id uuid,
  team_name text,
  target_manager_id uuid default null,
  fresh_mode public.assignment_mode default 'ROUND_ROBIN',
  qualified_mode public.assignment_mode default 'ROUND_ROBIN',
  target_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  request_fingerprint text;
  replay_result jsonb;
  new_team public.teams%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_branch_id is null or target_request_id is null
    or char_length(btrim(coalesce(team_name, ''))) not between 2 and 120
  then
    raise exception using errcode = '22023', message = 'INVALID_TEAM_INPUT';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'team.manage')
    or not app_private.actor_scope_includes_branch(
      current_organization_id, target_branch_id
    )
    or not exists (
      select 1 from public.branches branch_row
      where branch_row.id = target_branch_id
        and branch_row.organization_id = current_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_manager_id is not null and (
    not app_private.actor_can_administer_user(
      current_organization_id, target_manager_id
    )
    or not app_private.user_has_team_member_role(
      current_organization_id, target_manager_id, 'TEAM_MANAGER'
    )
    or not app_private.user_scope_includes_branch(
      current_organization_id, target_manager_id, target_branch_id
    )
  ) then
    raise exception using errcode = '42501', message = 'INVALID_TEAM_MANAGER';
  end if;
  request_fingerprint := app_private.administration_request_fingerprint(jsonb_build_object(
    'branch_id', target_branch_id, 'name', btrim(team_name),
    'manager_id', target_manager_id, 'fresh_mode', fresh_mode,
    'qualified_mode', qualified_mode
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':team.created:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_administration_request(
    current_organization_id, 'team.created', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  if exists (
    select 1 from public.teams team_row
    where team_row.organization_id = current_organization_id
      and team_row.branch_id = target_branch_id
      and lower(team_row.name) = lower(btrim(team_name))
  ) then
    raise exception using errcode = '23505', message = 'TEAM_NAME_EXISTS';
  end if;
  if target_manager_id is not null and exists (
    select 1
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
    where member_row.organization_id = current_organization_id
      and member_row.user_id = target_manager_id
      and member_row.active
      and team_row.active
  ) then
    raise exception using errcode = '23514', message = 'USER_ALREADY_IN_ACTIVE_TEAM';
  end if;

  insert into public.teams (
    organization_id, branch_id, name, manager_id,
    fresh_assignment_mode, qualified_assignment_mode
  ) values (
    current_organization_id, target_branch_id, btrim(team_name), target_manager_id,
    fresh_mode, qualified_mode
  ) returning * into new_team;
  if target_manager_id is not null then
    insert into public.team_members (
      organization_id, team_id, user_id, member_type,
      eligible_for_fresh_leads, eligible_for_qualified_leads
    ) values (
      current_organization_id, new_team.id, target_manager_id, 'TEAM_MANAGER',
      false, false
    );
  end if;
  result := jsonb_build_object(
    'id', new_team.id, 'version', new_team.version,
    'active', new_team.active, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'team.created', 'team',
    new_team.id::text, new_team.branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', request_fingerprint, 'result', result,
      'name', new_team.name, 'manager_id', new_team.manager_id,
      'fresh_assignment_mode', new_team.fresh_assignment_mode,
      'qualified_assignment_mode', new_team.qualified_assignment_mode
    )
  );
  return result;
end;
$$;

revoke all on function public.create_team(
  uuid, text, uuid, public.assignment_mode, public.assignment_mode, uuid
) from public, anon;
grant execute on function public.create_team(
  uuid, text, uuid, public.assignment_mode, public.assignment_mode, uuid
) to authenticated;

create or replace function public.update_team(
  target_team_id uuid,
  expected_version bigint,
  team_name text,
  target_manager_id uuid,
  fresh_mode public.assignment_mode,
  qualified_mode public.assignment_mode,
  team_active boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_team public.teams%rowtype;
  updated_team public.teams%rowtype;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_team_id is null or expected_version is null or target_request_id is null
    or team_active is null
    or char_length(btrim(coalesce(team_name, ''))) not between 2 and 120
  then
    raise exception using errcode = '22023', message = 'INVALID_TEAM_INPUT';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'team.manage')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  request_fingerprint := app_private.administration_request_fingerprint(jsonb_build_object(
    'id', target_team_id, 'expected_version', expected_version,
    'name', btrim(team_name), 'manager_id', target_manager_id,
    'fresh_mode', fresh_mode, 'qualified_mode', qualified_mode,
    'active', team_active
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':team.updated:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_administration_request(
    current_organization_id, 'team.updated', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into current_team
  from public.teams source_row
  where source_row.id = target_team_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TEAM_NOT_FOUND';
  end if;
  if not app_private.actor_scope_includes_branch(
    current_organization_id, current_team.branch_id
  ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if current_team.version <> expected_version then
    raise exception using errcode = '40001', message = 'TEAM_VERSION_CONFLICT';
  end if;
  if exists (
    select 1 from public.teams team_row
    where team_row.organization_id = current_organization_id
      and team_row.branch_id = current_team.branch_id
      and team_row.id <> target_team_id
      and lower(team_row.name) = lower(btrim(team_name))
  ) then
    raise exception using errcode = '23505', message = 'TEAM_NAME_EXISTS';
  end if;
  if team_active and not exists (
    select 1 from public.branches branch_row
    where branch_row.id = current_team.branch_id
      and branch_row.organization_id = current_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_TEAM_REQUIRES_ACTIVE_BRANCH';
  end if;
  if current_team.active and not team_active
    and app_private.team_has_active_dependencies(
      current_organization_id, target_team_id
    )
  then
    raise exception using errcode = '23514', message = 'TEAM_HAS_ACTIVE_DEPENDENCIES';
  end if;
  if target_manager_id is not null and (
    not app_private.actor_can_administer_user(
      current_organization_id, target_manager_id
    )
    or not app_private.user_has_team_member_role(
      current_organization_id, target_manager_id, 'TEAM_MANAGER'
    )
    or not app_private.user_scope_includes_branch(
      current_organization_id, target_manager_id, current_team.branch_id
    )
  ) then
    raise exception using errcode = '42501', message = 'INVALID_TEAM_MANAGER';
  end if;
  if target_manager_id is distinct from current_team.manager_id
    and target_manager_id is not null
    and exists (
      select 1
      from public.team_members member_row
      join public.teams team_row
        on team_row.id = member_row.team_id
       and team_row.organization_id = member_row.organization_id
      where member_row.organization_id = current_organization_id
        and member_row.user_id = target_manager_id
        and member_row.active
        and team_row.active
        and member_row.team_id <> target_team_id
    )
  then
    raise exception using errcode = '23514', message = 'USER_ALREADY_IN_ACTIVE_TEAM';
  end if;

  update public.teams
  set name = btrim(team_name),
      manager_id = target_manager_id,
      fresh_assignment_mode = fresh_mode,
      qualified_assignment_mode = qualified_mode,
      active = team_active,
      version = version + 1,
      updated_at = now()
  where id = target_team_id
    and organization_id = current_organization_id
  returning * into updated_team;

  if target_manager_id is distinct from current_team.manager_id then
    if current_team.manager_id is not null then
      update public.team_members
      set active = false, version = version + 1, updated_at = now()
      where organization_id = current_organization_id
        and team_id = target_team_id
        and user_id = current_team.manager_id
        and member_type = 'TEAM_MANAGER'
        and active;
    end if;
    if target_manager_id is not null then
      insert into public.team_members (
        organization_id, team_id, user_id, member_type,
        eligible_for_fresh_leads, eligible_for_qualified_leads
      ) values (
        current_organization_id, target_team_id, target_manager_id,
        'TEAM_MANAGER', false, false
      )
      on conflict (team_id, user_id) do update
      set member_type = 'TEAM_MANAGER', active = true,
          eligible_for_fresh_leads = false,
          eligible_for_qualified_leads = false,
          version = public.team_members.version + 1,
          updated_at = now();
    end if;
  end if;
  result := jsonb_build_object(
    'id', updated_team.id, 'version', updated_team.version,
    'active', updated_team.active, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'team.updated', 'team',
    updated_team.id::text, updated_team.branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', request_fingerprint, 'result', result,
      'previous_version', current_team.version,
      'previous_active', current_team.active, 'active', updated_team.active,
      'previous_manager_id', current_team.manager_id,
      'manager_id', updated_team.manager_id,
      'fresh_assignment_mode', updated_team.fresh_assignment_mode,
      'qualified_assignment_mode', updated_team.qualified_assignment_mode
    )
  );
  return result;
end;
$$;

revoke all on function public.update_team(
  uuid, bigint, text, uuid, public.assignment_mode,
  public.assignment_mode, boolean, uuid
) from public, anon;
grant execute on function public.update_team(
  uuid, bigint, text, uuid, public.assignment_mode,
  public.assignment_mode, boolean, uuid
) to authenticated;

create or replace function public.set_team_member(
  target_team_id uuid,
  expected_team_version bigint,
  target_user_id uuid,
  target_member_type text,
  member_active boolean,
  eligible_for_fresh boolean default false,
  eligible_for_qualified boolean default false,
  move_from_existing boolean default false,
  target_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_team public.teams%rowtype;
  current_member public.team_members%rowtype;
  saved_member public.team_members%rowtype;
  other_membership record;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
  moved_team_ids uuid[] := '{}';
  resolved_manager_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_team_id is null or expected_team_version is null
    or target_user_id is null or target_request_id is null
    or member_active is null
    or target_member_type not in ('TEAM_MANAGER', 'SALES_CONSULTANT', 'TELECALLER_BDC')
  then
    raise exception using errcode = '22023', message = 'INVALID_TEAM_MEMBER_INPUT';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'team.manage')
    or not app_private.actor_can_administer_user(
      current_organization_id, target_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  request_fingerprint := app_private.administration_request_fingerprint(jsonb_build_object(
    'team_id', target_team_id, 'expected_team_version', expected_team_version,
    'user_id', target_user_id, 'member_type', target_member_type,
    'active', member_active, 'eligible_for_fresh', eligible_for_fresh,
    'eligible_for_qualified', eligible_for_qualified,
    'move_from_existing', move_from_existing
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':team.member_changed:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_administration_request(
    current_organization_id, 'team.member_changed', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into current_team
  from public.teams source_row
  where source_row.id = target_team_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TEAM_NOT_FOUND';
  end if;
  if not app_private.actor_scope_includes_branch(
    current_organization_id, current_team.branch_id
  ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if current_team.version <> expected_team_version then
    raise exception using errcode = '40001', message = 'TEAM_VERSION_CONFLICT';
  end if;
  resolved_manager_id := current_team.manager_id;
  if member_active and (
    not current_team.active
    or not app_private.user_has_team_member_role(
      current_organization_id, target_user_id, target_member_type
    )
    or not app_private.user_scope_includes_branch(
      current_organization_id, target_user_id, current_team.branch_id
    )
  ) then
    raise exception using errcode = '23514', message = 'INVALID_TEAM_MEMBER';
  end if;

  select * into current_member
  from public.team_members source_row
  where source_row.organization_id = current_organization_id
    and source_row.team_id = target_team_id
    and source_row.user_id = target_user_id
  for update;
  if not member_active and not found then
    raise exception using errcode = 'P0002', message = 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if member_active then
    for other_membership in
      select member_row.team_id, team_row.branch_id, team_row.manager_id
      from public.team_members member_row
      join public.teams team_row
        on team_row.id = member_row.team_id
       and team_row.organization_id = member_row.organization_id
      where member_row.organization_id = current_organization_id
        and member_row.user_id = target_user_id
        and member_row.active
        and member_row.team_id <> target_team_id
      for update of member_row, team_row
    loop
      if not move_from_existing then
        raise exception using errcode = '23514', message = 'USER_ALREADY_IN_ACTIVE_TEAM';
      end if;
      if not app_private.actor_scope_includes_branch(
        current_organization_id, other_membership.branch_id
      ) then
        raise exception using errcode = '42501', message = 'MOVE_SOURCE_SCOPE_DENIED';
      end if;
      if other_membership.manager_id = target_user_id then
        update public.teams
        set manager_id = null, version = version + 1, updated_at = now()
        where id = other_membership.team_id
          and organization_id = current_organization_id;
      else
        update public.teams
        set version = version + 1, updated_at = now()
        where id = other_membership.team_id
          and organization_id = current_organization_id;
      end if;
      update public.team_members
      set active = false, version = version + 1, updated_at = now()
      where organization_id = current_organization_id
        and team_id = other_membership.team_id
        and user_id = target_user_id;
      moved_team_ids := array_append(moved_team_ids, other_membership.team_id);
    end loop;
  end if;

  if target_member_type = 'TEAM_MANAGER' and member_active then
    if current_team.manager_id is not null
      and current_team.manager_id <> target_user_id
    then
      update public.team_members
      set active = false, version = version + 1, updated_at = now()
      where organization_id = current_organization_id
        and team_id = target_team_id
        and user_id = current_team.manager_id
        and member_type = 'TEAM_MANAGER'
        and active;
    end if;
    resolved_manager_id := target_user_id;
  elsif resolved_manager_id = target_user_id and not member_active then
    resolved_manager_id := null;
  elsif resolved_manager_id = target_user_id
    and target_member_type <> 'TEAM_MANAGER'
  then
    raise exception using errcode = '23514', message = 'TEAM_MANAGER_ROLE_CHANGE_REQUIRES_REPLACEMENT';
  end if;

  insert into public.team_members (
    organization_id, team_id, user_id, member_type,
    eligible_for_fresh_leads, eligible_for_qualified_leads, active
  ) values (
    current_organization_id, target_team_id, target_user_id, target_member_type,
    case when target_member_type = 'TEAM_MANAGER' then false else eligible_for_fresh end,
    case when target_member_type = 'TEAM_MANAGER' then false else eligible_for_qualified end,
    member_active
  )
  on conflict (team_id, user_id) do update
  set member_type = excluded.member_type,
      eligible_for_fresh_leads = excluded.eligible_for_fresh_leads,
      eligible_for_qualified_leads = excluded.eligible_for_qualified_leads,
      active = excluded.active,
      version = public.team_members.version + 1,
      updated_at = now()
  returning * into saved_member;

  update public.teams
  set manager_id = resolved_manager_id,
      version = version + 1,
      updated_at = now()
  where id = target_team_id
    and organization_id = current_organization_id
  returning * into current_team;
  result := jsonb_build_object(
    'id', current_team.id,
    'version', current_team.version,
    'membership_version', saved_member.version,
    'user_id', saved_member.user_id,
    'active', saved_member.active,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'team.member_changed', 'team',
    current_team.id::text, current_team.branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', request_fingerprint, 'result', result,
      'target_user_id', target_user_id,
      'member_type', target_member_type,
      'active', member_active,
      'moved_from_team_ids', moved_team_ids,
      'eligible_for_fresh_leads', saved_member.eligible_for_fresh_leads,
      'eligible_for_qualified_leads', saved_member.eligible_for_qualified_leads
    )
  );
  return result;
end;
$$;

revoke all on function public.set_team_member(
  uuid, bigint, uuid, text, boolean, boolean, boolean, boolean, uuid
) from public, anon;
grant execute on function public.set_team_member(
  uuid, bigint, uuid, text, boolean, boolean, boolean, boolean, uuid
) to authenticated;

create or replace function public.set_user_branch_access(
  target_branch_id uuid,
  target_user_id uuid,
  expected_version bigint,
  grant_access boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_access public.user_branch_access%rowtype;
  saved_access public.user_branch_access%rowtype;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
  result_version bigint;
  result_active boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_branch_id is null or target_user_id is null
    or expected_version is null or expected_version < 0
    or grant_access is null or target_request_id is null
  then
    raise exception using errcode = '22023', message = 'INVALID_BRANCH_ACCESS_INPUT';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
    or not app_private.has_permission(current_organization_id, 'user.manage')
    or not app_private.actor_scope_includes_branch(
      current_organization_id, target_branch_id
    )
    or not app_private.actor_can_administer_user(
      current_organization_id, target_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  request_fingerprint := app_private.administration_request_fingerprint(jsonb_build_object(
    'branch_id', target_branch_id, 'user_id', target_user_id,
    'expected_version', expected_version, 'grant_access', grant_access
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':branch.access_changed:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_administration_request(
    current_organization_id, 'branch.access_changed',
    target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into current_access
  from public.user_branch_access source_row
  where source_row.organization_id = current_organization_id
    and source_row.branch_id = target_branch_id
    and source_row.user_id = target_user_id
  for update;
  if found then
    if current_access.version <> expected_version then
      raise exception using errcode = '40001', message = 'BRANCH_ACCESS_VERSION_CONFLICT';
    end if;
    update public.user_branch_access
    set active = grant_access,
        granted_by = auth.uid(),
        revoked_at = case when grant_access then null else now() end,
        revoked_by = case when grant_access then null else auth.uid() end,
        version = version + 1,
        updated_at = now()
    where organization_id = current_organization_id
      and branch_id = target_branch_id
      and user_id = target_user_id
    returning * into saved_access;
    result_version := saved_access.version;
    result_active := saved_access.active;
  else
    if expected_version <> 0 then
      raise exception using errcode = '40001', message = 'BRANCH_ACCESS_VERSION_CONFLICT';
    end if;
    if grant_access then
      insert into public.user_branch_access (
        organization_id, user_id, branch_id, granted_by, active
      ) values (
        current_organization_id, target_user_id, target_branch_id, auth.uid(), true
      ) returning * into saved_access;
      result_version := saved_access.version;
      result_active := saved_access.active;
    else
      result_version := 0;
      result_active := false;
    end if;
  end if;
  result := jsonb_build_object(
    'branch_id', target_branch_id, 'user_id', target_user_id,
    'version', result_version, 'active', result_active,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'branch.access_changed',
    'user_branch_access', target_user_id::text, target_branch_id,
    target_request_id, jsonb_build_object(
      'fingerprint', request_fingerprint, 'result', result,
      'target_user_id', target_user_id,
      'previous_active', case when current_access.user_id is null then null else current_access.active end,
      'active', result_active
    )
  );
  return result;
end;
$$;

revoke all on function public.set_user_branch_access(
  uuid, uuid, bigint, boolean, uuid
) from public, anon;
grant execute on function public.set_user_branch_access(
  uuid, uuid, bigint, boolean, uuid
) to authenticated;

-- Add the private administration topic without exposing row payloads. Later
-- migrations may extend this allow-list further, so both helpers and the read
-- policy are replaced together.
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
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration)$'
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
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration)$'
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
          else false
        end
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_branches_administration_invalidate on public.branches;
create trigger realtime_branches_administration_invalidate
after insert or update on public.branches
for each row execute function app_private.broadcast_tenant_invalidation('administration');

drop trigger if exists realtime_teams_administration_invalidate on public.teams;
create trigger realtime_teams_administration_invalidate
after insert or update on public.teams
for each row execute function app_private.broadcast_tenant_invalidation('administration');

drop trigger if exists realtime_team_members_administration_invalidate on public.team_members;
create trigger realtime_team_members_administration_invalidate
after insert or update on public.team_members
for each row execute function app_private.broadcast_tenant_invalidation('administration');

drop trigger if exists realtime_branch_access_administration_invalidate
on public.user_branch_access;
create trigger realtime_branch_access_administration_invalidate
after insert or update on public.user_branch_access
for each row execute function app_private.broadcast_tenant_invalidation('administration');

drop trigger if exists realtime_profiles_administration_invalidate on public.profiles;
create trigger realtime_profiles_administration_invalidate
after insert or update on public.profiles
for each row execute function app_private.broadcast_tenant_invalidation('administration');

drop trigger if exists realtime_assignments_administration_invalidate
on public.user_role_assignments;
create trigger realtime_assignments_administration_invalidate
after insert or update on public.user_role_assignments
for each row execute function app_private.broadcast_tenant_invalidation('administration');

drop trigger if exists realtime_roles_administration_invalidate on public.roles;
create trigger realtime_roles_administration_invalidate
after insert or update on public.roles
for each row execute function app_private.broadcast_tenant_invalidation('administration');

revoke all on function app_private.actor_scope_includes_branch(uuid, uuid)
from public, anon, authenticated;
revoke all on function app_private.user_scope_includes_branch(uuid, uuid, uuid)
from public, anon, authenticated;
revoke all on function app_private.actor_can_administer_user(uuid, uuid)
from public, anon, authenticated;
revoke all on function app_private.user_has_team_member_role(uuid, uuid, text)
from public, anon, authenticated;
revoke all on function app_private.administration_request_fingerprint(jsonb)
from public, anon, authenticated;
revoke all on function app_private.replay_administration_request(uuid, text, uuid, text)
from public, anon, authenticated;
revoke all on function app_private.branch_has_active_dependencies(uuid, uuid)
from public, anon, authenticated;
revoke all on function app_private.team_has_active_dependencies(uuid, uuid)
from public, anon, authenticated;
revoke all on function app_private.validate_branch_administration_row()
from public, anon, authenticated;
revoke all on function app_private.validate_team_administration_row()
from public, anon, authenticated;
revoke all on function app_private.validate_team_member_administration_row()
from public, anon, authenticated;
revoke all on function app_private.validate_user_branch_access_row()
from public, anon, authenticated;
revoke all on function app_private.bump_administration_version()
from public, anon, authenticated;
revoke all on function app_private.realtime_topic_organization()
from public, anon, authenticated;
revoke all on function app_private.realtime_topic_resource()
from public, anon, authenticated;

-- RLS policies call these shared helpers directly.
grant execute on function app_private.can_access_branch(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_record(uuid, uuid, uuid, uuid)
to authenticated;

commit;
