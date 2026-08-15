begin;

-- Nullable provider identifiers must not collapse ordinary/manual records into one row.
-- Locate the original constraints by their exact key columns so this remains safe even
-- when PostgreSQL truncated an automatically-generated constraint name.
do $$
declare
  target record;
  target_constraint name;
begin
  for target in
    select * from (values
      ('profiles', array['organization_id', 'employee_id']::text[]),
      ('leads', array['organization_id', 'connection_id', 'external_lead_id']::text[]),
      ('calls', array['organization_id', 'connection_id', 'provider_call_id']::text[]),
      ('conversation_messages', array['organization_id', 'conversation_id', 'provider_message_id']::text[]),
      ('bookings', array['organization_id', 'quotation_id']::text[])
    ) as targets(table_name, key_columns)
  loop
    target_constraint := null;
    select constraint_row.conname into target_constraint
    from pg_constraint constraint_row
    where constraint_row.conrelid = to_regclass('public.' || target.table_name)
      and constraint_row.contype = 'u'
      and array(
        select attribute_row.attname::text
        from unnest(constraint_row.conkey) with ordinality as key_row(attnum, position)
        join pg_attribute attribute_row
          on attribute_row.attrelid = constraint_row.conrelid
         and attribute_row.attnum = key_row.attnum
        order by key_row.position
      ) = target.key_columns
    limit 1;

    if target_constraint is not null then
      execute format('alter table public.%I drop constraint %I', target.table_name, target_constraint);
    end if;
  end loop;
end $$;

create unique index profiles_tenant_employee_unique_idx
  on public.profiles (organization_id, employee_id)
  where organization_id is not null and employee_id is not null;
create unique index profiles_platform_employee_unique_idx
  on public.profiles (employee_id)
  where organization_id is null and employee_id is not null;
create unique index leads_provider_external_unique_idx
  on public.leads (organization_id, connection_id, external_lead_id)
  where connection_id is not null and external_lead_id is not null;
create unique index calls_provider_external_unique_idx
  on public.calls (organization_id, connection_id, provider_call_id)
  where connection_id is not null and provider_call_id is not null;
create unique index conversation_messages_provider_unique_idx
  on public.conversation_messages (organization_id, conversation_id, provider_message_id)
  where provider_message_id is not null;
create unique index bookings_quotation_unique_idx
  on public.bookings (organization_id, quotation_id)
  where quotation_id is not null;

-- Composite keys let foreign keys prove that related records belong to the same tenant.
create unique index branches_org_id_unique_idx on public.branches (organization_id, id);
create unique index teams_org_id_unique_idx on public.teams (organization_id, id);
create unique index teams_org_branch_id_unique_idx on public.teams (organization_id, branch_id, id);
create unique index profiles_org_id_unique_idx on public.profiles (organization_id, id);
create unique index roles_org_id_unique_idx on public.roles (organization_id, id);
create unique index customers_org_id_unique_idx on public.customers (organization_id, id);
create unique index connected_accounts_org_id_unique_idx on public.connected_accounts (organization_id, id);
create unique index leads_org_id_unique_idx on public.leads (organization_id, id);

alter table public.teams
  add constraint teams_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.teams
  add constraint teams_manager_org_fk foreign key (organization_id, manager_id)
  references public.profiles (organization_id, id) not valid;
alter table public.team_members
  add constraint team_members_team_org_fk foreign key (organization_id, team_id)
  references public.teams (organization_id, id) not valid;
