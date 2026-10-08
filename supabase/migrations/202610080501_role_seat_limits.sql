begin;

-- Seat limits per dealership, set by Super Admin.
--
-- Go Digital Marketing caps how far a dealership grows: how many branches it may
-- run, and how many people may hold each role. Branch-level roles (Telecaller,
-- Sales Consultant, Team Manager, Sales Manager and every department desk) are
-- counted in each branch; Business Owner and GM Sales are counted once for the
-- whole dealership. A platform default applies until Super Admin overrides it
-- for one dealership. A null limit is unlimited.
--
-- A person occupies a seat in every branch they cover: their ONE_BRANCH or
-- SELECTED_BRANCHES scope, every active branch for ALL_BRANCHES or
-- ORGANIZATION, and, for team-scoped roles whose assignment names no branch,
-- the branches of their active teams and branch access grants.
--
-- Enforcement is by trigger so every write path is covered: the invite and
-- update RPCs, team moves and seed scripts. The user-update RPC rewrites the
-- assignment and upserts teams and branch access on every save, so a check
-- runs only when a seat is actually taken: a new or changed assignment, a newly
-- active team or branch grant, or a re-activated profile. Limits never revoke
-- access someone already has; a dealership already over a lowered limit is
-- reported as over, and only new seats there are refused.
--
-- Also here: Showroom Manager is shown as "Sales Manager" (the role key and the
-- /showroom-manager route are unchanged), and Digital Marketing gains an
-- executive role that uses the Digital Marketing workspace.

-- ---------------------------------------------------------------------------
-- Limits

create table if not exists public.platform_role_seat_defaults (
  role_key text primary key,
  role_group text not null check (role_group in ('ADMINISTRATION', 'SALES', 'DEPARTMENTS')),
  limit_scope text not null check (limit_scope in ('BRANCH', 'ORGANIZATION')),
  max_users integer check (max_users is null or max_users >= 0),
  sort_order integer not null
);

insert into public.platform_role_seat_defaults (
  role_key, role_group, limit_scope, max_users, sort_order
) values
  ('business_owner', 'ADMINISTRATION', 'ORGANIZATION', 1, 10),
  ('client_admin', 'ADMINISTRATION', 'ORGANIZATION', null, 20),
  ('system_administrator', 'ADMINISTRATION', 'ORGANIZATION', null, 30),
  ('gm_sales', 'SALES', 'ORGANIZATION', 1, 40),
  ('showroom_manager', 'SALES', 'BRANCH', 1, 50),
  ('team_manager', 'SALES', 'BRANCH', 10, 60),
  ('sales_consultant', 'SALES', 'BRANCH', 50, 70),
  ('telecaller_bdc', 'SALES', 'BRANCH', 10, 80),
  ('inventory_manager', 'DEPARTMENTS', 'BRANCH', 1, 100),
  ('inventory_executive', 'DEPARTMENTS', 'BRANCH', 2, 101),
  ('finance_manager', 'DEPARTMENTS', 'BRANCH', 1, 110),
  ('finance_executive', 'DEPARTMENTS', 'BRANCH', 2, 111),
  ('insurance_manager', 'DEPARTMENTS', 'BRANCH', 1, 120),
  ('insurance_executive', 'DEPARTMENTS', 'BRANCH', 2, 121),
  ('rto_manager', 'DEPARTMENTS', 'BRANCH', 1, 130),
  ('rto_executive', 'DEPARTMENTS', 'BRANCH', 2, 131),
  ('exchange_manager', 'DEPARTMENTS', 'BRANCH', 1, 140),
  ('exchange_executive', 'DEPARTMENTS', 'BRANCH', 4, 141),
  ('delivery_manager', 'DEPARTMENTS', 'BRANCH', 1, 150),
  ('delivery_executive', 'DEPARTMENTS', 'BRANCH', 2, 151),
  ('customer_relationship_manager', 'DEPARTMENTS', 'BRANCH', 1, 160),
  ('customer_relationship_executive', 'DEPARTMENTS', 'BRANCH', 2, 161),
  ('digital_marketing_manager', 'DEPARTMENTS', 'BRANCH', 1, 170),
  ('digital_marketing_executive', 'DEPARTMENTS', 'BRANCH', 4, 171)
