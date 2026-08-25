begin;

-- A qualified Telecaller lead is handed to Sales by a Team Manager.  The
-- resulting Transferred to Sales status is system-owned: it is never a
-- selectable Sales Consultant lifecycle transition.
create or replace function app_private.enforce_sales_lead_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_is_sales_consultant boolean;
  actor_is_sales_consultant boolean;
  current_lifecycle public.lead_lifecycle;
  has_prior_sales_handoff boolean;
begin
  if not new.active then
    return new;
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into actor_is_sales_consultant;

  if actor_is_sales_consultant then
    raise exception using errcode = '42501', message = 'SALES_CONSULTANT_CANNOT_ASSIGN_LEADS';
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = new.assigned_user_id
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into target_is_sales_consultant;

  if not target_is_sales_consultant then
    return new;
  end if;

  select lead_row.lifecycle_status into current_lifecycle
  from public.leads lead_row
  where lead_row.id = new.lead_id
    and lead_row.organization_id = new.organization_id
    and lead_row.deleted_at is null;

  if current_lifecycle is null then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  select exists (
    select 1
    from public.lead_stage_history history_row
    where history_row.organization_id = new.organization_id
      and history_row.lead_id = new.lead_id
      and history_row.to_status = 'Transferred to Sales'
  ) into has_prior_sales_handoff;

  if new.assignment_type <> 'QUALIFIED'
    or (
      current_lifecycle <> 'Qualified'
      and not has_prior_sales_handoff
    )
  then
    raise exception using errcode = '23514', message = 'SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD';
  end if;

  return new;
end;
$$;

drop trigger if exists lead_assignments_sales_handoff_guard on public.lead_assignments;
create trigger lead_assignments_sales_handoff_guard
before insert on public.lead_assignments
for each row execute function app_private.enforce_sales_lead_assignment();

create or replace function app_private.record_sales_lead_handoff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_is_sales_consultant boolean;
  lead_row public.leads%rowtype;
  handoff_at timestamptz := clock_timestamp();
begin
  if not new.active then
    return new;
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = new.assigned_user_id
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into target_is_sales_consultant;

  if not target_is_sales_consultant then
    return new;
  end if;

  select * into lead_row
  from public.leads
  where id = new.lead_id
    and organization_id = new.organization_id
    and deleted_at is null
  for update;

  if lead_row.lifecycle_status <> 'Qualified' then
    return new;
  end if;

  update public.leads
  set lifecycle_status = 'Transferred to Sales',
      first_contacted_at = coalesce(first_contacted_at, handoff_at),
      updated_at = greatest(handoff_at, updated_at + interval '1 microsecond')
  where id = lead_row.id;

  insert into public.lead_stage_history (
    organization_id, lead_id, from_status, to_status, changed_by, reason
  ) values (
    lead_row.organization_id,
    lead_row.id,
    'Qualified',
    'Transferred to Sales',
    auth.uid(),
    'Automatic qualified-lead handoff to Sales Consultant'
  );

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    lead_row.organization_id,
    auth.uid(),
    'lead.transferred_to_sales',
    'lead',
    lead_row.id::text,
    lead_row.branch_id,
    jsonb_build_object(
      'sales_consultant_id', new.assigned_user_id,
      'assignment_id', new.id,
      'assignment_type', new.assignment_type
    )
  );

  return new;
end;
$$;

drop trigger if exists lead_assignments_record_sales_handoff on public.lead_assignments;
create trigger lead_assignments_record_sales_handoff
after insert on public.lead_assignments
for each row execute function app_private.record_sales_lead_handoff();

-- Role actions are bounded at the database boundary as well as in the UI.
-- Managers retain their permitted operational controls; a Telecaller cannot
-- manually transfer a lead and a Sales Consultant cannot re-open its intake.
create or replace function app_private.enforce_role_lead_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_is_sales_consultant boolean;
  actor_is_telecaller boolean;
begin
  if new.lifecycle_status is not distinct from old.lifecycle_status then
    return new;
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into actor_is_sales_consultant;
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) into actor_is_telecaller;

  if actor_is_sales_consultant
    and new.lifecycle_status not in ('Appointment Scheduled', 'Lost') then
    raise exception using errcode = '42501', message = 'SALES_CONSULTANT_LIFECYCLE_FORBIDDEN';
  end if;
  if actor_is_telecaller
    and new.lifecycle_status not in ('New', 'Contacted', 'Qualified', 'Lost') then
    raise exception using errcode = '42501', message = 'TELECALLER_LIFECYCLE_FORBIDDEN';
  end if;

  return new;
end;
$$;

drop trigger if exists leads_role_lifecycle_guard on public.leads;
create trigger leads_role_lifecycle_guard
before update of lifecycle_status on public.leads
for each row execute function app_private.enforce_role_lead_lifecycle();

-- The sales list is also filtered at query level, so Sales Consultants never
-- receive an old/direct assignment that lacks a qualified handoff event.
do $migration$
declare
  existing_definition text;
  patched_definition text;
  target_signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date)'::regprocedure;
begin
  select pg_get_functiondef(target_signature) into existing_definition;
  patched_definition := replace(
    existing_definition,
    E'        and lead_row.deleted_at is null\n        and (\n          target_organization_wide',
    E'        and lead_row.deleted_at is null\n        and (\n          not exists (\n            select 1\n            from public.user_role_assignments viewer_assignment\n            join public.roles viewer_role on viewer_role.id = viewer_assignment.role_id\n            where viewer_assignment.organization_id = target_organization_id\n              and viewer_assignment.user_id = target_actor_id\n              and viewer_assignment.active\n              and viewer_role.role_key = \'sales_consultant\'\n          )\n          or exists (\n            select 1\n            from public.lead_stage_history handoff_history\n            where handoff_history.organization_id = target_organization_id\n              and handoff_history.lead_id = lead_row.id\n              and handoff_history.to_status = \'Transferred to Sales\'\n          )\n        )\n        and (\n          target_organization_wide'
  );

  if patched_definition = existing_definition then
    raise exception using errcode = 'P0001', message = 'SALES_LEAD_WORKSPACE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.get_sales_role_lead_workspace_page(
  uuid, uuid, boolean, uuid[], uuid[], boolean, uuid[], integer, integer,
  text, text, text, text, text, text, text, date, date
) from public, anon, authenticated;

commit;