alter table public.team_members
  add constraint team_members_user_org_fk foreign key (organization_id, user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.user_branch_access
  add constraint user_branch_access_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.user_branch_access
  add constraint user_branch_access_user_org_fk foreign key (organization_id, user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.user_role_assignments
  add constraint user_role_assignments_role_org_fk foreign key (organization_id, role_id)
  references public.roles (organization_id, id) not valid;
alter table public.user_role_assignments
  add constraint user_role_assignments_user_org_fk foreign key (organization_id, user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.user_role_assignments
  add constraint user_role_assignments_branch_org_fk foreign key (organization_id, scope_branch_id)
  references public.branches (organization_id, id) not valid;

alter table public.leads
  add constraint leads_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.leads
  add constraint leads_team_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.leads
  add constraint leads_customer_org_fk foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.leads
  add constraint leads_assignee_org_fk foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.leads
  add constraint leads_connection_org_fk foreign key (organization_id, connection_id)
  references public.connected_accounts (organization_id, id) not valid;

-- Provider/domain references must prove the connection and branch belong to the
-- same tenant. The original single-column foreign keys only proved existence and
-- allowed a service workflow bug to persist a cross-tenant reference.
alter table public.integration_credentials
  add constraint integration_credentials_account_org_fk
  foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid;
alter table public.integration_branch_mappings
  add constraint integration_branch_mappings_account_org_fk
  foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid;
alter table public.integration_branch_mappings
  add constraint integration_branch_mappings_branch_org_fk
  foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.integration_field_mappings
  add constraint integration_field_mappings_account_org_fk
  foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid;
alter table public.provider_events
  add constraint provider_events_account_org_fk
  foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid;
alter table public.sync_runs
  add constraint sync_runs_account_org_fk
  foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid;
alter table public.calls
  add constraint calls_connection_org_fk
  foreign key (organization_id, connection_id)
  references public.connected_accounts (organization_id, id) not valid;
alter table public.conversations
  add constraint conversations_connection_org_fk
  foreign key (organization_id, connection_id)
  references public.connected_accounts (organization_id, id) not valid;

alter table public.lead_assignments
  add constraint lead_assignments_lead_org_fk foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.lead_assignments
  add constraint lead_assignments_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.lead_assignments
  add constraint lead_assignments_team_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.lead_assignments
  add constraint lead_assignments_assignee_org_fk foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.lead_assignment_history
  add constraint lead_assignment_history_lead_org_fk foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.lead_assignment_history
  add constraint lead_assignment_history_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.lead_assignment_history
  add constraint lead_assignment_history_team_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.lead_assignment_history
  add constraint lead_assignment_history_previous_owner_org_fk foreign key (organization_id, previous_owner_id)
  references public.profiles (organization_id, id) not valid;
alter table public.lead_assignment_history
  add constraint lead_assignment_history_new_owner_org_fk foreign key (organization_id, new_owner_id)
  references public.profiles (organization_id, id) not valid;
create unique index lead_assignments_one_active_idx
  on public.lead_assignments (lead_id)
  where active;

-- Platform identity is not authority to enter tenant data. Tenant entry is granted only
-- through an active, approved, time-limited support session.
create or replace function app_private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id is not distinct from assignment_row.organization_id
    join public.profiles profile_row on profile_row.id = assignment_row.user_id
    where assignment_row.user_id = auth.uid()
      and assignment_row.organization_id is null
      and role_row.organization_id is null
      and profile_row.organization_id is null
      and assignment_row.active
      and profile_row.active
      and profile_row.deleted_at is null
      and role_row.role_key = 'super_admin'
      and assignment_row.data_scope = 'PLATFORM'
  );
$$;

create or replace function app_private.requires_mfa(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin()
    or coalesce((
      select profile_row.mfa_required
      from public.profiles profile_row
      where profile_row.id = auth.uid()
        and profile_row.active
        and profile_row.deleted_at is null
    ), false)
    or exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id is not distinct from assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.active
        and assignment_row.organization_id is not distinct from target_organization_id
        and (
          role_row.mfa_required
          or role_row.role_key in ('super_admin', 'business_owner', 'client_admin', 'system_administrator', 'gm_sales')
          or (
            assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION', 'PLATFORM')
            and exists (
              select 1
              from public.role_permissions role_permission_row
              join public.permissions permission_row on permission_row.id = role_permission_row.permission_id
              where role_permission_row.role_id = role_row.id
                and permission_row.permission_key in (
                  'user.manage', 'role.manage', 'integration.manage', 'credit.allocate',
                  'audit.view', 'support.request', 'support.approve'
                )
            )
          )
        )
    );
$$;

create or replace function app_private.mfa_policy_satisfied(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists (
      select 1 from public.profiles profile_row
      where profile_row.id = auth.uid()
        and profile_row.active
        and profile_row.deleted_at is null
    )
    and (
      not app_private.requires_mfa(target_organization_id)
      or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    );
$$;

create or replace function app_private.has_active_approved_support_session(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
    and exists (
      select 1
      from public.support_sessions session_row
      join public.support_access_requests request_row
        on request_row.id = session_row.request_id
       and request_row.organization_id = session_row.organization_id
      join public.organizations organization_row on organization_row.id = session_row.organization_id
      join public.profiles approver_profile
        on approver_profile.id = session_row.approver_id
       and approver_profile.organization_id = session_row.organization_id
      join public.user_role_assignments approver_assignment
        on approver_assignment.user_id = approver_profile.id
       and approver_assignment.organization_id = approver_profile.organization_id
       and approver_assignment.active
       and approver_assignment.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
      join public.roles approver_role
        on approver_role.id = approver_assignment.role_id
       and approver_role.organization_id = approver_assignment.organization_id
      join public.role_permissions approver_role_permission
        on approver_role_permission.role_id = approver_role.id
      join public.permissions approver_permission
        on approver_permission.id = approver_role_permission.permission_id
       and approver_permission.permission_key = 'support.approve'
      where session_row.organization_id = target_organization_id
        and session_row.requester_id = auth.uid()
        and request_row.requested_by = auth.uid()
        and request_row.status = 'APPROVED'
        and request_row.approved_by = session_row.approver_id
        and request_row.decided_at is not null
        and request_row.requested_by <> request_row.approved_by
        and request_row.purpose = session_row.purpose
        and request_row.capability_scope = session_row.capability_scope
        and approver_profile.active
        and approver_profile.deleted_at is null
        and session_row.starts_at <= now()
        and session_row.expires_at > now()
        and session_row.ended_at is null
        and organization_row.status = 'SUPPORT_MAINTENANCE'
        and organization_row.deleted_at is null
    );
$$;

create or replace function app_private.support_session_allows_permission(
  target_organization_id uuid,
  target_permission text
)
returns boolean language sql stable security definer set search_path = '' as $$
  select nullif(btrim(target_permission), '') is not null
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
    and exists (
      select 1
      from public.support_sessions session_row
      join public.support_access_requests request_row
        on request_row.id = session_row.request_id
       and request_row.organization_id = session_row.organization_id
      join public.organizations organization_row
        on organization_row.id = session_row.organization_id
      join public.profiles approver_profile
        on approver_profile.id = session_row.approver_id
       and approver_profile.organization_id = session_row.organization_id
      join public.user_role_assignments approver_assignment
        on approver_assignment.user_id = approver_profile.id
       and approver_assignment.organization_id = approver_profile.organization_id
       and approver_assignment.active
       and approver_assignment.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
      join public.roles approver_role
        on approver_role.id = approver_assignment.role_id
       and approver_role.organization_id = approver_assignment.organization_id
      join public.role_permissions approver_role_permission
        on approver_role_permission.role_id = approver_role.id
      join public.permissions approver_permission
        on approver_permission.id = approver_role_permission.permission_id
       and approver_permission.permission_key = 'support.approve'
      where session_row.organization_id = target_organization_id
        and session_row.requester_id = auth.uid()
        and request_row.requested_by = auth.uid()
        and request_row.status = 'APPROVED'
        and request_row.approved_by = session_row.approver_id
        and request_row.decided_at is not null
        and request_row.requested_by <> request_row.approved_by
        and request_row.purpose = session_row.purpose
        and request_row.capability_scope = session_row.capability_scope
        and approver_profile.active
        and approver_profile.deleted_at is null
        and session_row.starts_at <= now()
        and session_row.expires_at > now()
        and session_row.ended_at is null
        and organization_row.status = 'SUPPORT_MAINTENANCE'
        and organization_row.deleted_at is null
        and (
          (
            jsonb_typeof(session_row.capability_scope) = 'array'
            and session_row.capability_scope ? target_permission
          )
          or (
            jsonb_typeof(session_row.capability_scope -> 'permissions') = 'array'
            and (session_row.capability_scope -> 'permissions') ? target_permission
          )
          or (session_row.capability_scope -> target_permission) = 'true'::jsonb
        )
  );
$$;

-- Service-role Edge writes carry the original authenticated actor explicitly.
-- Validate that attribution without requiring tenant ownership for an approved
-- platform support actor. This keeps cross-tenant resource references forbidden
-- while preserving the support workflow required by the product contract.
create or replace function app_private.actor_has_tenant_operation_context(
  target_actor_id uuid,
  target_organization_id uuid,
  target_permission text
)
returns boolean language sql stable security definer set search_path = '' as $$
  select nullif(btrim(target_permission), '') is not null
    and (
      exists (
        select 1
        from public.profiles actor_profile
        join public.organizations organization_row
          on organization_row.id = actor_profile.organization_id
        join public.user_role_assignments actor_assignment
          on actor_assignment.user_id = actor_profile.id
         and actor_assignment.organization_id = actor_profile.organization_id
         and actor_assignment.active
        join public.roles actor_role
          on actor_role.id = actor_assignment.role_id
         and actor_role.organization_id = actor_assignment.organization_id
        join public.role_permissions actor_role_permission
          on actor_role_permission.role_id = actor_role.id
        join public.permissions actor_permission
          on actor_permission.id = actor_role_permission.permission_id
         and actor_permission.permission_key = target_permission
        where actor_profile.id = target_actor_id
          and actor_profile.organization_id = target_organization_id
          and actor_profile.active
          and actor_profile.deleted_at is null
          and organization_row.status = 'ACTIVE'
          and organization_row.deleted_at is null
      )
      or exists (
        select 1
        from public.profiles actor_profile
        join public.user_role_assignments platform_assignment
          on platform_assignment.user_id = actor_profile.id
         and platform_assignment.organization_id is null
         and platform_assignment.active
         and platform_assignment.data_scope = 'PLATFORM'
        join public.roles platform_role
          on platform_role.id = platform_assignment.role_id
         and platform_role.organization_id is null
         and platform_role.role_key = 'super_admin'
        join public.support_sessions session_row
          on session_row.requester_id = actor_profile.id
         and session_row.organization_id = target_organization_id
        join public.support_access_requests request_row
          on request_row.id = session_row.request_id
         and request_row.organization_id = session_row.organization_id
         and request_row.requested_by = actor_profile.id
        join public.organizations organization_row
          on organization_row.id = session_row.organization_id
        join public.profiles approver_profile
          on approver_profile.id = session_row.approver_id
         and approver_profile.organization_id = session_row.organization_id
        join public.user_role_assignments approver_assignment
          on approver_assignment.user_id = approver_profile.id
         and approver_assignment.organization_id = approver_profile.organization_id
         and approver_assignment.active
         and approver_assignment.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        join public.roles approver_role
          on approver_role.id = approver_assignment.role_id
         and approver_role.organization_id = approver_assignment.organization_id
        join public.role_permissions approver_role_permission
          on approver_role_permission.role_id = approver_role.id
        join public.permissions approver_permission
          on approver_permission.id = approver_role_permission.permission_id
         and approver_permission.permission_key = 'support.approve'
        where actor_profile.id = target_actor_id
          and actor_profile.organization_id is null
          and actor_profile.active
          and actor_profile.deleted_at is null
          and request_row.status = 'APPROVED'
          and request_row.approved_by = session_row.approver_id
          and request_row.decided_at is not null
          and request_row.requested_by <> request_row.approved_by
          and request_row.purpose = session_row.purpose
          and request_row.capability_scope = session_row.capability_scope
          and approver_profile.active
          and approver_profile.deleted_at is null
          and session_row.starts_at <= now()
          and session_row.expires_at > now()
          and session_row.ended_at is null
          and organization_row.status = 'SUPPORT_MAINTENANCE'
          and organization_row.deleted_at is null
          and (
            (
              jsonb_typeof(session_row.capability_scope) = 'array'
              and session_row.capability_scope ? target_permission
            )
            or (
              jsonb_typeof(session_row.capability_scope -> 'permissions') = 'array'
              and (session_row.capability_scope -> 'permissions') ? target_permission
            )
            or (session_row.capability_scope -> target_permission) = 'true'::jsonb
          )
      )
    );
$$;

create or replace function app_private.is_tenant_support_controller(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.mfa_policy_satisfied(target_organization_id)
    and exists (
      select 1
      from public.profiles profile_row
      join public.organizations organization_row on organization_row.id = profile_row.organization_id
      join public.user_role_assignments assignment_row
        on assignment_row.user_id = profile_row.id
       and assignment_row.organization_id = profile_row.organization_id
       and assignment_row.active
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      join public.role_permissions role_permission_row
        on role_permission_row.role_id = role_row.id
      join public.permissions permission_row
        on permission_row.id = role_permission_row.permission_id
       and permission_row.permission_key = 'support.approve'
      where profile_row.id = auth.uid()
        and profile_row.active
        and profile_row.deleted_at is null
        and profile_row.organization_id = target_organization_id
        and organization_row.status in ('ACTIVE', 'SUPPORT_MAINTENANCE')
        and organization_row.deleted_at is null
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        and role_row.role_key in ('business_owner', 'client_admin')
    );
$$;

create or replace function app_private.can_access_organization(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select target_organization_id is not null
    and app_private.mfa_policy_satisfied(target_organization_id)
    and (
      app_private.has_active_approved_support_session(target_organization_id)
      or exists (
        select 1
        from public.profiles profile_row
        join public.organizations organization_row on organization_row.id = profile_row.organization_id
        where profile_row.id = auth.uid()
          and profile_row.active
          and profile_row.organization_id = target_organization_id
          and organization_row.status = 'ACTIVE'
          and organization_row.deleted_at is null
          and exists (
            select 1
            from public.user_role_assignments assignment_row
            join public.roles role_row
              on role_row.id = assignment_row.role_id
             and role_row.organization_id = assignment_row.organization_id
            where assignment_row.user_id = profile_row.id
              and assignment_row.organization_id = target_organization_id
              and assignment_row.active
          )
      )
    );
$$;

create or replace function app_private.has_permission(target_organization_id uuid, target_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when target_organization_id is null then
      app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
    when app_private.has_active_approved_support_session(target_organization_id) then
      app_private.support_session_allows_permission(target_organization_id, target_permission)
    else app_private.can_access_organization(target_organization_id) and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      join public.role_permissions role_permission_row on role_permission_row.role_id = role_row.id
      join public.permissions permission_row on permission_row.id = role_permission_row.permission_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = target_organization_id
        and assignment_row.active
        and permission_row.permission_key = target_permission
    )
  end;
$$;

create or replace function app_private.can_access_branch(target_organization_id uuid, target_branch_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select target_branch_id is not null
    and app_private.can_access_organization(target_organization_id)
    and exists (
      select 1 from public.branches branch_row
      where branch_row.id = target_branch_id
        and branch_row.organization_id = target_organization_id
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
            or (assignment_row.data_scope = 'ONE_BRANCH' and assignment_row.scope_branch_id = target_branch_id)
            or (assignment_row.data_scope = 'SELECTED_BRANCHES' and target_branch_id = any(assignment_row.selected_branch_ids))
            or exists (
              select 1 from public.user_branch_access branch_access_row
              where branch_access_row.organization_id = target_organization_id
                and branch_access_row.user_id = auth.uid()
                and branch_access_row.branch_id = target_branch_id
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

create or replace function app_private.can_access_record(
  target_organization_id uuid,
  target_branch_id uuid default null,
  target_team_id uuid default null,
  target_owner_id uuid default null
)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.can_access_organization(target_organization_id)
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
            or (assignment_row.data_scope = 'ONE_BRANCH' and target_branch_id = assignment_row.scope_branch_id)
            or (assignment_row.data_scope = 'SELECTED_BRANCHES' and target_branch_id = any(assignment_row.selected_branch_ids))
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

create or replace function app_private.can_access_team(
  target_organization_id uuid,
  target_team_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.can_access_organization(target_organization_id)
    and exists (
    select 1
    from public.teams team_row
    where team_row.id = target_team_id
      and team_row.organization_id = target_organization_id
      and team_row.active
      and (
        app_private.can_access_record(
          team_row.organization_id,
          team_row.branch_id,
          team_row.id,
          team_row.manager_id
        )
        or exists (
          select 1
          from public.team_members member_row
          where member_row.organization_id = team_row.organization_id
            and member_row.team_id = team_row.id
            and member_row.user_id = auth.uid()
            and member_row.active
        )
      )
  );
$$;

create or replace function app_private.has_organization_wide_scope(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.has_active_approved_support_session(target_organization_id)
    or (
      app_private.can_access_organization(target_organization_id)
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = target_organization_id
          and assignment_row.active
          and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
      )
    );
$$;

create or replace function app_private.can_access_customer(target_organization_id uuid, target_customer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.can_access_organization(target_organization_id)
    and exists (
      select 1 from public.customers customer_row
      where customer_row.id = target_customer_id
        and customer_row.organization_id = target_organization_id
        and customer_row.deleted_at is null
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
            or exists (
              select 1
              from public.leads lead_row
              where lead_row.organization_id = target_organization_id
                and lead_row.customer_id = target_customer_id
                and lead_row.deleted_at is null
                and (
                  (assignment_row.data_scope = 'OWN_RECORDS' and lead_row.assigned_user_id = auth.uid())
                  or (
                    assignment_row.data_scope = 'OWN_TEAM'
                    and lead_row.team_id in (
                      select member_row.team_id
                      from public.team_members member_row
                      where member_row.organization_id = target_organization_id
                        and member_row.user_id = auth.uid()
                        and member_row.active
                    )
                  )
                  or (assignment_row.data_scope = 'ONE_BRANCH' and lead_row.branch_id = assignment_row.scope_branch_id)
                  or (assignment_row.data_scope = 'SELECTED_BRANCHES' and lead_row.branch_id = any(assignment_row.selected_branch_ids))
                )
            )
          )
      )
    );
$$;

create or replace function app_private.can_access_lead(target_lead_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.leads lead_row
    where lead_row.id = target_lead_id
      and lead_row.deleted_at is null
      and app_private.has_permission(lead_row.organization_id, 'lead.view')
      and app_private.can_access_record(
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.assigned_user_id
      )
  );
$$;

create or replace function app_private.can_access_connection(
  target_organization_id uuid,
  target_connection_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.deleted_at is null
      and app_private.has_permission(target_organization_id, 'integration.view')
      and (
        app_private.has_organization_wide_scope(target_organization_id)
        or exists (
          select 1
          from public.integration_branch_mappings mapping_row
          where mapping_row.organization_id = target_organization_id
            and mapping_row.connected_account_id = connection_row.id
            and app_private.can_access_branch(target_organization_id, mapping_row.branch_id)
        )
        or (
          connection_row.scope_mode = 'ALL_BRANCHES'
          and exists (
            select 1
            from public.branches branch_row
            where branch_row.organization_id = target_organization_id
              and branch_row.active
              and branch_row.deleted_at is null
              and app_private.can_access_branch(target_organization_id, branch_row.id)
          )
        )
      )
  );
$$;

create or replace function app_private.can_access_call(
  target_organization_id uuid,
  target_call_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.calls call_row
    where call_row.id = target_call_id
      and call_row.organization_id = target_organization_id
      and app_private.has_permission(target_organization_id, 'call.view')
      and app_private.can_access_record(
        call_row.organization_id,
        call_row.branch_id,
        call_row.team_id,
        call_row.assigned_user_id
      )
  );
$$;

create or replace function app_private.can_access_conversation(
  target_organization_id uuid,
  target_conversation_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.conversations conversation_row
    left join public.leads lead_row
      on lead_row.id = conversation_row.lead_id
     and lead_row.organization_id = conversation_row.organization_id
     and lead_row.deleted_at is null
    where conversation_row.id = target_conversation_id
      and conversation_row.organization_id = target_organization_id
      and app_private.has_permission(target_organization_id, 'message.view')
      and app_private.can_access_record(
        conversation_row.organization_id,
        conversation_row.branch_id,
        lead_row.team_id,
        coalesce(conversation_row.assigned_user_id, lead_row.assigned_user_id)
      )
  );
$$;

create or replace function app_private.can_access_test_drive(
  target_organization_id uuid,
  target_test_drive_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.test_drives drive_row
    where drive_row.id = target_test_drive_id
      and drive_row.organization_id = target_organization_id
      and app_private.has_permission(target_organization_id, 'test_drive.manage')
      and app_private.can_access_record(
        drive_row.organization_id,
        drive_row.branch_id,
        drive_row.team_id,
        drive_row.assigned_user_id
      )
  );
$$;

create or replace function app_private.can_access_quotation(
  target_organization_id uuid,
  target_quotation_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.quotations quotation_row
    where quotation_row.id = target_quotation_id
      and quotation_row.organization_id = target_organization_id
      and app_private.has_permission(target_organization_id, 'quotation.manage')
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
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.bookings booking_row
    where booking_row.id = target_booking_id
      and booking_row.organization_id = target_organization_id
      and booking_row.deleted_at is null
      and app_private.has_permission(target_organization_id, 'booking.manage')
      and app_private.can_access_record(
        booking_row.organization_id,
        booking_row.branch_id,
        booking_row.team_id,
        booking_row.assigned_user_id
      )
  );
$$;

create or replace function public.get_access_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  profile_row public.profiles%rowtype;
  organization_row public.organizations%rowtype;
  role_row public.roles%rowtype;
  assignment_row public.user_role_assignments%rowtype;
  aal text;
  support_controller boolean := false;
  route_role_key text;
  mfa_required boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('authenticated', false, 'destination', 'LOGIN');
  end if;

  select * into profile_row from public.profiles where id = auth.uid();
  if not found or not profile_row.active or profile_row.deleted_at is not null then
    return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED');
  end if;

  aal := coalesce(auth.jwt()->>'aal', 'aal1');
  if profile_row.organization_id is null and app_private.is_platform_admin() then
    if aal <> 'aal2' then
      return jsonb_build_object(
        'authenticated', true,
        'destination', 'MFA',
        'role_key', 'super-admin',
        'tenant_status', null,
        'mfa_required', true,
        'mfa_satisfied', false
      );
    end if;
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'CRM',
      'user_id', profile_row.id,
      'role_key', 'super-admin',
      'tenant_status', null,
      'mfa_required', true,
      'mfa_satisfied', true
    );
  end if;

  select * into organization_row
  from public.organizations
  where id = profile_row.organization_id;
  if not found or organization_row.status in ('SUSPENDED', 'REJECTED', 'SOFT_DELETED') or organization_row.deleted_at is not null then
    return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED');
  end if;

  select assignment_source.* into assignment_row
  from public.user_role_assignments assignment_source
  join public.roles role_source
    on role_source.id = assignment_source.role_id
   and role_source.organization_id = assignment_source.organization_id
  where assignment_source.user_id = auth.uid()
    and assignment_source.organization_id = profile_row.organization_id
    and assignment_source.active
  order by role_source.authority_level desc
  limit 1;
  if not found then
    return jsonb_build_object('authenticated', true, 'destination', 'NO_ROLE');
  end if;
  select * into role_row
  from public.roles
  where id = assignment_row.role_id
    and organization_id = assignment_row.organization_id;

  route_role_key := case role_row.role_key
    when 'telecaller_bdc' then 'telecaller'
    when 'inventory_manager' then 'inventory'
    when 'finance_manager' then 'finance'
    when 'insurance_manager' then 'insurance'
    when 'rto_manager' then 'rto'
    when 'exchange_manager' then 'exchange'
    when 'delivery_manager' then 'delivery'
    when 'customer_relationship_manager' then 'customer-care'
    when 'digital_marketing_manager' then 'digital-marketing'
    else replace(role_row.role_key, '_', '-')
  end;

  mfa_required := app_private.requires_mfa(profile_row.organization_id);
  if mfa_required and aal <> 'aal2' then
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'MFA',
      'role_key', route_role_key,
      'mfa_required', true,
      'mfa_satisfied', false
    );
  end if;

  if organization_row.status in ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED') then
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'ONBOARDING',
      'tenant_status', organization_row.status,
      'role_key', route_role_key,
      'mfa_required', mfa_required,
      'mfa_satisfied', aal = 'aal2'
    );
  end if;

  if organization_row.status = 'SUPPORT_MAINTENANCE' then
    support_controller := app_private.is_tenant_support_controller(organization_row.id);
    if not support_controller then
      return jsonb_build_object(
        'authenticated', true,
        'destination', 'MAINTENANCE',
        'tenant_status', organization_row.status,
        'role_key', route_role_key
      );
    end if;
  elsif organization_row.status <> 'ACTIVE' then
    return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED');
  end if;

  return jsonb_build_object(
    'authenticated', true,
    'destination', 'CRM',
    'user_id', profile_row.id,
    'organization_id', organization_row.id,
    'tenant_status', organization_row.status,
    'role_key', route_role_key,
    'data_scope', assignment_row.data_scope,
    'mfa_required', mfa_required,
    'mfa_satisfied', aal = 'aal2',
    'support_controller', support_controller
  );
end;
$$;

-- Only non-security profile fields may be self-edited. Managers are constrained by
-- authority and cannot move identities between tenants or modify immutable identity data.
create or replace function app_private.validate_profile_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_authority integer;
  target_authority integer;
begin
  if coalesce(auth.role(), '') = 'service_role' then
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

drop trigger if exists enforce_profile_update_security on public.profiles;
create trigger enforce_profile_update_security
before update on public.profiles
for each row execute function app_private.validate_profile_update();

create or replace function app_private.validate_role_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_authority integer;
begin
  if new.role_key in ('super_admin', 'business_owner', 'client_admin', 'system_administrator', 'gm_sales')
    and not new.mfa_required
  then
    raise exception using errcode = '23514', message = 'PRIVILEGED_ROLE_REQUIRES_MFA';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null or app_private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'ROLE_MUTATION_REQUIRES_TENANT_AUTHORITY';
  end if;
  if new.organization_id is null or not app_private.has_permission(new.organization_id, 'role.manage') then
    raise exception using errcode = '42501', message = 'ROLE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or old.system_role
    or new.system_role
  ) then
    raise exception using errcode = '42501', message = 'SYSTEM_ROLE_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' and new.system_role then
    raise exception using errcode = '42501', message = 'SYSTEM_ROLE_CREATION_REQUIRES_SERVICE_ROLE';
  end if;

  select coalesce(max(role_row.authority_level), -1) into actor_authority
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  join public.role_permissions role_permission_row on role_permission_row.role_id = role_row.id
  join public.permissions permission_row on permission_row.id = role_permission_row.permission_id
  where assignment_row.user_id = auth.uid()
    and assignment_row.organization_id = new.organization_id
    and assignment_row.active
    and permission_row.permission_key = 'role.manage';
  if new.authority_level >= actor_authority
    or (tg_op = 'UPDATE' and old.authority_level >= actor_authority)
  then
    raise exception using errcode = '42501', message = 'ROLE_AUTHORITY_CEILING_EXCEEDED';
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    new.organization_id,
    auth.uid(),
    case when tg_op = 'INSERT' then 'role.created' else 'role.updated' end,
    'role',
    new.id::text,
    jsonb_build_object('authority_level', new.authority_level, 'role_key', new.role_key)
  );
  return new;
end;
$$;

drop trigger if exists enforce_role_write_security on public.roles;
create trigger enforce_role_write_security
before insert or update on public.roles
for each row execute function app_private.validate_role_write();

create or replace function app_private.validate_role_permission_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target_organization_id uuid;
  target_authority integer;
  target_system_role boolean;
  actor_authority integer;
  target_permission_key text;
begin
  select role_row.organization_id, role_row.authority_level, role_row.system_role
    into target_organization_id, target_authority, target_system_role
  from public.roles role_row where role_row.id = new.role_id;
  if not found then
    raise exception using errcode = '23503', message = 'ROLE_NOT_FOUND';
  end if;
  select permission_key into target_permission_key
  from public.permissions where id = new.permission_id;
  if not found then
    raise exception using errcode = '23503', message = 'PERMISSION_NOT_FOUND';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null or target_organization_id is null or app_private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_MUTATION_REQUIRES_TENANT_AUTHORITY';
  end if;
  if target_system_role then
    raise exception using errcode = '42501', message = 'SYSTEM_ROLE_PERMISSIONS_IMMUTABLE';
  end if;
  if not app_private.has_permission(target_organization_id, 'role.manage') then
    raise exception using errcode = '42501', message = 'ROLE_MANAGE_PERMISSION_REQUIRED';
  end if;

  select coalesce(max(role_row.authority_level), -1) into actor_authority
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  join public.role_permissions role_permission_row on role_permission_row.role_id = role_row.id
  join public.permissions permission_row on permission_row.id = role_permission_row.permission_id
  where assignment_row.user_id = auth.uid()
    and assignment_row.organization_id = target_organization_id
    and assignment_row.active
    and permission_row.permission_key = 'role.manage';
  if target_authority >= actor_authority then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_AUTHORITY_CEILING_EXCEEDED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments actor_assignment
    join public.roles actor_role
      on actor_role.id = actor_assignment.role_id
     and actor_role.organization_id = actor_assignment.organization_id
    join public.role_permissions actor_role_permission on actor_role_permission.role_id = actor_assignment.role_id
    where actor_assignment.user_id = auth.uid()
      and actor_assignment.organization_id = target_organization_id
      and actor_assignment.active
      and actor_role_permission.permission_id = new.permission_id
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DELEGATION_CEILING_EXCEEDED';
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    target_organization_id,
    auth.uid(),
    'role.permission.granted',
    'role',
    new.role_id::text,
    jsonb_build_object('permission_key', target_permission_key)
  );
  return new;
end;
$$;

drop trigger if exists enforce_role_permission_write_security on public.role_permissions;
create trigger enforce_role_permission_write_security
before insert or update on public.role_permissions
for each row execute function app_private.validate_role_permission_write();

create or replace function public.revoke_role_permission(
  target_role_id uuid,
  target_permission_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target_organization_id uuid;
  target_authority integer;
  target_system_role boolean;
  actor_authority integer;
  target_permission_key text;
begin
  select role_row.organization_id, role_row.authority_level, role_row.system_role
    into target_organization_id, target_authority, target_system_role
  from public.roles role_row
  where role_row.id = target_role_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROLE_NOT_FOUND';
  end if;
  select permission_row.permission_key into target_permission_key
  from public.permissions permission_row
  where permission_row.id = target_permission_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'PERMISSION_NOT_FOUND';
  end if;
  if auth.uid() is null
    or target_organization_id is null
    or app_private.is_platform_admin()
    or target_system_role
    or not app_private.has_permission(target_organization_id, 'role.manage')
  then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_REVOKE_DENIED';
  end if;

  select coalesce(max(actor_role.authority_level), -1) into actor_authority
  from public.user_role_assignments actor_assignment
  join public.roles actor_role
    on actor_role.id = actor_assignment.role_id
   and actor_role.organization_id = actor_assignment.organization_id
  join public.role_permissions manage_role_permission
    on manage_role_permission.role_id = actor_role.id
  join public.permissions manage_permission
    on manage_permission.id = manage_role_permission.permission_id
   and manage_permission.permission_key = 'role.manage'
  where actor_assignment.user_id = auth.uid()
    and actor_assignment.organization_id = target_organization_id
    and actor_assignment.active;
  if target_authority >= actor_authority then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_AUTHORITY_CEILING_EXCEEDED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments actor_assignment
    join public.roles actor_role
      on actor_role.id = actor_assignment.role_id
     and actor_role.organization_id = actor_assignment.organization_id
    join public.role_permissions actor_role_permission
      on actor_role_permission.role_id = actor_role.id
    where actor_assignment.user_id = auth.uid()
      and actor_assignment.organization_id = target_organization_id
      and actor_assignment.active
      and actor_role_permission.permission_id = target_permission_id
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DELEGATION_CEILING_EXCEEDED';
  end if;

  delete from public.role_permissions
  where role_id = target_role_id
    and permission_id = target_permission_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROLE_PERMISSION_NOT_FOUND';
  end if;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    target_organization_id,
    auth.uid(),
    'role.permission.revoked',
    'role',
    target_role_id::text,
    jsonb_build_object('permission_key', target_permission_key)
  );
  return true;
end;
$$;

revoke all on function public.revoke_role_permission(uuid, uuid) from public, anon;
grant execute on function public.revoke_role_permission(uuid, uuid) to authenticated;

create or replace function app_private.validate_delegation_ceiling()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target_authority integer;
  old_target_authority integer := -1;
  current_target_authority integer;
  actor_authority integer;
  actor_scope public.data_scope;
  actor_selected uuid[];
  actor_branch uuid;
begin
  if new.organization_id is null then
    if new.data_scope <> 'PLATFORM'
      or new.scope_branch_id is not null
      or cardinality(new.selected_branch_ids) <> 0
      or not exists (
        select 1 from public.roles role_row
        where role_row.id = new.role_id and role_row.organization_id is null
      )
      or not exists (
        select 1 from public.profiles profile_row
        where profile_row.id = new.user_id and profile_row.organization_id is null
      )
    then
      raise exception using errcode = '23514', message = 'INVALID_PLATFORM_ASSIGNMENT';
    end if;
    if coalesce(auth.role(), '') = 'service_role' then
      return new;
    end if;
    raise exception using errcode = '42501', message = 'PLATFORM_ASSIGNMENT_REQUIRES_SERVICE_ROLE';
  end if;

  select role_row.authority_level into target_authority
  from public.roles role_row
  where role_row.id = new.role_id and role_row.organization_id = new.organization_id;
  if not found then
    raise exception using errcode = '23503', message = 'ROLE_NOT_IN_ORGANIZATION';
  end if;
  if not exists (
    select 1 from public.profiles profile_row
    where profile_row.id = new.user_id and profile_row.organization_id = new.organization_id
  ) then
    raise exception using errcode = '23503', message = 'USER_NOT_IN_ORGANIZATION';
  end if;
  if new.data_scope = 'PLATFORM' then
    raise exception using errcode = '23514', message = 'PLATFORM_SCOPE_REQUIRES_PLATFORM_ASSIGNMENT';
  end if;
  if new.scope_branch_id is not null and not exists (
    select 1 from public.branches branch_row
    where branch_row.id = new.scope_branch_id and branch_row.organization_id = new.organization_id
  ) then
    raise exception using errcode = '23503', message = 'BRANCH_NOT_IN_ORGANIZATION';
  end if;
  if exists (
    select 1
    from unnest(new.selected_branch_ids) as selected_branch(branch_id)
    where selected_branch.branch_id is null
  )
    or (select count(*) from unnest(new.selected_branch_ids))
      <> (
        select count(distinct selected_branch.branch_id)
        from unnest(new.selected_branch_ids) as selected_branch(branch_id)
      )
    or exists (
      select 1
      from unnest(new.selected_branch_ids) as selected_branch(branch_id)
      where not exists (
        select 1 from public.branches branch_row
        where branch_row.id = selected_branch.branch_id
          and branch_row.organization_id = new.organization_id
      )
    )
  then
    raise exception using errcode = '23514', message = 'SELECTED_BRANCHES_INVALID';
  end if;

  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null or app_private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'ASSIGNMENT_MUTATION_REQUIRES_TENANT_AUTHORITY';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
  ) then
    raise exception using errcode = '42501', message = 'ASSIGNMENT_IDENTITY_IMMUTABLE';
  end if;
  if new.user_id = auth.uid() then
    raise exception using errcode = '42501', message = 'SELF_ASSIGNMENT_FORBIDDEN';
  end if;
  if not app_private.has_permission(new.organization_id, 'user.manage') then
    raise exception using errcode = '42501', message = 'USER_MANAGE_PERMISSION_REQUIRED';
  end if;

  select role_row.authority_level, assignment_row.data_scope,
         assignment_row.selected_branch_ids, assignment_row.scope_branch_id
    into actor_authority, actor_scope, actor_selected, actor_branch
  from public.user_role_assignments assignment_row
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.organization_id = assignment_row.organization_id
  join public.role_permissions role_permission_row on role_permission_row.role_id = role_row.id
  join public.permissions permission_row on permission_row.id = role_permission_row.permission_id
  where assignment_row.user_id = auth.uid()
    and assignment_row.organization_id = new.organization_id
    and assignment_row.active
    and permission_row.permission_key = 'user.manage'
  order by role_row.authority_level desc, app_private.scope_rank(assignment_row.data_scope) desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'USER_MANAGE_PERMISSION_REQUIRED';
  end if;
  if tg_op = 'UPDATE' then
    select role_row.authority_level into old_target_authority
    from public.roles role_row
    where role_row.id = old.role_id
      and role_row.organization_id = old.organization_id;
  end if;
  select coalesce(max(role_row.authority_level), -1) into current_target_authority
  from public.user_role_assignments target_assignment
  join public.roles role_row
    on role_row.id = target_assignment.role_id
   and role_row.organization_id = target_assignment.organization_id
  where target_assignment.user_id = new.user_id
    and target_assignment.organization_id = new.organization_id
    and target_assignment.active;
  if target_authority >= actor_authority
    or old_target_authority >= actor_authority
    or current_target_authority >= actor_authority
    or app_private.scope_rank(new.data_scope) > app_private.scope_rank(actor_scope)
  then
    raise exception using errcode = '42501', message = 'DELEGATION_CEILING_EXCEEDED';
  end if;
  if exists (
    select 1
    from public.role_permissions target_permission
    where target_permission.role_id = new.role_id
      and not exists (
        select 1
        from public.user_role_assignments actor_assignment
        join public.roles actor_role
          on actor_role.id = actor_assignment.role_id
         and actor_role.organization_id = actor_assignment.organization_id
        join public.role_permissions actor_permission on actor_permission.role_id = actor_role.id
        where actor_assignment.user_id = auth.uid()
          and actor_assignment.organization_id = new.organization_id
          and actor_assignment.active
          and actor_permission.permission_id = target_permission.permission_id
      )
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DELEGATION_CEILING_EXCEEDED';
  end if;

  if actor_scope = 'ONE_BRANCH' then
    if new.data_scope = 'ONE_BRANCH' and new.scope_branch_id <> actor_branch then
      raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
    elsif new.data_scope = 'SELECTED_BRANCHES' then
      raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
    elsif new.data_scope in ('OWN_RECORDS', 'OWN_TEAM') and (
      not exists (
        select 1 from public.user_branch_access access_row
        where access_row.organization_id = new.organization_id
          and access_row.user_id = new.user_id
          and access_row.branch_id = actor_branch
        union all
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = new.organization_id
          and member_row.user_id = new.user_id
          and member_row.active
          and team_row.active
          and team_row.branch_id = actor_branch
      )
      or exists (
        select 1 from public.user_branch_access access_row
        where access_row.organization_id = new.organization_id
          and access_row.user_id = new.user_id
          and access_row.branch_id <> actor_branch
      )
      or exists (
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = new.organization_id
          and member_row.user_id = new.user_id
          and member_row.active
          and team_row.active
          and team_row.branch_id <> actor_branch
      )
    ) then
      raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
    end if;
  elsif actor_scope = 'SELECTED_BRANCHES' then
    if new.data_scope = 'ONE_BRANCH' and not (new.scope_branch_id = any(actor_selected)) then
      raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
    elsif new.data_scope = 'SELECTED_BRANCHES' and not new.selected_branch_ids <@ actor_selected then
      raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
    elsif new.data_scope in ('OWN_RECORDS', 'OWN_TEAM') and (
      not exists (
        select 1 from public.user_branch_access access_row
        where access_row.organization_id = new.organization_id
          and access_row.user_id = new.user_id
          and access_row.branch_id = any(actor_selected)
        union all
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = new.organization_id
          and member_row.user_id = new.user_id
          and member_row.active
          and team_row.active
          and team_row.branch_id = any(actor_selected)
      )
      or exists (
        select 1 from public.user_branch_access access_row
        where access_row.organization_id = new.organization_id
          and access_row.user_id = new.user_id
          and not (access_row.branch_id = any(actor_selected))
      )
      or exists (
        select 1
        from public.team_members member_row
        join public.teams team_row
          on team_row.id = member_row.team_id
         and team_row.organization_id = member_row.organization_id
        where member_row.organization_id = new.organization_id
          and member_row.user_id = new.user_id
          and member_row.active
          and team_row.active
          and not (team_row.branch_id = any(actor_selected))
      )
    ) then
      raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.granted_by := auth.uid();
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    new.organization_id,
    auth.uid(),
    case when tg_op = 'INSERT' then 'role_assignment.created' else 'role_assignment.updated' end,
    'user_role_assignment',
    new.id::text,
    jsonb_build_object('user_id', new.user_id, 'role_id', new.role_id, 'data_scope', new.data_scope)
  );
  return new;
end;
$$;

drop trigger if exists enforce_delegation_ceiling on public.user_role_assignments;
create trigger enforce_delegation_ceiling
before insert or update on public.user_role_assignments
for each row execute function app_private.validate_delegation_ceiling();

create or replace function app_private.validate_lead_tenant_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT'
    and coalesce(auth.role(), '') = 'authenticated'
    and (
      new.team_id is not null
      or new.assigned_user_id is not null
      or new.connection_id is not null
      or new.external_lead_id is not null
      or new.raw_payload is not null
    )
    and coalesce(current_setting('app.create_lead_rpc', true), '') <> 'on'
  then
    raise exception using errcode = '42501', message = 'CONTROLLED_LEAD_CREATE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.branches branch_row
    where branch_row.id = new.branch_id
      and branch_row.organization_id = new.organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'LEAD_BRANCH_NOT_IN_ORGANIZATION';
  end if;
  if new.team_id is not null and not exists (
    select 1 from public.teams team_row
    where team_row.id = new.team_id
      and team_row.organization_id = new.organization_id
      and team_row.branch_id = new.branch_id
      and team_row.active
  ) then
    raise exception using errcode = '23503', message = 'LEAD_TEAM_NOT_IN_BRANCH';
  end if;
  if new.customer_id is not null and not exists (
    select 1 from public.customers customer_row
    where customer_row.id = new.customer_id
      and customer_row.organization_id = new.organization_id
      and customer_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'LEAD_CUSTOMER_NOT_IN_ORGANIZATION';
  end if;
  if new.connection_id is not null and not exists (
    select 1 from public.connected_accounts connection_row
    where connection_row.id = new.connection_id
      and connection_row.organization_id = new.organization_id
      and connection_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'LEAD_CONNECTION_NOT_IN_ORGANIZATION';
  end if;
  if new.assigned_user_id is not null then
    if new.team_id is null then
      raise exception using errcode = '23514', message = 'ASSIGNED_LEAD_REQUIRES_TEAM';
    end if;
    if not exists (
      select 1
      from public.profiles profile_row
      join public.team_members member_row
        on member_row.user_id = profile_row.id
       and member_row.organization_id = profile_row.organization_id
      where profile_row.id = new.assigned_user_id
        and profile_row.organization_id = new.organization_id
        and profile_row.active
        and member_row.team_id = new.team_id
        and member_row.active
    ) then
      raise exception using errcode = '23503', message = 'LEAD_ASSIGNEE_NOT_IN_TEAM';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '42501', message = 'LEAD_ORGANIZATION_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE'
    and (
      new.branch_id is distinct from old.branch_id
      or new.team_id is distinct from old.team_id
      or new.assigned_user_id is distinct from old.assigned_user_id
    )
    and coalesce(auth.role(), '') = 'authenticated'
    and coalesce(current_setting('app.assign_lead_rpc', true), '') <> 'on'
  then
    raise exception using errcode = '42501', message = 'ASSIGNMENT_RPC_REQUIRED';
  end if;
  if tg_op = 'UPDATE'
    and new.customer_id is distinct from old.customer_id
    and coalesce(auth.role(), '') = 'authenticated'
    and coalesce(current_setting('app.link_customer_rpc', true), '') <> 'on'
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_LINK_RPC_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_lead_tenant_integrity on public.leads;
create trigger enforce_lead_tenant_integrity
before insert or update on public.leads
for each row execute function app_private.validate_lead_tenant_integrity();

create or replace function app_private.validate_connected_account_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '42501', message = 'CONNECTED_ACCOUNT_IDENTITY_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' and (
    new.created_by is null
    or not app_private.actor_has_tenant_operation_context(
      new.created_by,
      new.organization_id,
      'integration.manage'
    )
  ) then
    raise exception using errcode = '42501', message = 'INVALID_CONNECTED_ACCOUNT_ACTOR';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_connected_account_actor on public.connected_accounts;
create trigger enforce_connected_account_actor
before insert or update on public.connected_accounts
for each row execute function app_private.validate_connected_account_actor();

create or replace function app_private.validate_integration_credential_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  validate_actor boolean := tg_op = 'INSERT';
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.connected_account_id is distinct from old.connected_account_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '42501', message = 'INTEGRATION_CREDENTIAL_IDENTITY_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' then
    validate_actor := new.replaced_by is distinct from old.replaced_by;
  end if;
  if validate_actor and (
      new.replaced_by is null
      or not app_private.actor_has_tenant_operation_context(
        new.replaced_by,
        new.organization_id,
        'integration.manage'
      )
    ) then
    raise exception using errcode = '42501', message = 'INVALID_CREDENTIAL_REPLACEMENT_ACTOR';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_integration_credential_actor on public.integration_credentials;
create trigger enforce_integration_credential_actor
before insert or update on public.integration_credentials
for each row execute function app_private.validate_integration_credential_actor();

create or replace function app_private.validate_connected_account_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
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

drop trigger if exists enforce_connected_account_write_security on public.connected_accounts;
create trigger enforce_connected_account_write_security
before insert or update on public.connected_accounts
for each row execute function app_private.validate_connected_account_write();

create or replace function public.create_lead(
  target_organization_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  lead_source text,
  lead_customer_name text,
  lead_phone text,
  lead_email text default null,
  lead_source_detail text default null,
  lead_campaign text default null,
  lead_interested_model text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  normalized_phone text;
  new_lead_id uuid;
  team_mode public.assignment_mode;
  selected_user_id uuid;
  assignment_id uuid;
begin
  if not app_private.has_permission(target_organization_id, 'lead.create')
    or not app_private.can_access_branch(target_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if lead_source is null or lead_source not in (
    'Facebook', 'Instagram', 'Google Ads', 'Website', 'WhatsApp Business',
    'CarWale', 'CarDekho', 'Justdial', 'IndiaMART', 'Manual', 'Other'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_SOURCE';
  end if;
  if char_length(btrim(coalesce(lead_customer_name, ''))) not between 2 and 160 then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_NAME';
  end if;
  if char_length(coalesce(lead_phone, '')) > 24 then
    raise exception using errcode = '22023', message = 'INVALID_PHONE';
  end if;
  normalized_phone := regexp_replace(coalesce(lead_phone, ''), '[^0-9+]', '', 'g');
  if normalized_phone !~ '^[+]?[0-9]{7,15}$' then
    raise exception using errcode = '22023', message = 'INVALID_PHONE';
  end if;
  if lead_email is not null and (
    char_length(lead_email) > 320
    or btrim(lead_email) !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_EMAIL';
  end if;
  if char_length(coalesce(lead_source_detail, '')) > 200
    or char_length(coalesce(lead_campaign, '')) > 200
    or char_length(coalesce(lead_interested_model, '')) > 160
  then
    raise exception using errcode = '22023', message = 'LEAD_FIELD_TOO_LONG';
  end if;
  if target_team_id is not null then
    -- Serialize fresh round-robin selection per team. This prevents concurrent
    -- manual creation requests from choosing the same least-recently assigned
    -- member before either history row becomes visible.
    select team_row.fresh_assignment_mode into team_mode
    from public.teams team_row
    where team_row.id = target_team_id
      and team_row.organization_id = target_organization_id
      and team_row.branch_id = target_branch_id
      and team_row.active
    for update;
    if not found then
      raise exception using errcode = '23503', message = 'LEAD_TEAM_NOT_IN_BRANCH';
    end if;

    if team_mode = 'ROUND_ROBIN' then
      select member_row.user_id into selected_user_id
      from public.team_members member_row
      join public.profiles profile_row
        on profile_row.id = member_row.user_id
       and profile_row.organization_id = member_row.organization_id
      left join lateral (
        select max(history_row.created_at) as last_assigned_at
        from public.lead_assignment_history history_row
        where history_row.organization_id = target_organization_id
          and history_row.team_id = target_team_id
          and history_row.new_owner_id = member_row.user_id
          and history_row.method = 'ROUND_ROBIN'
      ) assignment_history on true
      where member_row.organization_id = target_organization_id
        and member_row.team_id = target_team_id
        and member_row.active
        and member_row.eligible_for_fresh_leads
        and profile_row.active
        and profile_row.deleted_at is null
      order by assignment_history.last_assigned_at nulls first,
        member_row.joined_at,
        member_row.user_id
      limit 1;
      if selected_user_id is null then
        raise exception using errcode = '23514', message = 'NO_ELIGIBLE_FRESH_ASSIGNEE';
      end if;
    end if;
  end if;

  perform set_config('app.create_lead_rpc', 'on', true);
  insert into public.leads (
    organization_id,
    branch_id,
    team_id,
    source,
    source_detail,
    campaign,
    customer_name,
    phone,
    normalized_phone,
    email,
    interested_model,
    assigned_user_id
  ) values (
    target_organization_id,
    target_branch_id,
    target_team_id,
    lead_source,
    nullif(btrim(lead_source_detail), ''),
    nullif(btrim(lead_campaign), ''),
    btrim(lead_customer_name),
    btrim(lead_phone),
    normalized_phone,
    nullif(lower(btrim(lead_email)), ''),
    nullif(btrim(lead_interested_model), ''),
    selected_user_id
  ) returning id into new_lead_id;

  if selected_user_id is not null then
    insert into public.lead_assignments (
      organization_id, lead_id, branch_id, team_id, assigned_user_id,
      assignment_type, method, assigned_by, reason
    ) values (
      target_organization_id, new_lead_id, target_branch_id, target_team_id,
      selected_user_id, 'FRESH', 'ROUND_ROBIN', auth.uid(),
      'Automatic fresh lead assignment'
    ) returning id into assignment_id;
    insert into public.lead_assignment_history (
      organization_id, lead_id, branch_id, team_id, previous_owner_id,
      new_owner_id, assigned_by, method, reason
    ) values (
      target_organization_id, new_lead_id, target_branch_id, target_team_id,
      null, selected_user_id, auth.uid(), 'ROUND_ROBIN',
      'Automatic fresh lead assignment'
    );
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    target_organization_id,
    auth.uid(),
    'lead.created',
    'lead',
    new_lead_id::text,
    target_branch_id,
    jsonb_build_object(
      'source', lead_source,
      'team_id', target_team_id,
      'assigned_user_id', selected_user_id,
      'assignment_id', assignment_id,
      'assignment_mode', coalesce(team_mode::text, 'UNASSIGNED')
    )
  );
  return new_lead_id;
end;
$$;

revoke all on function public.create_lead(
  uuid, uuid, uuid, text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.create_lead(
  uuid, uuid, uuid, text, text, text, text, text, text, text
) to authenticated;

create or replace function public.update_lead(
  target_lead_id uuid,
  expected_updated_at timestamptz,
  lead_patch jsonb,
  change_reason text default null
)
returns public.leads language plpgsql security definer set search_path = '' as $$
declare
  current_lead public.leads%rowtype;
  updated_lead public.leads%rowtype;
  next_customer_name text;
  next_phone text;
  next_normalized_phone text;
  next_email text;
  next_interested_model text;
  next_lifecycle public.lead_lifecycle;
  next_temperature public.lead_temperature;
  next_first_contacted_at timestamptz;
  next_followup_timestamp timestamptz;
  next_lost_reason text;
  next_updated_at timestamptz;
  changed_fields jsonb;
begin
  if expected_updated_at is null then
    raise exception using errcode = '22023', message = 'EXPECTED_UPDATED_AT_REQUIRED';
  end if;
  if lead_patch is null or jsonb_typeof(lead_patch) <> 'object' or lead_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_PATCH';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(lead_patch) as patch_key(key)
    where patch_key.key not in (
      'customer_name',
      'phone',
      'email',
      'interested_model',
      'lifecycle_status',
      'temperature',
      'first_contacted_at',
      'next_followup_at',
      'lost_reason'
    )
  ) then
    raise exception using errcode = '22023', message = 'LEAD_PATCH_FIELD_FORBIDDEN';
  end if;
  if char_length(coalesce(change_reason, '')) > 500 then
    raise exception using errcode = '22023', message = 'CHANGE_REASON_TOO_LONG';
  end if;

  select * into current_lead
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_lead.organization_id, 'lead.update')
    or not app_private.can_access_record(
      current_lead.organization_id,
      current_lead.branch_id,
      current_lead.team_id,
      current_lead.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if current_lead.updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'LEAD_VERSION_CONFLICT';
  end if;

  next_customer_name := current_lead.customer_name;
  next_phone := current_lead.phone;
  next_normalized_phone := current_lead.normalized_phone;
  next_email := current_lead.email;
  next_interested_model := current_lead.interested_model;
  next_lifecycle := current_lead.lifecycle_status;
  next_temperature := current_lead.temperature;
  next_first_contacted_at := current_lead.first_contacted_at;
  next_followup_timestamp := current_lead.next_followup_at;
  next_lost_reason := current_lead.lost_reason;

  if lead_patch ? 'customer_name' then
    if jsonb_typeof(lead_patch -> 'customer_name') <> 'string'
      or char_length(btrim(lead_patch ->> 'customer_name')) not between 2 and 160
    then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_NAME';
    end if;
    next_customer_name := btrim(lead_patch ->> 'customer_name');
  end if;
  if lead_patch ? 'phone' then
    if jsonb_typeof(lead_patch -> 'phone') <> 'string'
      or char_length(lead_patch ->> 'phone') > 24
    then
      raise exception using errcode = '22023', message = 'INVALID_PHONE';
    end if;
    next_phone := btrim(lead_patch ->> 'phone');
    next_normalized_phone := regexp_replace(next_phone, '[^0-9+]', '', 'g');
    if next_normalized_phone !~ '^[+]?[0-9]{7,15}$' then
      raise exception using errcode = '22023', message = 'INVALID_PHONE';
    end if;
  end if;
  if lead_patch ? 'email' then
    if jsonb_typeof(lead_patch -> 'email') = 'null' then
      next_email := null;
    elsif jsonb_typeof(lead_patch -> 'email') <> 'string'
      or char_length(lead_patch ->> 'email') > 320
      or btrim(lead_patch ->> 'email') !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    then
      raise exception using errcode = '22023', message = 'INVALID_EMAIL';
    else
      next_email := lower(btrim(lead_patch ->> 'email'));
    end if;
  end if;
  if lead_patch ? 'interested_model' then
    if jsonb_typeof(lead_patch -> 'interested_model') = 'null' then
      next_interested_model := null;
    elsif jsonb_typeof(lead_patch -> 'interested_model') <> 'string'
      or char_length(btrim(lead_patch ->> 'interested_model')) > 160
    then
      raise exception using errcode = '22023', message = 'INVALID_INTERESTED_MODEL';
    else
      next_interested_model := nullif(btrim(lead_patch ->> 'interested_model'), '');
    end if;
  end if;
  if lead_patch ? 'lifecycle_status' then
    if jsonb_typeof(lead_patch -> 'lifecycle_status') <> 'string'
      or (lead_patch ->> 'lifecycle_status') not in (
        'New', 'Contacted', 'Qualified', 'Appointment Scheduled',
        'Transferred to Sales', 'Lost'
      )
    then
      raise exception using errcode = '22023', message = 'INVALID_LIFECYCLE_STATUS';
    end if;
    next_lifecycle := (lead_patch ->> 'lifecycle_status')::public.lead_lifecycle;
  end if;
  if lead_patch ? 'temperature' then
    if jsonb_typeof(lead_patch -> 'temperature') = 'null' then
      if current_lead.temperature is not null then
        raise exception using errcode = '22023', message = 'TEMPERATURE_CLEAR_FORBIDDEN';
      end if;
      next_temperature := null;
    elsif jsonb_typeof(lead_patch -> 'temperature') <> 'string'
      or (lead_patch ->> 'temperature') not in ('COLD', 'WARM', 'HOT')
    then
      raise exception using errcode = '22023', message = 'INVALID_LEAD_TEMPERATURE';
    else
      next_temperature := (lead_patch ->> 'temperature')::public.lead_temperature;
    end if;
  end if;
  if lead_patch ? 'first_contacted_at' then
    if jsonb_typeof(lead_patch -> 'first_contacted_at') = 'null' then
      if current_lead.first_contacted_at is not null then
        raise exception using errcode = '22023', message = 'FIRST_CONTACT_IMMUTABLE';
      end if;
      next_first_contacted_at := null;
    elsif jsonb_typeof(lead_patch -> 'first_contacted_at') <> 'string' then
      raise exception using errcode = '22023', message = 'INVALID_FIRST_CONTACTED_AT';
    else
      begin
        next_first_contacted_at := (lead_patch ->> 'first_contacted_at')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'INVALID_FIRST_CONTACTED_AT';
      end;
      if current_lead.first_contacted_at is not null
        and next_first_contacted_at is distinct from current_lead.first_contacted_at
      then
        raise exception using errcode = '22023', message = 'FIRST_CONTACT_IMMUTABLE';
      end if;
    end if;
  end if;
  if lead_patch ? 'next_followup_at' then
    if jsonb_typeof(lead_patch -> 'next_followup_at') = 'null' then
      next_followup_timestamp := null;
    elsif jsonb_typeof(lead_patch -> 'next_followup_at') <> 'string' then
      raise exception using errcode = '22023', message = 'INVALID_NEXT_FOLLOWUP_AT';
    else
      begin
        next_followup_timestamp := (lead_patch ->> 'next_followup_at')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'INVALID_NEXT_FOLLOWUP_AT';
      end;
    end if;
  end if;
  if lead_patch ? 'lost_reason' then
    if jsonb_typeof(lead_patch -> 'lost_reason') = 'null' then
      next_lost_reason := null;
    elsif jsonb_typeof(lead_patch -> 'lost_reason') <> 'string'
      or char_length(btrim(lead_patch ->> 'lost_reason')) > 500
    then
      raise exception using errcode = '22023', message = 'INVALID_LOST_REASON';
    else
      next_lost_reason := nullif(btrim(lead_patch ->> 'lost_reason'), '');
    end if;
  end if;

  if next_lifecycle is distinct from current_lead.lifecycle_status
    or next_temperature is distinct from current_lead.temperature
  then
    if nullif(btrim(change_reason), '') is null then
      raise exception using errcode = '22023', message = 'CHANGE_REASON_REQUIRED';
    end if;
  end if;
  if next_lifecycle = 'Lost' and next_lost_reason is null then
    raise exception using errcode = '22023', message = 'LOST_REASON_REQUIRED';
  elsif next_lifecycle <> 'Lost' then
    next_lost_reason := null;
  end if;
  if next_first_contacted_at is null
    and next_lifecycle in (
      'Contacted', 'Qualified', 'Appointment Scheduled', 'Transferred to Sales'
    )
  then
    next_first_contacted_at := clock_timestamp();
  end if;
  if next_first_contacted_at is not null and (
    next_first_contacted_at < current_lead.created_at
    or next_first_contacted_at > now() + interval '5 minutes'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_FIRST_CONTACTED_AT';
  end if;
  if next_lifecycle = 'New' and next_first_contacted_at is not null then
    raise exception using errcode = '23514', message = 'NEW_LEAD_CANNOT_BE_CONTACTED';
  end if;

  next_updated_at := greatest(
    clock_timestamp(),
    current_lead.updated_at + interval '1 microsecond'
  );
  update public.leads lead_row
  set customer_name = next_customer_name,
    phone = next_phone,
    normalized_phone = next_normalized_phone,
    email = next_email,
    interested_model = next_interested_model,
    lifecycle_status = next_lifecycle,
    temperature = next_temperature,
    first_contacted_at = next_first_contacted_at,
    next_followup_at = next_followup_timestamp,
    lost_reason = next_lost_reason,
    updated_at = next_updated_at
  where lead_row.id = target_lead_id
  returning lead_row.* into updated_lead;

  if next_lifecycle is distinct from current_lead.lifecycle_status then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_lead.organization_id,
      current_lead.id,
      current_lead.lifecycle_status,
      next_lifecycle,
      auth.uid(),
      btrim(change_reason)
    );
  end if;
  if next_temperature is distinct from current_lead.temperature then
    insert into public.lead_temperature_history (
      organization_id, lead_id, from_temperature, to_temperature, changed_by
    ) values (
      current_lead.organization_id,
      current_lead.id,
      current_lead.temperature,
      next_temperature,
      auth.uid()
    );
  end if;
  select coalesce(jsonb_agg(patch_key.key order by patch_key.key), '[]'::jsonb)
    into changed_fields
  from jsonb_object_keys(lead_patch) as patch_key(key);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_lead.organization_id,
    auth.uid(),
    'lead.updated',
    'lead',
    current_lead.id::text,
    current_lead.branch_id,
    jsonb_build_object(
      'changed_fields', changed_fields,
      'reason', nullif(btrim(change_reason), ''),
      'previous_updated_at', current_lead.updated_at,
      'updated_at', next_updated_at
    )
  );
  return updated_lead;
end;
$$;

revoke all on function public.update_lead(uuid, timestamptz, jsonb, text) from public, anon;
grant execute on function public.update_lead(uuid, timestamptz, jsonb, text) to authenticated;

create or replace function public.assign_lead(
  target_lead_id uuid,
  target_user_id uuid,
  assignment_kind text,
  assignment_reason text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target_lead public.leads%rowtype;
  team_mode public.assignment_mode;
  prior_owner uuid;
  selected_user_id uuid;
  assignment_id uuid;
begin
  if assignment_kind not in ('FRESH', 'QUALIFIED') then
    raise exception using errcode = '22023', message = 'INVALID_ASSIGNMENT_KIND';
  end if;
  select * into target_lead
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(target_lead.organization_id, 'lead.assign')
    or not app_private.can_access_record(
      target_lead.organization_id,
      target_lead.branch_id,
      target_lead.team_id,
      target_lead.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;

  select case
      when assignment_kind = 'FRESH' then team_row.fresh_assignment_mode
      else team_row.qualified_assignment_mode
    end
    into team_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = target_lead.organization_id
    and team_row.branch_id = target_lead.branch_id
    and team_row.active
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'LEAD_TEAM_NOT_AVAILABLE';
  end if;

  if team_mode = 'ROUND_ROBIN' then
    select member_row.user_id into selected_user_id
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    left join lateral (
      select max(history_row.created_at) as last_assigned_at
      from public.lead_assignment_history history_row
      where history_row.organization_id = target_lead.organization_id
        and history_row.team_id = target_lead.team_id
        and history_row.new_owner_id = member_row.user_id
        and (
          (assignment_kind = 'FRESH' and history_row.method = 'ROUND_ROBIN')
          or assignment_kind = 'QUALIFIED'
        )
    ) assignment_history on true
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.active
      and profile_row.active
      and (
        (assignment_kind = 'FRESH' and member_row.eligible_for_fresh_leads)
        or (assignment_kind = 'QUALIFIED' and member_row.eligible_for_qualified_leads)
      )
    order by assignment_history.last_assigned_at nulls first, member_row.joined_at, member_row.user_id
    limit 1;
  else
    selected_user_id := target_user_id;
  end if;
  if selected_user_id is null or not exists (
    select 1
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.user_id = selected_user_id
      and member_row.active
      and profile_row.active
      and (
        (assignment_kind = 'FRESH' and member_row.eligible_for_fresh_leads)
        or (assignment_kind = 'QUALIFIED' and member_row.eligible_for_qualified_leads)
      )
  ) then
    raise exception using errcode = '23514', message = 'ASSIGNEE_NOT_ELIGIBLE';
  end if;

  prior_owner := target_lead.assigned_user_id;
  if prior_owner is not null and prior_owner <> selected_user_id
    and nullif(btrim(assignment_reason), '') is null
  then
    raise exception using errcode = '22023', message = 'REASSIGNMENT_REASON_REQUIRED';
  end if;
  select active_assignment.id into assignment_id
  from public.lead_assignments active_assignment
  where active_assignment.lead_id = target_lead_id
    and active_assignment.assigned_user_id = selected_user_id
    and active_assignment.assignment_type = assignment_kind
    and active_assignment.active
  limit 1;
  if found then
    return assignment_id;
  end if;

  update public.lead_assignments
  set active = false
  where lead_id = target_lead_id and active;
  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    target_lead.organization_id, target_lead.id, target_lead.branch_id,
    target_lead.team_id, selected_user_id, assignment_kind, team_mode,
    auth.uid(), assignment_reason
  ) returning id into assignment_id;
  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    target_lead.organization_id, target_lead.id, target_lead.branch_id,
    target_lead.team_id, prior_owner, selected_user_id, auth.uid(),
    team_mode, assignment_reason
  );
  perform set_config('app.assign_lead_rpc', 'on', true);
  update public.leads
  set assigned_user_id = selected_user_id, updated_at = now()
  where id = target_lead_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    target_lead.organization_id,
    auth.uid(),
    case when prior_owner is null then 'lead.assigned' else 'lead.reassigned' end,
    'lead',
    target_lead.id::text,
    target_lead.branch_id,
    jsonb_build_object(
      'previous_owner_id', prior_owner,
      'new_owner_id', selected_user_id,
      'method', team_mode,
      'assignment_type', assignment_kind,
      'reason', assignment_reason
    )
  );
  return assignment_id;
end;
$$;

create or replace function public.link_lead_to_customer(
  target_lead_id uuid,
  target_customer_id uuid,
  link_reason text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  lead_row public.leads%rowtype;
begin
  if nullif(btrim(link_reason), '') is null then
    raise exception using errcode = '22023', message = 'LINK_REASON_REQUIRED';
  end if;
  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if lead_row.customer_id is not null then
    raise exception using errcode = '23505', message = 'LEAD_ALREADY_LINKED';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'customer.link')
    or not app_private.can_access_record(
      lead_row.organization_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not exists (
    select 1 from public.customers customer_row
    where customer_row.id = target_customer_id
      and customer_row.organization_id = lead_row.organization_id
      and customer_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'CUSTOMER_NOT_IN_ORGANIZATION';
  end if;
  perform set_config('app.link_customer_rpc', 'on', true);
  update public.leads
  set customer_id = target_customer_id, updated_at = now()
  where id = target_lead_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    lead_row.organization_id,
    auth.uid(),
    'customer.link.reviewed',
    'lead',
    target_lead_id::text,
    lead_row.branch_id,
    jsonb_build_object('customer_id', target_customer_id, 'reason', link_reason)
  );
  return target_customer_id;
end;
$$;

create or replace function public.possible_customer_matches(target_lead_id uuid)
returns table (
  customer_id uuid,
  full_name text,
  masked_phone text,
  masked_email text,
  match_reason text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  lead_row public.leads%rowtype;
begin
  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'customer.view')
    or not app_private.can_access_record(
      lead_row.organization_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  return query
  select customer_row.id,
    customer_row.full_name,
    case
      when customer_row.primary_phone is null then null
      else left(customer_row.primary_phone, 3) || '•••••' || right(customer_row.primary_phone, 2)
    end,
    case
      when customer_row.primary_email is null then null
      else left(customer_row.primary_email, 2) || '•••@' || split_part(customer_row.primary_email, '@', 2)
    end,
    case when customer_row.normalized_phone = lead_row.normalized_phone then 'PHONE' else 'EMAIL' end
  from public.customers customer_row
  where customer_row.organization_id = lead_row.organization_id
    and customer_row.deleted_at is null
    and (
      customer_row.normalized_phone = lead_row.normalized_phone
      or (
        lead_row.email is not null
        and customer_row.normalized_email = lower(trim(lead_row.email))
      )
    )
  order by customer_row.updated_at desc
  limit 10;
end;
$$;

-- Completion is split deliberately: the end anchor may commit while the mobile route
-- buffer is still uploading, and route finalization can be retried safely afterward.
alter table public.test_drive_route_summaries
  add column if not exists payload_hash text,
  add column if not exists finalized_at timestamptz;
alter table public.test_drive_route_summaries
  add constraint test_drive_route_summary_payload_hash_shape
  check (payload_hash is null or char_length(payload_hash) = 64) not valid;

create or replace function public.record_test_drive_anchor(
  target_test_drive_id uuid,
  anchor_kind text,
  latitude double precision,
  longitude double precision,
  recorded_at timestamptz,
  odometer integer default null
)
returns public.test_drives language plpgsql security definer set search_path = '' as $$
declare
  drive public.test_drives%rowtype;
  anchor jsonb;
begin
  if anchor_kind not in ('start', 'reached', 'end') then
    raise exception using errcode = '22023', message = 'INVALID_ANCHOR_KIND';
  end if;
  if recorded_at is null or recorded_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'INVALID_RECORDED_AT';
  end if;
  if latitude is null or longitude is null
    or latitude not between -90 and 90
    or longitude not between -180 and 180
  then
    raise exception using errcode = '22023', message = 'INVALID_COORDINATES';
  end if;
  if odometer is not null and odometer not between 0 and 2000000 then
    raise exception using errcode = '22023', message = 'INVALID_ODOMETER';
  end if;

  select * into drive
  from public.test_drives
  where id = target_test_drive_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND';
  end if;
  if not app_private.has_permission(drive.organization_id, 'test_drive.manage')
    or not app_private.can_access_record(
      drive.organization_id,
      drive.branch_id,
      drive.team_id,
      drive.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  anchor := jsonb_build_object(
    'latitude', latitude,
    'longitude', longitude,
    'recorded_at', recorded_at
  );
  if anchor_kind = 'start' then
    if drive.status = 'ACTIVE'
      and drive.started_at = recorded_at
      and drive.start_odometer = odometer
      and (drive.start_anchor ->> 'latitude')::double precision = latitude
      and (drive.start_anchor ->> 'longitude')::double precision = longitude
    then
      return drive;
    end if;
    if drive.status not in ('READY', 'SCHEDULED') or odometer is null then
      raise exception using errcode = '23514', message = 'INVALID_START_TRANSITION';
    end if;
    update public.test_drives
    set status = 'ACTIVE',
      started_at = recorded_at,
      start_anchor = anchor,
      start_odometer = odometer
    where id = target_test_drive_id
    returning * into drive;
  elsif anchor_kind = 'reached' then
    if drive.reached_at is not null then
      if drive.reached_at = recorded_at
        and (drive.reached_anchor ->> 'latitude')::double precision = latitude
        and (drive.reached_anchor ->> 'longitude')::double precision = longitude
      then
        return drive;
      end if;
      raise exception using errcode = '23514', message = 'REACHED_ALREADY_RECORDED';
    end if;
    if drive.status <> 'ACTIVE'
      or drive.started_at is null
      or recorded_at < drive.started_at
    then
      raise exception using errcode = '23514', message = 'DRIVE_NOT_ACTIVE';
    end if;
    update public.test_drives
    set reached_at = recorded_at, reached_anchor = anchor
    where id = target_test_drive_id
    returning * into drive;
  else
    if drive.status = 'COMPLETED' then
      if drive.completed_at = recorded_at
        and drive.end_odometer = odometer
        and (drive.end_anchor ->> 'latitude')::double precision = latitude
        and (drive.end_anchor ->> 'longitude')::double precision = longitude
      then
        return drive;
      end if;
      raise exception using errcode = '23514', message = 'END_ALREADY_RECORDED';
    end if;
    if drive.status <> 'ACTIVE'
      or drive.started_at is null
      or odometer is null
      or drive.start_odometer is null
      or odometer < drive.start_odometer
      or recorded_at < drive.started_at
      or recorded_at > drive.started_at + interval '24 hours'
      or (drive.reached_at is not null and recorded_at < drive.reached_at)
    then
      raise exception using errcode = '23514', message = 'INVALID_END_TRANSITION';
    end if;
    update public.test_drives
    set status = 'COMPLETED',
      completed_at = recorded_at,
      end_anchor = anchor,
      end_odometer = odometer,
      duration_seconds = greatest(0, extract(epoch from recorded_at - drive.started_at)::integer),
      distance_meters = (odometer - drive.start_odometer) * 1000
    where id = target_test_drive_id
    returning * into drive;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    drive.organization_id,
    auth.uid(),
    'test_drive.anchor.' || anchor_kind,
    'test_drive',
    drive.id::text,
    drive.branch_id,
    jsonb_build_object('recorded_at', recorded_at)
  );
  return drive;
end;
$$;

create or replace function public.finalize_test_drive_route(
  target_test_drive_id uuid,
  route_points jsonb,
  encoded_polyline text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  drive public.test_drives%rowtype;
  point jsonb;
  existing_summary public.test_drive_route_summaries%rowtype;
  summary_id uuid;
  route_hash text;
  point_total integer;
  expected_sequence integer := 1;
  point_sequence integer;
  point_latitude double precision;
  point_longitude double precision;
  point_recorded_at timestamptz;
  previous_recorded_at timestamptz;
  stored_point_count integer;
  stored_points_match boolean;
  point_matches boolean;
begin
  select * into drive
  from public.test_drives
  where id = target_test_drive_id and status = 'COMPLETED'
  for update;
  if not found or drive.started_at is null or drive.completed_at is null then
    raise exception using errcode = '23514', message = 'DRIVE_NOT_COMPLETED';
  end if;
  if not app_private.has_permission(drive.organization_id, 'test_drive.manage')
    or not app_private.can_access_record(
      drive.organization_id,
      drive.branch_id,
      drive.team_id,
      drive.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if route_points is null or jsonb_typeof(route_points) <> 'array' then
    raise exception using errcode = '22023', message = 'ROUTE_POINTS_MUST_BE_ARRAY';
  end if;
  point_total := jsonb_array_length(route_points);
  if point_total > 2000 then
    raise exception using errcode = '22023', message = 'TOO_MANY_ROUTE_POINTS';
  end if;
  if encoded_polyline is not null and char_length(encoded_polyline) > 100000 then
    raise exception using errcode = '22023', message = 'ENCODED_POLYLINE_TOO_LONG';
  end if;

  for point in select value from jsonb_array_elements(route_points) loop
    if jsonb_typeof(point) <> 'object'
      or not (point ?& array['sequenceNo', 'latitude', 'longitude', 'recordedAt'])
      or jsonb_typeof(point -> 'sequenceNo') <> 'number'
      or jsonb_typeof(point -> 'latitude') <> 'number'
      or jsonb_typeof(point -> 'longitude') <> 'number'
      or jsonb_typeof(point -> 'recordedAt') <> 'string'
      or (point ->> 'sequenceNo') !~ '^[0-9]+$'
    then
      raise exception using errcode = '22023', message = 'INVALID_ROUTE_POINT';
    end if;
    begin
      point_sequence := (point ->> 'sequenceNo')::integer;
      point_latitude := (point ->> 'latitude')::double precision;
      point_longitude := (point ->> 'longitude')::double precision;
      point_recorded_at := (point ->> 'recordedAt')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_ROUTE_POINT';
    end;
    if point_sequence <> expected_sequence then
      raise exception using errcode = '22023', message = 'INVALID_ROUTE_SEQUENCE';
    end if;
    if point_latitude not between -90 and 90
      or point_longitude not between -180 and 180
    then
      raise exception using errcode = '22023', message = 'INVALID_ROUTE_COORDINATES';
    end if;
    if point_recorded_at < drive.started_at
      or point_recorded_at > drive.completed_at
      or (previous_recorded_at is not null and point_recorded_at < previous_recorded_at)
    then
      raise exception using errcode = '22023', message = 'INVALID_ROUTE_TIMESTAMP';
    end if;
    expected_sequence := expected_sequence + 1;
    previous_recorded_at := point_recorded_at;
  end loop;

  route_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        route_points::text || E'\n' || coalesce(encoded_polyline, ''),
        'UTF8'
      )
    ),
    'hex'
  );
  select count(*) into stored_point_count
  from public.test_drive_route_points stored_point
  where stored_point.test_drive_id = target_test_drive_id;
  stored_points_match := stored_point_count = point_total;
  if stored_points_match then
    for point in select value from jsonb_array_elements(route_points) loop
      select exists (
        select 1
        from public.test_drive_route_points stored_point
        where stored_point.test_drive_id = target_test_drive_id
          and stored_point.sequence_no = (point ->> 'sequenceNo')::integer
          and stored_point.latitude = (point ->> 'latitude')::double precision
          and stored_point.longitude = (point ->> 'longitude')::double precision
          and stored_point.recorded_at = (point ->> 'recordedAt')::timestamptz
      ) into point_matches;
      if not point_matches then
        stored_points_match := false;
        exit;
      end if;
    end loop;
  end if;

  select * into existing_summary
  from public.test_drive_route_summaries summary_row
  where summary_row.test_drive_id = target_test_drive_id
  for update;
  if found then
    if stored_points_match
      and existing_summary.point_count = point_total
      and existing_summary.encoded_polyline is not distinct from encoded_polyline
    then
      if existing_summary.payload_hash is distinct from route_hash
        or existing_summary.finalized_at is null
      then
        update public.test_drive_route_summaries
        set payload_hash = route_hash,
          finalized_at = coalesce(finalized_at, now())
        where id = existing_summary.id;
      end if;
      return existing_summary.id;
    end if;
    raise exception using errcode = '23514', message = 'ROUTE_ALREADY_FINALIZED';
  end if;

  if stored_point_count > 0 and not stored_points_match then
    raise exception using errcode = '23514', message = 'ROUTE_STATE_CONFLICT';
  end if;
  if stored_point_count = 0 then
    for point in select value from jsonb_array_elements(route_points) loop
      insert into public.test_drive_route_points (
        organization_id, test_drive_id, sequence_no, latitude, longitude, recorded_at
      ) values (
        drive.organization_id,
        drive.id,
        (point ->> 'sequenceNo')::integer,
        (point ->> 'latitude')::double precision,
        (point ->> 'longitude')::double precision,
        (point ->> 'recordedAt')::timestamptz
      );
    end loop;
  end if;
  insert into public.test_drive_route_summaries (
    organization_id,
    test_drive_id,
    encoded_polyline,
    distance_meters,
    duration_seconds,
    point_count,
    payload_hash,
    finalized_at
  ) values (
    drive.organization_id,
    drive.id,
    encoded_polyline,
    coalesce(drive.distance_meters, 0),
    coalesce(drive.duration_seconds, 0),
    point_total,
    route_hash,
    now()
  ) returning id into summary_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    drive.organization_id,
    auth.uid(),
    'test_drive.route.finalized',
    'test_drive',
    drive.id::text,
    drive.branch_id,
    jsonb_build_object('summary_id', summary_id, 'point_count', point_total)
  );
  return summary_id;
end;
$$;

create or replace function public.consume_credits(
  target_organization_id uuid,
  target_ledger public.credit_ledger_kind,
  requested_amount bigint,
  target_feature text,
  idempotency_key text,
  consumption_reason text
)
returns table (ledger_id uuid, balance bigint)
language plpgsql security definer set search_path = '' as $$
declare
  current_balance bigint;
  existing_entry public.credit_ledger%rowtype;
  new_id uuid;
begin
  if requested_amount <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_CREDIT_AMOUNT';
  end if;
  if nullif(btrim(idempotency_key), '') is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if not app_private.has_permission(target_organization_id, 'credit.consume') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target_organization_id::text || ':' || target_ledger::text, 0)
  );
  select * into existing_entry
  from public.credit_ledger ledger_row
  where ledger_row.organization_id = target_organization_id
    and ledger_row.ledger_kind = target_ledger
    and ledger_row.reference_id = idempotency_key;
  if found then
    if existing_entry.transaction_type <> 'CONSUMPTION'
      or existing_entry.amount <> -requested_amount
      or existing_entry.feature is distinct from target_feature
      or existing_entry.user_id is distinct from auth.uid()
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
    select existing_entry.id,
      coalesce(sum(ledger_row.amount), 0)::bigint
    from public.credit_ledger ledger_row
    where ledger_row.organization_id = target_organization_id
      and ledger_row.ledger_kind = target_ledger;
    return;
  end if;

  select coalesce(sum(ledger_row.amount), 0) into current_balance
  from public.credit_ledger ledger_row
  where ledger_row.organization_id = target_organization_id
    and ledger_row.ledger_kind = target_ledger;
  if current_balance < requested_amount then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS';
  end if;
  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature,
    user_id, reference_id, reason, created_by
  ) values (
    target_organization_id, target_ledger, 'CONSUMPTION', -requested_amount,
    target_feature, auth.uid(), idempotency_key, consumption_reason, auth.uid()
  ) returning id into new_id;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    target_organization_id,
    auth.uid(),
    'credit.consumed',
    'credit_ledger',
    new_id::text,
    jsonb_build_object(
      'ledger_kind', target_ledger,
      'amount', requested_amount,
      'feature', target_feature,
      'reference_id', idempotency_key
    )
  );
  return query
  select new_id,
    coalesce(sum(ledger_row.amount), 0)::bigint
  from public.credit_ledger ledger_row
  where ledger_row.organization_id = target_organization_id
    and ledger_row.ledger_kind = target_ledger;
end;
$$;

-- Replace permissive FOR ALL policies on the highest-risk tables with explicit,
-- operation-aware policies. Security-definer RPCs remain the mutation boundary for
-- immutable ledgers, audit history and assignment history.
drop policy if exists organization_scope on public.organizations;
create policy organizations_read on public.organizations
for select to authenticated using (
  (
    app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
  or exists (
    select 1 from public.profiles profile_row
    where profile_row.id = auth.uid()
      and profile_row.active
      and profile_row.organization_id = organizations.id
      and organizations.status in (
        'ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED', 'ACTIVE', 'SUPPORT_MAINTENANCE'
      )
      and organizations.deleted_at is null
      and app_private.mfa_policy_satisfied(organizations.id)
  )
);

drop policy if exists tenant_record_scope on public.profiles;
drop policy if exists profile_directory_scope on public.profiles;
drop policy if exists profile_self_update on public.profiles;
create policy profiles_read on public.profiles
for select to authenticated using (
  app_private.mfa_policy_satisfied(organization_id)
  and (
    id = auth.uid()
    or (organization_id is not null and app_private.has_permission(organization_id, 'user.manage'))
    or (
      organization_id is not null
      and app_private.can_access_organization(organization_id)
      and exists (
        select 1
        from public.team_members self_member
        join public.team_members target_member on target_member.team_id = self_member.team_id
        where self_member.organization_id = profiles.organization_id
          and target_member.organization_id = profiles.organization_id
          and self_member.user_id = auth.uid()
          and target_member.user_id = profiles.id
          and self_member.active
          and target_member.active
      )
    )
  )
);
create policy profiles_update on public.profiles
for update to authenticated using (
  (id = auth.uid() and app_private.mfa_policy_satisfied(organization_id))
  or (organization_id is not null and app_private.has_permission(organization_id, 'user.manage'))
) with check (
  (id = auth.uid() and app_private.mfa_policy_satisfied(organization_id))
  or (organization_id is not null and app_private.has_permission(organization_id, 'user.manage'))
);

drop policy if exists tenant_record_scope on public.roles;
drop policy if exists assigned_role_catalog on public.roles;
drop policy if exists managed_role_mutations on public.roles;
create policy roles_read on public.roles
for select to authenticated using (
  (
    organization_id is null
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
  or (
    organization_id is not null
    and (
      app_private.has_permission(organization_id, 'role.manage')
      or exists (
        select 1 from public.user_role_assignments assignment_row
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = roles.organization_id
          and assignment_row.role_id = roles.id
          and assignment_row.active
          and app_private.can_access_organization(roles.organization_id)
      )
    )
  )
);
create policy roles_insert on public.roles
for insert to authenticated with check (
  organization_id is not null and app_private.has_permission(organization_id, 'role.manage')
);
create policy roles_update on public.roles
for update to authenticated using (
  organization_id is not null and app_private.has_permission(organization_id, 'role.manage')
) with check (
  organization_id is not null and app_private.has_permission(organization_id, 'role.manage')
);

drop policy if exists role_permission_catalog on public.role_permissions;
create policy role_permissions_read on public.role_permissions
for select to authenticated using (
  exists (
    select 1 from public.roles role_row
    where role_row.id = role_permissions.role_id
      and (
        (
          role_row.organization_id is null
          and app_private.is_platform_admin()
          and app_private.mfa_policy_satisfied(null)
        )
        or (
          role_row.organization_id is not null
          and (
            app_private.has_permission(role_row.organization_id, 'role.manage')
            or exists (
              select 1 from public.user_role_assignments assignment_row
              where assignment_row.user_id = auth.uid()
                and assignment_row.organization_id = role_row.organization_id
                and assignment_row.role_id = role_row.id
                and assignment_row.active
                and app_private.can_access_organization(role_row.organization_id)
            )
          )
        )
      )
  )
);
create policy role_permissions_insert on public.role_permissions
for insert to authenticated with check (
  exists (
    select 1 from public.roles role_row
    where role_row.id = role_permissions.role_id
      and role_row.organization_id is not null
      and app_private.has_permission(role_row.organization_id, 'role.manage')
  )
);

drop policy if exists tenant_record_scope on public.user_role_assignments;
drop policy if exists own_or_managed_role_assignments on public.user_role_assignments;
drop policy if exists managed_role_assignment_mutations on public.user_role_assignments;
create policy role_assignments_read on public.user_role_assignments
for select to authenticated using (
  (user_id = auth.uid() and app_private.mfa_policy_satisfied(organization_id))
  or (organization_id is not null and app_private.has_permission(organization_id, 'user.manage'))
  or (
    organization_id is null
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
);
create policy role_assignments_insert on public.user_role_assignments
for insert to authenticated with check (
  organization_id is not null and app_private.has_permission(organization_id, 'user.manage')
);
create policy role_assignments_update on public.user_role_assignments
for update to authenticated using (
  organization_id is not null and app_private.has_permission(organization_id, 'user.manage')
) with check (
  organization_id is not null and app_private.has_permission(organization_id, 'user.manage')
);

drop policy if exists tenant_record_scope on public.customers;
drop policy if exists customer_context_scope on public.customers;
create policy customers_read on public.customers
for select to authenticated using (
  deleted_at is null
  and app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_customer(organization_id, id)
);
create policy customers_insert on public.customers
for insert to authenticated with check (
  app_private.has_permission(organization_id, 'customer.create')
  and (created_by is null or created_by = auth.uid())
);

drop policy if exists tenant_record_scope on public.leads;
create policy leads_read on public.leads
for select to authenticated using (
  deleted_at is null
  and app_private.has_permission(organization_id, 'lead.view')
  and app_private.can_access_record(organization_id, branch_id, team_id, assigned_user_id)
);
-- Authenticated lead creation uses public.create_lead so team routing is validated
-- and audited. Provider ingestion remains service-role-only.
-- Authenticated lead updates use public.update_lead for optimistic concurrency,
-- immutable identity/assignment fields, histories and audit.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'lead_assignments', 'lead_assignment_history',
    'lead_stage_history', 'lead_temperature_history'
  ]
  loop
    execute format('drop policy if exists tenant_record_scope on public.%I', table_name);
    execute format(
      'create policy lead_history_read on public.%I for select to authenticated using (app_private.can_access_lead(lead_id))',
      table_name
    );
  end loop;
end $$;

-- Parent resources require their module permission as well as data scope. Child
-- resources inherit the exact parent authorization instead of falling back to
-- organization-only access or becoming invisible to a scoped owner.
drop policy if exists tenant_record_scope on public.calls;
create policy calls_read on public.calls
for select to authenticated using (
  app_private.can_access_call(organization_id, id)
);
drop policy if exists tenant_record_scope on public.call_recordings;
create policy call_recordings_read on public.call_recordings
for select to authenticated using (
  app_private.can_access_call(organization_id, call_id)
);
drop policy if exists tenant_record_scope on public.call_transcripts;
create policy call_transcripts_read on public.call_transcripts
for select to authenticated using (
  app_private.can_access_call(organization_id, call_id)
);
drop policy if exists tenant_record_scope on public.ai_call_summaries;
create policy ai_call_summaries_read on public.ai_call_summaries
for select to authenticated using (
  app_private.can_access_call(organization_id, call_id)
);

drop policy if exists tenant_record_scope on public.conversations;
create policy conversations_read on public.conversations
for select to authenticated using (
  app_private.can_access_conversation(organization_id, id)
);
drop policy if exists tenant_record_scope on public.conversation_messages;
create policy conversation_messages_read on public.conversation_messages
for select to authenticated using (
  app_private.can_access_conversation(organization_id, conversation_id)
);

drop policy if exists tenant_record_scope on public.test_drive_appointments;
create policy test_drive_appointments_read on public.test_drive_appointments
for select to authenticated using (
  app_private.has_permission(organization_id, 'test_drive.manage')
  and app_private.can_access_record(
    organization_id, branch_id, team_id, assigned_user_id
  )
);
drop policy if exists tenant_record_scope on public.test_drives;
create policy test_drives_read on public.test_drives
for select to authenticated using (
  app_private.can_access_test_drive(organization_id, id)
);
drop policy if exists tenant_record_scope on public.test_drive_route_summaries;
create policy test_drive_route_summaries_read on public.test_drive_route_summaries
for select to authenticated using (
  app_private.can_access_test_drive(organization_id, test_drive_id)
);
drop policy if exists tenant_record_scope on public.test_drive_route_points;
create policy test_drive_route_points_read on public.test_drive_route_points
for select to authenticated using (
  app_private.can_access_test_drive(organization_id, test_drive_id)
);
drop policy if exists tenant_record_scope on public.test_drive_feedback;
create policy test_drive_feedback_read on public.test_drive_feedback
for select to authenticated using (
  app_private.can_access_test_drive(organization_id, test_drive_id)
);
drop policy if exists tenant_record_scope on public.live_tracking_sessions;
create policy live_tracking_sessions_read on public.live_tracking_sessions
for select to authenticated using (
  app_private.can_access_test_drive(organization_id, test_drive_id)
);

drop policy if exists tenant_record_scope on public.quotations;
create policy quotations_read on public.quotations
for select to authenticated using (
  app_private.can_access_quotation(organization_id, id)
);
drop policy if exists tenant_record_scope on public.quotation_items;
create policy quotation_items_read on public.quotation_items
for select to authenticated using (
  app_private.can_access_quotation(organization_id, quotation_id)
);
drop policy if exists tenant_record_scope on public.quotation_versions;
create policy quotation_versions_read on public.quotation_versions
for select to authenticated using (
  app_private.can_access_quotation(organization_id, quotation_id)
);

drop policy if exists tenant_record_scope on public.bookings;
create policy bookings_read on public.bookings
for select to authenticated using (
  app_private.can_access_booking(organization_id, id)
);
drop policy if exists tenant_record_scope on public.booking_status_history;
create policy booking_status_history_read on public.booking_status_history
for select to authenticated using (
  app_private.can_access_booking(organization_id, booking_id)
);

drop policy if exists tenant_record_scope on public.followups;
create policy followups_read on public.followups
for select to authenticated using (
  app_private.has_permission(organization_id, 'lead.view')
  and app_private.can_access_record(
    organization_id, branch_id, team_id, assigned_user_id
  )
  and (lead_id is null or app_private.can_access_lead(lead_id))
);
drop policy if exists tenant_record_scope on public.appointments;
create policy appointments_read on public.appointments
for select to authenticated using (
  app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_record(
    organization_id, branch_id, team_id, assigned_user_id
  )
  and (lead_id is null or app_private.can_access_lead(lead_id))
);
drop policy if exists tenant_record_scope on public.reminders;
create policy reminders_read on public.reminders
for select to authenticated using (
  app_private.can_access_organization(organization_id)
  and (
    user_id = auth.uid()
    or app_private.has_permission(organization_id, 'user.manage')
  )
);

drop policy if exists tenant_record_scope on public.notifications;
create policy notifications_read on public.notifications
for select to authenticated using (
  user_id = auth.uid()
  and app_private.can_access_organization(organization_id)
);

create or replace function public.mark_notification_read(target_notification_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  notification_row public.notifications%rowtype;
begin
  select * into notification_row
  from public.notifications
  where id = target_notification_id
    and user_id = auth.uid()
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOTIFICATION_NOT_FOUND';
  end if;
  if not app_private.can_access_organization(notification_row.organization_id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if notification_row.read_at is null then
    update public.notifications
    set read_at = now()
    where id = notification_row.id
    returning read_at into notification_row.read_at;
  end if;
  return notification_row.read_at;
end;
$$;

revoke all on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;

drop policy if exists tenant_record_scope on public.credit_ledger;
create policy credit_ledger_read on public.credit_ledger
for select to authenticated using (
  app_private.can_access_organization(organization_id)
  and (
    app_private.has_permission(organization_id, 'credit.allocate')
    or (app_private.has_permission(organization_id, 'credit.consume') and user_id = auth.uid())
  )
);

drop policy if exists tenant_record_scope on public.connected_accounts;
create policy connected_accounts_read on public.connected_accounts
for select to authenticated using (
  app_private.can_access_connection(organization_id, id)
);
drop policy if exists tenant_record_scope on public.integration_field_mappings;
create policy integration_field_mappings_read on public.integration_field_mappings
for select to authenticated using (
  app_private.can_access_connection(organization_id, connected_account_id)
);
drop policy if exists tenant_record_scope on public.sync_runs;
create policy sync_runs_read on public.sync_runs
for select to authenticated using (
  app_private.can_access_connection(organization_id, connected_account_id)
);
-- Connection mutations carry credentials/provider state and therefore remain behind
-- authenticated Edge Functions using the service role after permission/scope checks.

drop policy if exists tenant_record_scope on public.audit_logs;
create policy audit_logs_read on public.audit_logs
for select to authenticated using (
  (
    organization_id is null
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
  or (
    organization_id is not null
    and app_private.has_permission(organization_id, 'audit.view')
    and (
      (branch_id is null and app_private.has_organization_wide_scope(organization_id))
      or (branch_id is not null and app_private.can_access_branch(organization_id, branch_id))
    )
  )
);

drop policy if exists tenant_record_scope on public.support_access_requests;
create policy support_requests_read on public.support_access_requests
for select to authenticated using (
  (
    app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
  or app_private.is_tenant_support_controller(organization_id)
);
drop policy if exists tenant_record_scope on public.support_sessions;
create policy support_sessions_read on public.support_sessions
for select to authenticated using (
  (
    app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
  or app_private.is_tenant_support_controller(organization_id)
);

drop policy if exists tenant_record_scope on public.branches;
create policy branches_read on public.branches
for select to authenticated using (
  deleted_at is null
  and app_private.can_access_branch(organization_id, id)
  and (
    not app_private.is_platform_admin()
    or app_private.support_session_allows_permission(organization_id, 'data.directory.view')
  )
);
drop policy if exists tenant_record_scope on public.teams;
create policy teams_read on public.teams
for select to authenticated using (
  app_private.can_access_team(organization_id, id)
  and (
    not app_private.is_platform_admin()
    or app_private.support_session_allows_permission(organization_id, 'data.directory.view')
  )
);
drop policy if exists tenant_record_scope on public.team_members;
create policy team_members_read on public.team_members
for select to authenticated using (
  app_private.can_access_team(organization_id, team_id)
  and (
    not app_private.is_platform_admin()
    or app_private.support_session_allows_permission(organization_id, 'data.directory.view')
  )
);
drop policy if exists tenant_record_scope on public.user_branch_access;
create policy user_branch_access_read on public.user_branch_access
for select to authenticated using (
  (
    user_id = auth.uid()
    and app_private.can_access_organization(organization_id)
  )
  or app_private.has_permission(organization_id, 'user.manage')
);

-- Remove the remaining permissive scope-only write policies. These resources are
-- readable in customer context, but their mutation boundary remains a controlled
-- RPC/Edge workflow until a dedicated operation permission exists.
drop policy if exists customer_contact_context_scope on public.customer_contacts;
create policy customer_contacts_read on public.customer_contacts
for select to authenticated using (
  app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_customer(organization_id, customer_id)
);
drop policy if exists customer_address_context_scope on public.customer_addresses;
create policy customer_addresses_read on public.customer_addresses
for select to authenticated using (
  app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_customer(organization_id, customer_id)
);
drop policy if exists customer_vehicle_context_scope on public.customer_vehicles;
create policy customer_vehicles_read on public.customer_vehicles
for select to authenticated using (
  app_private.has_permission(organization_id, 'customer.view')
  and app_private.can_access_customer(organization_id, customer_id)
);

drop policy if exists email_tenant_scope on public.email_messages;
create policy email_messages_read on public.email_messages
for select to authenticated using (
  app_private.has_permission(organization_id, 'email.send')
  and app_private.can_access_record(organization_id, null, null, requested_by)
);

-- Platform catalogs have command-specific policies and enforce AAL2. Deletion is
-- deliberately absent; retiring a plan is an UPDATE of its active flag.
drop policy if exists platform_plan_access on public.subscription_plans;
create policy subscription_plans_read on public.subscription_plans
for select to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
create policy subscription_plans_insert on public.subscription_plans
for insert to authenticated with check (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
create policy subscription_plans_update on public.subscription_plans
for update to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
) with check (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);

drop policy if exists platform_plan_module_access on public.plan_modules;
create policy plan_modules_read on public.plan_modules
for select to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
create policy plan_modules_insert on public.plan_modules
for insert to authenticated with check (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);
create policy plan_modules_update on public.plan_modules
for update to authenticated using (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
) with check (
  app_private.is_platform_admin() and app_private.mfa_policy_satisfied(null)
);

-- Remove every remaining generic tenant policy. Tables without a focused policy
-- above remain default-deny to authenticated clients until their module gets an
-- explicit permission/context policy or controlled RPC. This is intentional:
-- data scope alone must never imply permission to view a different module.
do $$
declare
  table_row record;
begin
  for table_row in
    select distinct column_row.table_name
    from information_schema.columns column_row
    join information_schema.tables relation_row
      on relation_row.table_schema = column_row.table_schema
     and relation_row.table_name = column_row.table_name
     and relation_row.table_type = 'BASE TABLE'
    where column_row.table_schema = 'public'
      and column_row.column_name = 'organization_id'
  loop
    execute format(
      'drop policy if exists tenant_record_scope on public.%I',
      table_row.table_name
    );
    execute format(
      'drop policy if exists tenant_record_read_scope on public.%I',
      table_row.table_name
    );
  end loop;
end $$;

-- Authenticated clients never hard-delete business or configuration records. Controlled
-- security-definer/service-role workflows are the only purge boundary.
do $$
declare
  table_row record;
begin
  for table_row in
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security', table_row.table_name);
    execute format('alter table public.%I force row level security', table_row.table_name);
    execute format('drop policy if exists block_authenticated_hard_delete on public.%I', table_row.table_name);
    execute format(
      'create policy block_authenticated_hard_delete on public.%I as restrictive for delete to authenticated using (false)',
      table_row.table_name
    );
  end loop;
end $$;

revoke delete on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke delete on tables from anon, authenticated;

revoke all on function app_private.requires_mfa(uuid) from public, anon, authenticated;
revoke all on function app_private.has_active_approved_support_session(uuid) from public, anon, authenticated;
revoke all on function app_private.support_session_allows_permission(uuid, text) from public, anon, authenticated;
revoke all on function app_private.actor_has_tenant_operation_context(uuid, uuid, text) from public, anon, authenticated;
revoke all on function app_private.is_tenant_support_controller(uuid) from public, anon, authenticated;
revoke all on function app_private.has_organization_wide_scope(uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_lead(uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_team(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_connection(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_call(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_conversation(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_test_drive(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_quotation(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.can_access_booking(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.validate_profile_update() from public, anon, authenticated;
revoke all on function app_private.validate_role_write() from public, anon, authenticated;
revoke all on function app_private.validate_role_permission_write() from public, anon, authenticated;
revoke all on function app_private.validate_delegation_ceiling() from public, anon, authenticated;
revoke all on function app_private.validate_lead_tenant_integrity() from public, anon, authenticated;
revoke all on function app_private.validate_connected_account_actor() from public, anon, authenticated;
revoke all on function app_private.validate_integration_credential_actor() from public, anon, authenticated;
revoke all on function app_private.validate_connected_account_write() from public, anon, authenticated;

-- PostgreSQL evaluates policy expressions as the querying role, so helpers named
-- directly by RLS need EXECUTE even though app_private is not an exposed API
-- schema. Internal support predicates and every trigger validator stay revoked.
grant execute on function app_private.support_session_allows_permission(uuid, text) to authenticated;
grant execute on function app_private.is_tenant_support_controller(uuid) to authenticated;
grant execute on function app_private.has_organization_wide_scope(uuid) to authenticated;
grant execute on function app_private.can_access_lead(uuid) to authenticated;
grant execute on function app_private.can_access_team(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_connection(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_call(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_conversation(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_test_drive(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_quotation(uuid, uuid) to authenticated;
grant execute on function app_private.can_access_booking(uuid, uuid) to authenticated;

commit;
