begin;

-- Intake distribution and the Telecaller -> Sales handoff, end to end.
--
-- 1. A provider lead (Meta and every other connected source) lands on the
--    mapped branch/team and is round-robined across that team's *Telecallers*.
-- 2. Pressing Call or WhatsApp on an intake lead records first contact and
--    moves New -> Contacted.
-- 3. An interested lead is qualified and handed to a Sales Consultant, either
--    a manually picked one or the one auto-selected by lightest open book.

-- ---------------------------------------------------------------------------
-- 1. Round robin selects a Telecaller, never any eligible team member.
--
-- `enforce_sales_lead_assignment` already rejects a FRESH assignment whose
-- target is not a Telecaller, so a team whose round robin landed on a Sales
-- Consultant failed ingestion outright instead of queueing the lead.
-- ---------------------------------------------------------------------------
do $migration$
declare
  signature regprocedure :=
    'public.ingest_provider_lead(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  updated_definition := replace(
    definition,
    E'        and tm.eligible_for_fresh_leads\n        and p.active\n        and p.deleted_at is null\n      order by tm.last_fresh_assigned_at asc nulls first',
    E'        and tm.eligible_for_fresh_leads\n        and p.active\n        and p.deleted_at is null\n        and exists (\n          select 1\n          from public.user_role_assignments intake_assignment\n          join public.roles intake_role\n            on intake_role.id = intake_assignment.role_id\n           and intake_role.organization_id = intake_assignment.organization_id\n          where intake_assignment.organization_id = target_organization_id\n            and intake_assignment.user_id = tm.user_id\n            and intake_assignment.active\n            and intake_role.role_key = ''telecaller_bdc''\n        )\n      order by tm.last_fresh_assigned_at asc nulls first'
  );

  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'PROVIDER_INTAKE_ROUND_ROBIN_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 2. The handoff transition a Telecaller triggers is system-owned.
--
-- `record_sales_lead_handoff` writes Qualified -> Transferred to Sales on the
-- lead as the acting user. With the Telecaller allow-list unchanged, a
-- Telecaller handing a lead to Sales tripped TELECALLER_LIFECYCLE_FORBIDDEN on
-- the status the trigger itself had just written.
-- ---------------------------------------------------------------------------
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
  -- Transferred to Sales stays unselectable for a Telecaller: it is reachable
  -- only as the automatic consequence of handing a Qualified lead to Sales.
  if actor_is_telecaller
    and new.lifecycle_status not in ('New', 'Contacted', 'Qualified', 'Lost')
    and not (
      new.lifecycle_status = 'Transferred to Sales'
      and old.lifecycle_status = 'Qualified'
    ) then
    raise exception using errcode = '42501', message = 'TELECALLER_LIFECYCLE_FORBIDDEN';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Call/WhatsApp on an intake lead is first contact.
--
-- Unlike the Sales Consultant equivalent, this is a real lifecycle move: the
-- Telecaller owns New -> Contacted, and Pending is derived from
-- `first_contacted_at`, so both have to be written for the queues to agree.
-- ---------------------------------------------------------------------------
create index if not exists activities_telecaller_contacted_lead_idx
  on public.activities (organization_id, lead_id, occurred_at desc)
  where activity_type = 'TELECALLER_CONTACTED';

create or replace function public.record_telecaller_lead_contact(
  target_lead_id uuid,
  contact_channel text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  normalized_channel text := upper(btrim(coalesce(contact_channel, '')));
  contacted_at timestamptz := clock_timestamp();
  next_lifecycle public.lead_lifecycle;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if normalized_channel not in ('CALL', 'WHATSAPP') then
    raise exception using errcode = '22023', message = 'INVALID_CONTACT_CHANNEL';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_organization_id, 'lead.update')
    or not app_private.can_access_record(
      current_organization_id, target_lead.branch_id, target_lead.team_id, target_lead.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) then
    raise exception using errcode = '42501', message = 'TELECALLER_REQUIRED';
  end if;
  -- A closed lead, or one already working inside Sales, is not intake anymore.
  if target_lead.lifecycle_status in ('Lost', 'Transferred to Sales') then
    raise exception using errcode = '23514', message = 'LEAD_NOT_IN_INTAKE';
  end if;

  next_lifecycle := case
    when target_lead.lifecycle_status = 'New' then 'Contacted'::public.lead_lifecycle
    else target_lead.lifecycle_status
  end;

  update public.leads
  set lifecycle_status = next_lifecycle,
      first_contacted_at = coalesce(first_contacted_at, contacted_at),
      updated_at = greatest(contacted_at, updated_at + interval '1 microsecond')
  where id = target_lead.id;

  if next_lifecycle <> target_lead.lifecycle_status then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_organization_id,
      target_lead.id,
      target_lead.lifecycle_status,
      next_lifecycle,
      auth.uid(),
      'Telecaller ' || initcap(lower(normalized_channel)) || ' contact'
    );
  end if;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
  ) values (
    current_organization_id,
    target_lead.customer_id,
    target_lead.id,
    'TELECALLER_CONTACTED',
    auth.uid(),
    jsonb_build_object('channel', normalized_channel, 'source', 'lead_workspace_action'),
    contacted_at
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id,
    auth.uid(),
    'lead.telecaller_contacted',
    'lead',
    target_lead.id::text,
    target_lead.branch_id,
    jsonb_build_object(
      'channel', normalized_channel,
      'contacted_at', contacted_at,
      'lifecycle_status', next_lifecycle
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'contacted_at', contacted_at,
    'lifecycle_status', next_lifecycle
  );
end;
$$;

revoke all on function public.record_telecaller_lead_contact(uuid, text) from public, anon;
grant execute on function public.record_telecaller_lead_contact(uuid, text) to authenticated;

commit;
