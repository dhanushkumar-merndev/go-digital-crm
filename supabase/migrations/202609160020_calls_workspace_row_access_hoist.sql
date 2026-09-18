begin;

-- 202609090004 hoisted the call-row can_access_record() to one evaluation per
-- (branch, team, owner), but Calls still took ~46s for a Telecaller against
-- 123 calls. The remaining per-row cost is the lateral that decides whether a
-- call may show its lead and customer: can_access_lead() and
-- can_access_customer() each re-enter the whole scope chain
-- (can_access_organization -> mfa_policy_satisfied -> session timebox ->
-- requires_mfa, plus support-session checks), measured at ~130ms and ~60ms per
-- call on the linked project. Every call in the demo tenant has its own lead
-- and customer, so memoising by id does not help.
--
-- Lead: can_access_lead(id) is has_permission(org, 'lead.view') -- already held
-- in lead_access -- and can_access_record() over the lead's
-- (branch, team, owner). The lead row is already joined in the same
-- organization with deleted_at is null, so the record check is evaluated once
-- per distinct lead triple instead of once per call.
--
-- Customer: when that record check passes for the call's lead and the lead
-- belongs to the displayed customer, can_access_customer() is necessarily true:
-- both require can_access_organization() and the same support-session or
-- role-assignment branch, and every scope arm of can_access_record()
-- (ORGANIZATION/ALL_BRANCHES, ONE_BRANCH, SELECTED_BRANCHES, OWN_TEAM,
-- OWN_RECORDS) is at least as strict as the matching arm of
-- can_access_customer() over that same non-deleted lead. Only calls without
-- such a lead fall through to the original function, so visibility is
-- unchanged and CASE keeps the expensive call from being evaluated early.
--
-- The wrapper's talk-time KPI has the same per-row can_access_record() over
-- today's calls, which is zero rows on a quiet day and hundreds on a busy one;
-- it gets the same per-triple treatment.
do $migration$
declare
  legacy_signature regprocedure :=
    'public.get_call_workspace_page_legacy(text,integer,integer,text,text,text,text)'::regprocedure;
  wrapper_signature regprocedure :=
    'public.get_call_workspace_page(text,integer,integer,text,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
  old_cte constant text := '  ), scoped_calls as materialized (
';
  new_cte constant text := '  ), lead_scopes as materialized (
    select distinct
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    from public.calls call_row
    join public.leads lead_row
      on lead_row.organization_id = call_row.organization_id
     and lead_row.id = call_row.lead_id
     and lead_row.deleted_at is null
    where call_row.organization_id = current_organization_id
  ), visible_lead_scopes as materialized (
    select
      scope_row.branch_id,
      scope_row.team_id,
      scope_row.assigned_user_id
    from lead_scopes scope_row
    where app_private.can_access_record(
      current_organization_id,
      scope_row.branch_id,
      scope_row.team_id,
      scope_row.assigned_user_id
    )
  ), scoped_calls as materialized (
';
  old_lateral constant text := '    left join lateral (
      select
        lead_access
          and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) as lead_ok,
        customer_access
          and customer_row.id is not null
          and app_private.can_access_customer(
            call_row.organization_id,
            customer_row.id
          ) as customer_ok
    ) access_row on true
';
  new_lateral constant text := '    left join lateral (
      select
        lead_row.id is not null
          and exists (
            select 1
            from visible_lead_scopes scope_row
            where scope_row.branch_id is not distinct from lead_row.branch_id
              and scope_row.team_id is not distinct from lead_row.team_id
              and scope_row.assigned_user_id is not distinct from lead_row.assigned_user_id
          ) as lead_scope_ok
    ) lead_scope_row on true
    left join lateral (
      select
        lead_access
          and lead_scope_row.lead_scope_ok as lead_ok,
        case
          when not customer_access or customer_row.id is null then false
          when lead_scope_row.lead_scope_ok
            and lead_row.customer_id = customer_row.id then true
          else app_private.can_access_customer(
            call_row.organization_id,
            customer_row.id
          )
        end as customer_ok
    ) access_row on true
';
  old_talk_time constant text := '  select coalesce(sum(call_row.duration_seconds), 0)::bigint
  into legacy_talk_time_seconds
  from public.calls call_row
  where call_row.organization_id = current_organization_id
    and call_row.started_at >= date_trunc(''day'', now())
    and app_private.can_access_record(
      call_row.organization_id,
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id
    );
';
  new_talk_time constant text := '  with today_scopes as materialized (
    select distinct
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id
    from public.calls call_row
    where call_row.organization_id = current_organization_id
      and call_row.started_at >= date_trunc(''day'', now())
  ), visible_today_scopes as materialized (
    select
      scope_row.branch_id,
      scope_row.team_id,
      scope_row.assigned_user_id
    from today_scopes scope_row
    where app_private.can_access_record(
      current_organization_id,
      scope_row.branch_id,
      scope_row.team_id,
      scope_row.assigned_user_id
    )
  )
  select coalesce(sum(call_row.duration_seconds), 0)::bigint
  into legacy_talk_time_seconds
  from public.calls call_row
  where call_row.organization_id = current_organization_id
    and call_row.started_at >= date_trunc(''day'', now())
    and exists (
      select 1
      from visible_today_scopes scope_row
      where scope_row.branch_id is not distinct from call_row.branch_id
        and scope_row.team_id is not distinct from call_row.team_id
        and scope_row.assigned_user_id is not distinct from call_row.assigned_user_id
    );
';
begin
  select pg_catalog.pg_get_functiondef(legacy_signature) into definition;
  if position('visible_lead_scopes' in definition) > 0 then
    raise exception using errcode = 'P0001', message = 'CALLS_ROW_ACCESS_HOIST_ALREADY_APPLIED';
  end if;
  if position(old_cte in definition) = 0 or position(old_lateral in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'CALLS_ROW_ACCESS_HOIST_TARGET_NOT_FOUND';
  end if;
  updated_definition := replace(replace(definition, old_cte, new_cte), old_lateral, new_lateral);
  if position(new_cte in updated_definition) = 0
    or position(new_lateral in updated_definition) = 0
    or position('app_private.can_access_lead(' in updated_definition) > 0
  then
    raise exception using errcode = 'P0001', message = 'CALLS_ROW_ACCESS_HOIST_PATCH_FAILED';
  end if;
  execute updated_definition;

  select pg_catalog.pg_get_functiondef(wrapper_signature) into definition;
  if position('visible_today_scopes' in definition) > 0 then
    raise exception using errcode = 'P0001', message = 'CALLS_TALK_TIME_HOIST_ALREADY_APPLIED';
  end if;
  if position(old_talk_time in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'CALLS_TALK_TIME_HOIST_TARGET_NOT_FOUND';
  end if;
  updated_definition := replace(definition, old_talk_time, new_talk_time);
  if position(new_talk_time in updated_definition) = 0 then
    raise exception using errcode = 'P0001', message = 'CALLS_TALK_TIME_HOIST_PATCH_FAILED';
  end if;
  execute updated_definition;
end;
$migration$;

commit;