on conflict (role_key) do nothing;

-- A row overrides the platform default for one dealership; no row means the
-- default applies. A row with a null limit is an explicit "unlimited".
create table if not exists public.organization_role_seat_limits (
  organization_id uuid not null references public.organizations(id),
  role_key text not null references public.platform_role_seat_defaults(role_key),
  max_users integer check (max_users is null or max_users >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (organization_id, role_key)
);

alter table public.organizations
  add column if not exists max_branches integer default 10
    check (max_branches is null or max_branches >= 1);

alter table public.platform_role_seat_defaults enable row level security;
alter table public.organization_role_seat_limits enable row level security;
revoke all on table public.platform_role_seat_defaults from public, anon, authenticated;
revoke all on table public.organization_role_seat_limits from public, anon, authenticated;

create or replace function app_private.role_seat_limit(
  target_organization_id uuid,
  target_role_key text,
  out limit_scope text,
  out max_users integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select default_row.limit_scope,
    case
      when override_row.organization_id is not null then override_row.max_users
      else default_row.max_users
    end
  from public.platform_role_seat_defaults default_row
  left join public.organization_role_seat_limits override_row
    on override_row.organization_id = target_organization_id
   and override_row.role_key = default_row.role_key
  where default_row.role_key = target_role_key
$$;

-- Every (holder, branch) seat of one role in one dealership.
create or replace function app_private.role_seat_holder_branches(
  target_organization_id uuid,
  target_role_key text
)
returns table (user_id uuid, branch_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct assignment_row.user_id, branch_row.id
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = target_organization_id
   and role_row.role_key = target_role_key
  join public.profiles profile_row
    on profile_row.id = assignment_row.user_id
   and profile_row.active
   and profile_row.deleted_at is null
  join public.branches branch_row
    on branch_row.organization_id = target_organization_id
   and branch_row.active
   and branch_row.deleted_at is null
  where assignment_row.organization_id = target_organization_id
    and assignment_row.active
    and (
      assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
      or (assignment_row.data_scope = 'ONE_BRANCH' and assignment_row.scope_branch_id = branch_row.id)
      or (
        assignment_row.data_scope = 'SELECTED_BRANCHES'
        and branch_row.id = any(coalesce(assignment_row.selected_branch_ids, array[]::uuid[]))
      )
      or exists (
        select 1
        from public.user_branch_access access_row
        where access_row.organization_id = target_organization_id
          and access_row.user_id = assignment_row.user_id
          and access_row.branch_id = branch_row.id
          and access_row.active
      )
      or exists (
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = target_organization_id
         and team_row.active
        where member_row.organization_id = target_organization_id
          and member_row.user_id = assignment_row.user_id
          and member_row.active
          and team_row.branch_id = branch_row.id
      )
    )
$$;

-- Refuses a seat the user's current assignments take beyond the limit. With a
-- branch, only that branch is checked (a new team or branch grant); without,
-- every branch the user covers and any dealership-wide role.
create or replace function app_private.assert_role_seats(
  target_organization_id uuid,
  target_user_id uuid,
  target_branch_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  role_row record;
  seat record;
  others integer;
  full_branch record;
begin
  if target_organization_id is null or target_user_id is null then
    return;
  end if;
  if not exists (
    select 1 from public.profiles profile_row
    where profile_row.id = target_user_id
      and profile_row.active
      and profile_row.deleted_at is null
  ) then
    return;
  end if;
  -- One writer at a time per dealership, so two invites cannot both take the
  -- last seat. Branch creation takes the same lock.
  perform pg_advisory_xact_lock(hashtextextended('role-seats:' || target_organization_id::text, 0));

  for role_row in
    select distinct held_role.role_key, held_role.name
    from public.user_role_assignments assignment_row
    join public.roles held_role
      on held_role.id = assignment_row.role_id
     and held_role.organization_id = target_organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_user_id
      and assignment_row.active
  loop
    select * into seat from app_private.role_seat_limit(target_organization_id, role_row.role_key);
    if seat.max_users is null then
      continue;
    end if;

    if seat.limit_scope = 'ORGANIZATION' then
      if target_branch_id is not null then
        continue;
      end if;
      select count(distinct assignment_row.user_id) into others
      from public.user_role_assignments assignment_row
      join public.roles held_role
        on held_role.id = assignment_row.role_id
       and held_role.organization_id = target_organization_id
       and held_role.role_key = role_row.role_key
      join public.profiles profile_row
        on profile_row.id = assignment_row.user_id
       and profile_row.active
       and profile_row.deleted_at is null
      where assignment_row.organization_id = target_organization_id
        and assignment_row.active
        and assignment_row.user_id <> target_user_id;
      if others >= seat.max_users then
        raise exception using
          errcode = 'P0001',
          message = 'ROLE_SEAT_LIMIT_REACHED',
          detail = format(
            'This dealership already has %s of the %s %s allowed.',
            others, seat.max_users, role_row.name
          );
      end if;
    else
      with seats as materialized (
        select *
        from app_private.role_seat_holder_branches(target_organization_id, role_row.role_key)
      )
      select branch_row.name, count(holder.user_id)::integer as taken
      into full_branch
      from seats mine
      join public.branches branch_row on branch_row.id = mine.branch_id
      left join seats holder
        on holder.branch_id = mine.branch_id
       and holder.user_id <> target_user_id
      where mine.user_id = target_user_id
        and (target_branch_id is null or mine.branch_id = target_branch_id)
      group by branch_row.id, branch_row.name
      having count(holder.user_id) >= seat.max_users
      order by count(holder.user_id) desc, branch_row.name
      limit 1;
      if found then
        raise exception using
          errcode = 'P0001',
          message = 'ROLE_SEAT_LIMIT_REACHED',
          detail = format(
            '%s already has %s of the %s %s allowed.',
            full_branch.name, full_branch.taken, seat.max_users, role_row.name
          );
      end if;
    end if;
  end loop;
end;
$$;

create or replace function app_private.enforce_role_seats_on_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous record;
begin
  if tg_op = 'INSERT' then
    -- The user-update RPC deactivates the assignment and inserts an identical
    -- one on every save; an unchanged role and scope takes no new seat.
    select assignment_row.role_id,
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    into previous
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = new.user_id
      and assignment_row.id <> new.id
    order by assignment_row.created_at desc, assignment_row.id desc
    limit 1;
    if found
      and previous.role_id = new.role_id
      and previous.data_scope = new.data_scope
      and previous.scope_branch_id is not distinct from new.scope_branch_id
      and previous.selected_branch_ids is not distinct from new.selected_branch_ids
    then
      return new;
    end if;
  end if;
  perform app_private.assert_role_seats(new.organization_id, new.user_id);
  return new;
end;
$$;

create or replace function app_private.enforce_role_seats_on_team_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  team_branch_id uuid;
begin
  select team_row.branch_id into team_branch_id
  from public.teams team_row
  where team_row.id = new.team_id;
  if team_branch_id is not null then
    perform app_private.assert_role_seats(new.organization_id, new.user_id, team_branch_id);
  end if;
  return new;
end;
$$;

create or replace function app_private.enforce_role_seats_on_branch_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_role_seats(new.organization_id, new.user_id, new.branch_id);
  return new;
end;
$$;

create or replace function app_private.enforce_role_seats_on_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_role_seats(new.organization_id, new.id);
  return new;
end;
$$;

create or replace function app_private.enforce_branch_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  branch_limit integer;
  active_branches integer;
begin
  if not new.active or new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.active and old.deleted_at is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('role-seats:' || new.organization_id::text, 0));
  select organization_row.max_branches into branch_limit
  from public.organizations organization_row
  where organization_row.id = new.organization_id;
  if branch_limit is null then
    return new;
  end if;
  select count(*) into active_branches
  from public.branches branch_row
  where branch_row.organization_id = new.organization_id
    and branch_row.active
    and branch_row.deleted_at is null
    and branch_row.id <> new.id;
  if active_branches >= branch_limit then
    raise exception using
      errcode = 'P0001',
      message = 'BRANCH_LIMIT_REACHED',
      detail = format('This dealership can have up to %s active branches.', branch_limit);
  end if;
  return new;
end;
$$;

drop trigger if exists user_role_assignments_enforce_role_seats on public.user_role_assignments;
create trigger user_role_assignments_enforce_role_seats
after insert or update of role_id, data_scope, scope_branch_id, selected_branch_ids, active
on public.user_role_assignments
for each row
when (new.active)
execute function app_private.enforce_role_seats_on_assignment();

drop trigger if exists team_members_enforce_role_seats_insert on public.team_members;
create trigger team_members_enforce_role_seats_insert
after insert on public.team_members
for each row
when (new.active)
execute function app_private.enforce_role_seats_on_team_member();

drop trigger if exists team_members_enforce_role_seats_update on public.team_members;
create trigger team_members_enforce_role_seats_update
after update of active, team_id on public.team_members
for each row
when (new.active and (not old.active or old.team_id is distinct from new.team_id))
execute function app_private.enforce_role_seats_on_team_member();

drop trigger if exists user_branch_access_enforce_role_seats_insert on public.user_branch_access;
create trigger user_branch_access_enforce_role_seats_insert
after insert on public.user_branch_access
for each row
when (new.active)
execute function app_private.enforce_role_seats_on_branch_access();

drop trigger if exists user_branch_access_enforce_role_seats_update on public.user_branch_access;
create trigger user_branch_access_enforce_role_seats_update
after update of active, branch_id on public.user_branch_access
for each row
when (new.active and (not old.active or old.branch_id is distinct from new.branch_id))
execute function app_private.enforce_role_seats_on_branch_access();

drop trigger if exists profiles_enforce_role_seats on public.profiles;
create trigger profiles_enforce_role_seats
after update of active on public.profiles
for each row
when (new.active and not old.active)
execute function app_private.enforce_role_seats_on_profile();

drop trigger if exists branches_enforce_branch_limit on public.branches;
create trigger branches_enforce_branch_limit
before insert or update of active, deleted_at on public.branches
for each row
execute function app_private.enforce_branch_limit();

-- Read-only preview of the seat an invite or edit would take, so the invite
-- flow can refuse before it emails an invitation it would then have to revoke.
-- The triggers above remain the guarantee; this only answers early.
create or replace function public.check_role_seat_available(
  target_organization_id uuid,
  target_role_id uuid,
  target_data_scope text,
  target_scope_branch_id uuid,
  target_selected_branch_ids uuid[],
  target_team_ids uuid[],
  target_existing_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  role_record record;
  seat record;
  others integer;
  full_branch record;
begin
  select role_row.role_key, role_row.name into role_record
  from public.roles role_row
  where role_row.id = target_role_id
    and role_row.organization_id = target_organization_id;
  if not found then
    -- An unknown role is refused by the provisioning RPC itself.
    return jsonb_build_object('available', true);
  end if;
  select * into seat from app_private.role_seat_limit(target_organization_id, role_record.role_key);
  if seat.max_users is null then
    return jsonb_build_object('available', true);
  end if;

  if seat.limit_scope = 'ORGANIZATION' then
    select count(distinct assignment_row.user_id) into others
    from public.user_role_assignments assignment_row
    join public.profiles profile_row
      on profile_row.id = assignment_row.user_id
     and profile_row.active
     and profile_row.deleted_at is null
    where assignment_row.organization_id = target_organization_id
      and assignment_row.active
      and assignment_row.role_id = target_role_id
      and assignment_row.user_id is distinct from target_existing_user_id;
    if others >= seat.max_users then
      return jsonb_build_object(
        'available', false,
        'message', format(
          'This dealership already has %s of the %s %s allowed.',
          others, seat.max_users, role_record.name
        )
      );
    end if;
    return jsonb_build_object('available', true);
  end if;

  with wanted as materialized (
    select branch_row.id, branch_row.name
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
      and (
        target_data_scope in ('ALL_BRANCHES', 'ORGANIZATION')
        or (target_data_scope = 'ONE_BRANCH' and branch_row.id = target_scope_branch_id)
        or (
          target_data_scope = 'SELECTED_BRANCHES'
          and branch_row.id = any(coalesce(target_selected_branch_ids, array[]::uuid[]))
        )
        or exists (
          select 1
          from public.teams team_row
          where team_row.organization_id = target_organization_id
            and team_row.id = any(coalesce(target_team_ids, array[]::uuid[]))
            and team_row.branch_id = branch_row.id
        )
      )
  ), seats as materialized (
    select *
    from app_private.role_seat_holder_branches(target_organization_id, role_record.role_key)
  )
  select wanted.name, count(seats.user_id)::integer as taken
  into full_branch
  from wanted
  left join seats
    on seats.branch_id = wanted.id
   and seats.user_id is distinct from target_existing_user_id
  group by wanted.id, wanted.name
  having count(seats.user_id) >= seat.max_users
  order by count(seats.user_id) desc, wanted.name
  limit 1;
  if found then
    return jsonb_build_object(
      'available', false,
      'message', format(
        '%s already has %s of the %s %s allowed.',
        full_branch.name, full_branch.taken, seat.max_users, role_record.name
      )
    );
  end if;
  return jsonb_build_object('available', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Super Admin

create or replace function app_private.assert_platform_seat_admin()
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
    raise exception using errcode = '42501', message = 'PLATFORM_SEAT_LIMITS_ACCESS_REQUIRED';
  end if;
end;
$$;

create or replace function public.get_organization_seat_limits(target_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  organization_row record;
begin
  perform app_private.assert_platform_seat_admin();
  select organization_row_source.id, organization_row_source.max_branches
  into organization_row
  from public.organizations organization_row_source
  where organization_row_source.id = target_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ORGANIZATION_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'organization_id', organization_row.id,
    'max_branches', organization_row.max_branches,
    'active_branches', (
      select count(*)
      from public.branches branch_row
      where branch_row.organization_id = target_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    ),
    'roles', coalesce((
      select jsonb_agg(role_json order by sort_order)
      from (
        select default_row.sort_order,
          jsonb_build_object(
            'role_key', default_row.role_key,
            'role_name', coalesce(role_row.name, initcap(replace(default_row.role_key, '_', ' '))),
            'role_group', default_row.role_group,
            'limit_scope', default_row.limit_scope,
            'default_max_users', default_row.max_users,
            'overridden', override_row.organization_id is not null,
            'max_users', limit_row.max_users,
            'in_use', usage_row.in_use,
            'busiest_branch', usage_row.busiest_branch,
            'over_limit', limit_row.max_users is not null and usage_row.in_use > limit_row.max_users
          ) as role_json
        from public.platform_role_seat_defaults default_row
        left join public.roles role_row
          on role_row.organization_id = target_organization_id
         and role_row.role_key = default_row.role_key
        left join public.organization_role_seat_limits override_row
          on override_row.organization_id = target_organization_id
         and override_row.role_key = default_row.role_key
        cross join lateral app_private.role_seat_limit(
          target_organization_id, default_row.role_key
        ) limit_row
        cross join lateral (
          select
            case
              when default_row.limit_scope = 'ORGANIZATION' then (
                select count(distinct assignment_row.user_id)::integer
                from public.user_role_assignments assignment_row
                join public.profiles profile_row
                  on profile_row.id = assignment_row.user_id
                 and profile_row.active
                 and profile_row.deleted_at is null
                where assignment_row.organization_id = target_organization_id
                  and assignment_row.active
                  and assignment_row.role_id = role_row.id
              )
              else coalesce((
                select max(branch_count.taken)
                from (
                  select count(*)::integer as taken
                  from app_private.role_seat_holder_branches(
                    target_organization_id, default_row.role_key
                  ) seat_row
                  group by seat_row.branch_id
                ) branch_count
              ), 0)
            end as in_use,
            case
              when default_row.limit_scope = 'BRANCH' then (
                select branch_row.name
                from app_private.role_seat_holder_branches(
                  target_organization_id, default_row.role_key
                ) seat_row
                join public.branches branch_row on branch_row.id = seat_row.branch_id
                group by branch_row.id, branch_row.name
                order by count(*) desc, branch_row.name
                limit 1
              )
            end as busiest_branch
        ) usage_row
      ) roles_source
    ), '[]'::jsonb)
  );
end;
$$;

-- target_limits: [{ "role_key": text, "max_users": integer | null, "use_default": boolean }]
create or replace function public.set_organization_seat_limits(
  target_organization_id uuid,
  target_max_branches integer,
  target_limits jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  limit_item jsonb;
  item_role_key text;
  item_max_users integer;
  previous_limits jsonb;
  previous_max_branches integer;
begin
  perform app_private.assert_platform_seat_admin();
  if target_request_id is null
    or (target_max_branches is not null and (target_max_branches < 1 or target_max_branches > 10000))
    or target_limits is null
    or jsonb_typeof(target_limits) <> 'array'
    or jsonb_array_length(target_limits) > 100
  then
    raise exception using errcode = '22023', message = 'INVALID_SEAT_LIMITS';
  end if;

  select organization_row.max_branches into previous_max_branches
  from public.organizations organization_row
  where organization_row.id = target_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ORGANIZATION_NOT_FOUND';
  end if;
  select coalesce(jsonb_object_agg(override_row.role_key, override_row.max_users), '{}'::jsonb)
  into previous_limits
  from public.organization_role_seat_limits override_row
  where override_row.organization_id = target_organization_id;

  for limit_item in select value from jsonb_array_elements(target_limits)
  loop
    item_role_key := limit_item->>'role_key';
    if jsonb_typeof(limit_item) <> 'object'
      or item_role_key is null
      or not exists (
        select 1 from public.platform_role_seat_defaults default_row
        where default_row.role_key = item_role_key
      )
      or coalesce(jsonb_typeof(limit_item->'use_default'), 'boolean') <> 'boolean'
      or jsonb_typeof(coalesce(limit_item->'max_users', 'null'::jsonb)) not in ('number', 'null')
    then
      raise exception using errcode = '22023', message = 'INVALID_SEAT_LIMITS';
    end if;

    if coalesce((limit_item->>'use_default')::boolean, false) then
      delete from public.organization_role_seat_limits override_row
      where override_row.organization_id = target_organization_id
        and override_row.role_key = item_role_key;
      continue;
    end if;

    if jsonb_typeof(coalesce(limit_item->'max_users', 'null'::jsonb)) = 'number' then
      if (limit_item->>'max_users')::numeric <> trunc((limit_item->>'max_users')::numeric)
        or (limit_item->>'max_users')::numeric < 0
        or (limit_item->>'max_users')::numeric > 100000
      then
        raise exception using errcode = '22023', message = 'INVALID_SEAT_LIMITS';
      end if;
      item_max_users := (limit_item->>'max_users')::integer;
    else
      item_max_users := null;
    end if;

    insert into public.organization_role_seat_limits (
      organization_id, role_key, max_users, updated_by, updated_at
    ) values (
      target_organization_id, item_role_key, item_max_users, auth.uid(), now()
    )
    on conflict (organization_id, role_key) do update
    set max_users = excluded.max_users,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  end loop;

  update public.organizations organization_row
  set max_branches = target_max_branches
  where organization_row.id = target_organization_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, auth.uid(), 'organization.seat_limits_updated', 'organization',
    target_organization_id::text, target_request_id,
    jsonb_build_object(
      'before', jsonb_build_object('max_branches', previous_max_branches, 'roles', previous_limits),
      'after', jsonb_build_object(
        'max_branches', target_max_branches,
        'roles', (
          select coalesce(jsonb_object_agg(override_row.role_key, override_row.max_users), '{}'::jsonb)
          from public.organization_role_seat_limits override_row
          where override_row.organization_id = target_organization_id
        )
      ),
      'safe_message', 'Dealership branch and user limits updated'
    )
  );

  return public.get_organization_seat_limits(target_organization_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Showroom Manager is shown as Sales Manager; Digital Marketing Executive.

-- The manager's permissions without report export, the same "operate, not
-- approve" line the other department executives follow.
create or replace function app_private.digital_marketing_executive_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'customer.create', 'customer.drip.manage', 'customer.drip.view', 'customer.link',
    'customer.update', 'customer.view', 'document.download', 'document.upload',
    'integration.view', 'lead.assign', 'lead.create', 'lead.update', 'lead.view',
    'marketing.automation.manage', 'marketing.automation.view', 'marketing.manage',
    'marketing.social.manage', 'marketing.view', 'report.view'
  ]::text[]
$$;

create or replace function app_private.apply_default_digital_marketing_executive_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is null
    or not new.system_role
    or new.role_key <> 'digital_marketing_executive'
  then
    return new;
  end if;
  insert into public.role_permissions (role_id, permission_id)
  select new.id, permission_row.id
  from public.permissions permission_row
  where permission_row.permission_key = any(app_private.digital_marketing_executive_permissions())
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists apply_default_digital_marketing_executive_permissions on public.roles;
create trigger apply_default_digital_marketing_executive_permissions
after insert on public.roles
for each row
execute function app_private.apply_default_digital_marketing_executive_permissions();

alter table public.roles disable trigger enforce_role_write_security;
alter table public.role_permissions disable trigger enforce_role_permission_write_security;

update public.roles role_row
set name = 'Sales Manager'
where role_row.role_key = 'showroom_manager'
  and role_row.name = 'Showroom Manager';

insert into public.roles (
  organization_id, name, role_key, authority_level, system_role, mfa_required
)
select organization_row.id, 'Digital Marketing Executive', 'digital_marketing_executive', 400, true, false
from public.organizations organization_row
where organization_row.deleted_at is null
on conflict (organization_id, role_key) do nothing;

alter table public.roles enable trigger enforce_role_write_security;
alter table public.role_permissions enable trigger enforce_role_permission_write_security;

-- New dealerships: the deployed seeding function gets the new name and the new
-- role. Patched from its deployed body, never re-emitted.
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef('public.provision_default_roles(uuid)'::regprocedure);
  showroom_line constant text :=
    E'(target_organization_id, ''Showroom Manager'', ''showroom_manager'', 600, true, false)';
  marketing_line constant text :=
    E'(target_organization_id, ''Digital Marketing Manager'', ''digital_marketing_manager'', 450, true, false)';
begin
  if position(showroom_line in definition) = 0 or position(marketing_line in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'PROVISION_DEFAULT_ROLES_PATCH_TARGET_NOT_FOUND';
  end if;
  definition := replace(
    definition,
    showroom_line,
    E'(target_organization_id, ''Sales Manager'', ''showroom_manager'', 600, true, false)'
  );
  definition := replace(
    definition,
    marketing_line,
    marketing_line
      || E',\n    (target_organization_id, ''Digital Marketing Executive'', ''digital_marketing_executive'', 400, true, false)'
  );
  execute definition;
end;
$migration$;

-- The executive opens the same Digital Marketing workspace as the manager.
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.get_access_context_with_legacy_policy()'::regprocedure
  );
  anchor constant text := E'    when ''digital_marketing_manager'' then ''digital-marketing''\n';
begin
  if position(anchor in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'ACCESS_CONTEXT_PATCH_TARGET_NOT_FOUND';
  end if;
  execute replace(
    definition,
    anchor,
    anchor || E'    when ''digital_marketing_executive'' then ''digital-marketing''\n'
  );
end;
$migration$;

revoke all on function app_private.role_seat_limit(uuid, text) from public, anon, authenticated;
revoke all on function app_private.role_seat_holder_branches(uuid, text) from public, anon, authenticated;
revoke all on function app_private.assert_role_seats(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.assert_platform_seat_admin() from public, anon, authenticated;
revoke all on function public.check_role_seat_available(uuid, uuid, text, uuid, uuid[], uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.check_role_seat_available(uuid, uuid, text, uuid, uuid[], uuid[], uuid)
  to service_role;
revoke all on function public.get_organization_seat_limits(uuid) from public, anon;
grant execute on function public.get_organization_seat_limits(uuid) to authenticated;
revoke all on function public.set_organization_seat_limits(uuid, integer, jsonb, uuid) from public, anon;
grant execute on function public.set_organization_seat_limits(uuid, integer, jsonb, uuid) to authenticated;

commit;
