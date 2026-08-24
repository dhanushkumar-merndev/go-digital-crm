-- Keep the legacy Customer 360 RPC available for non-Sales-Consultant roles,
-- while enforcing the dedicated follow-up and appointment permissions added
-- after its original implementation.

begin;

-- Resolve record scope only from assignments whose own role grants the
-- requested permission. This is intentionally generic so legacy read surfaces
-- can intersect permissions without falling back to the unbound scope union in
-- can_access_record().
create or replace function app_private.resolve_permission_record_scope(
  target_organization_id uuid,
  target_permission_keys text[]
)
returns table (
  granted boolean,
  organization_wide boolean,
  branch_scope_ids uuid[],
  team_scope_ids uuid[],
  own_records boolean,
  own_record_branch_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with request_context as materialized (
    select
      auth.uid() as actor_id,
      target_organization_id is not null
        and coalesce(array_length(target_permission_keys, 1), 0) > 0
        and app_private.can_access_organization(target_organization_id)
          as organization_access,
      app_private.has_active_approved_support_session(target_organization_id)
        and exists (
          select 1
          from unnest(
            coalesce(target_permission_keys, array[]::text[])
          ) permission_key
          where app_private.support_session_allows_permission(
            target_organization_id,
            permission_key
          )
        ) as support_access
  ), permitted_assignments as materialized (
    select
      assignment_row.data_scope,
      assignment_row.scope_branch_id,
      assignment_row.selected_branch_ids
    from request_context context_row
    join public.user_role_assignments assignment_row
      on assignment_row.organization_id = target_organization_id
     and assignment_row.user_id = context_row.actor_id
     and assignment_row.active
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where context_row.organization_access
      and exists (
        select 1
        from public.role_permissions role_permission_row
        join public.permissions permission_row
          on permission_row.id = role_permission_row.permission_id
        where role_permission_row.role_id = assignment_row.role_id
          and permission_row.permission_key = any(
            coalesce(target_permission_keys, array[]::text[])
          )
      )
  ), active_branches as materialized (
    select branch_row.id
    from public.branches branch_row
    where branch_row.organization_id = target_organization_id
      and branch_row.active
      and branch_row.deleted_at is null
  ), branch_scope as (
    select distinct branch_row.id
    from active_branches branch_row
    cross join request_context context_row
    where context_row.support_access
      or exists (
        select 1
        from permitted_assignments assignment_row
        where assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
          or (
            assignment_row.data_scope = 'ONE_BRANCH'
            and assignment_row.scope_branch_id = branch_row.id
          )
          or (
            assignment_row.data_scope = 'SELECTED_BRANCHES'
            and branch_row.id = any(
              coalesce(assignment_row.selected_branch_ids, array[]::uuid[])
            )
          )
      )
  ), team_scope as (
    select distinct team_row.id
    from request_context context_row
    join public.team_members member_row
      on member_row.organization_id = target_organization_id
     and member_row.user_id = context_row.actor_id
     and member_row.active
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
    join active_branches branch_row on branch_row.id = team_row.branch_id
    where exists (
      select 1
      from permitted_assignments assignment_row
      where assignment_row.data_scope = 'OWN_TEAM'
    )
  ), own_record_branch_candidates as (
    select access_row.branch_id
    from request_context context_row
    join public.user_branch_access access_row
      on access_row.organization_id = target_organization_id
     and access_row.user_id = context_row.actor_id
     and access_row.active
    union
    select team_row.branch_id
    from request_context context_row
    join public.team_members member_row
      on member_row.organization_id = target_organization_id
     and member_row.user_id = context_row.actor_id
     and member_row.active
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
     and team_row.active
  ), own_record_branches as (
    select distinct branch_row.id
    from own_record_branch_candidates candidate_row
    join active_branches branch_row on branch_row.id = candidate_row.branch_id
    where exists (
      select 1
      from permitted_assignments assignment_row
      where assignment_row.data_scope = 'OWN_RECORDS'
    )
  )
  select
    context_row.organization_access
      and (
        context_row.support_access
        or exists (select 1 from permitted_assignments)
      ),
    context_row.support_access
      or exists (
        select 1
        from permitted_assignments assignment_row
        where assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
      ),
    coalesce(
      (select array_agg(branch_row.id order by branch_row.id) from branch_scope branch_row),
      array[]::uuid[]
    ),
    coalesce(
      (select array_agg(team_row.id order by team_row.id) from team_scope team_row),
      array[]::uuid[]
    ),
    exists (
      select 1
      from permitted_assignments assignment_row
      where assignment_row.data_scope = 'OWN_RECORDS'
    ),
    coalesce(
      (
        select array_agg(branch_row.id order by branch_row.id)
        from own_record_branches branch_row
      ),
      array[]::uuid[]
    )
  from request_context context_row;
$$;

revoke all on function app_private.resolve_permission_record_scope(uuid, text[])
  from public, anon, authenticated;

alter function public.get_customer_360(uuid) set schema app_private;
alter function app_private.get_customer_360(uuid) rename to get_customer_360_legacy_20260824;

revoke all on function app_private.get_customer_360_legacy_20260824(uuid)
  from public, anon, authenticated;

create function public.get_customer_360(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  target_organization_id uuid;
  customer_scope record;
  lead_scope record;
  followup_scope record;
  appointment_scope record;
  followup_access boolean := false;
  appointment_access boolean := false;
  filtered_followups jsonb := '[]'::jsonb;
  filtered_appointments jsonb := '[]'::jsonb;
begin
  select customer_row.organization_id
  into target_organization_id
  from public.customers customer_row
  where customer_row.id = target_customer_id
    and customer_row.deleted_at is null;

  if target_organization_id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  select * into customer_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['customer.view']::text[]
  );
  select * into lead_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['lead.view']::text[]
  );
  select * into followup_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['followup.view']::text[]
  );
  select * into appointment_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['appointment.view']::text[]
  );

  -- Customer visibility itself must come from a customer.view assignment whose
  -- own scope reaches one of this customer's active leads. Do not combine a
  -- narrow permission assignment with an unrelated broad assignment.
  if not coalesce(customer_scope.granted, false)
    or not (
      customer_scope.organization_wide
      or exists (
        select 1
        from public.leads customer_lead_row
        join public.branches customer_branch_row
          on customer_branch_row.id = customer_lead_row.branch_id
         and customer_branch_row.organization_id = customer_lead_row.organization_id
         and customer_branch_row.active
         and customer_branch_row.deleted_at is null
        where customer_lead_row.organization_id = target_organization_id
          and customer_lead_row.customer_id = target_customer_id
          and customer_lead_row.deleted_at is null
          and (
            customer_lead_row.branch_id = any(customer_scope.branch_scope_ids)
            or customer_lead_row.team_id = any(customer_scope.team_scope_ids)
            or (
              customer_scope.own_records
              and customer_lead_row.assigned_user_id = auth.uid()
              and customer_lead_row.branch_id = any(
                customer_scope.own_record_branch_ids
              )
            )
          )
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  -- The private legacy function keeps the original JSON contract and its
  -- existing defense-in-depth checks. The wrapper then intersects each newly
  -- permissioned section with the matching permission-bound record scope.
  result := app_private.get_customer_360_legacy_20260824(target_customer_id);

  followup_access := coalesce(followup_scope.granted, false);
  appointment_access := coalesce(appointment_scope.granted, false);

  if followup_access then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into filtered_followups
    from jsonb_array_elements(coalesce(result->'followups', '[]'::jsonb))
      with ordinality item(value, ordinality)
    join public.followups followup_row
      on followup_row.organization_id = target_organization_id
     and followup_row.id = (item.value->>'id')::uuid
    left join public.leads lead_row
      on lead_row.organization_id = followup_row.organization_id
     and lead_row.id = followup_row.lead_id
     and lead_row.deleted_at is null
    where (
      followup_scope.organization_wide
      or followup_row.branch_id = any(followup_scope.branch_scope_ids)
      or followup_row.team_id = any(followup_scope.team_scope_ids)
      or (
        followup_scope.own_records
        and followup_row.assigned_user_id = auth.uid()
        and followup_row.branch_id = any(followup_scope.own_record_branch_ids)
      )
    )
      and (
        followup_row.lead_id is null
        or (
          lead_scope.granted
          and lead_row.id is not null
          and (
            lead_scope.organization_wide
            or lead_row.branch_id = any(lead_scope.branch_scope_ids)
            or lead_row.team_id = any(lead_scope.team_scope_ids)
            or (
              lead_scope.own_records
              and lead_row.assigned_user_id = auth.uid()
              and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
            )
          )
        )
      );
    result := jsonb_set(result, '{followups}', filtered_followups, true);
  end if;

  if appointment_access then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into filtered_appointments
    from jsonb_array_elements(coalesce(result->'appointments', '[]'::jsonb))
      with ordinality item(value, ordinality)
    join public.appointments appointment_row
      on appointment_row.organization_id = target_organization_id
     and appointment_row.id = (item.value->>'id')::uuid
    left join public.leads lead_row
      on lead_row.organization_id = appointment_row.organization_id
     and lead_row.id = appointment_row.lead_id
     and lead_row.deleted_at is null
    where (
      appointment_scope.organization_wide
      or appointment_row.branch_id = any(appointment_scope.branch_scope_ids)
      or appointment_row.team_id = any(appointment_scope.team_scope_ids)
      or (
        appointment_scope.own_records
        and appointment_row.assigned_user_id = auth.uid()
        and appointment_row.branch_id = any(appointment_scope.own_record_branch_ids)
      )
    )
      and (
        appointment_row.lead_id is null
        or (
          lead_scope.granted
          and lead_row.id is not null
          and (
            lead_scope.organization_wide
            or lead_row.branch_id = any(lead_scope.branch_scope_ids)
            or lead_row.team_id = any(lead_scope.team_scope_ids)
            or (
              lead_scope.own_records
              and lead_row.assigned_user_id = auth.uid()
              and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
            )
          )
        )
      );
    result := jsonb_set(result, '{appointments}', filtered_appointments, true);
  end if;

  result := jsonb_set(
    result,
    '{section_access,followups}',
    to_jsonb(followup_access),
    true
  );
  result := jsonb_set(
    result,
    '{section_access,appointments}',
    to_jsonb(appointment_access),
    true
  );

  if not followup_access then
    result := jsonb_set(result, '{followups}', '[]'::jsonb, true);
  end if;
  if not appointment_access then
    result := jsonb_set(result, '{appointments}', '[]'::jsonb, true);
  end if;

  return result;
end;
$$;

revoke all on function public.get_customer_360(uuid) from public, anon;
grant execute on function public.get_customer_360(uuid) to authenticated;

commit;
