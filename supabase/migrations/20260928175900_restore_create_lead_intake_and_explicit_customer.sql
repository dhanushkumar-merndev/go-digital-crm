begin;

-- Regression repair, the second time for the same function.
--
-- Between 09:45 and 09:48 UTC on 2026-09-28 public.create_lead was replaced
-- outside any migration with a body that (a) matched the new lead to the first
-- customer sharing its phone digits, or silently created a Customer 360, and
-- (b) treated every OWN_RECORDS user as a Sales Consultant again. So every
-- Telecaller-typed lead was written straight to 'Transferred to Sales' with a
-- fabricated handoff, and every lead was auto-linked to a customer -- exactly
-- what 202609020013 and 202609020018 had fixed, and against AGENTS.md
-- section 0.11 (never merge customers from a phone match).
--
-- The function is rebuilt from its documented lineage rather than from the
-- unknown live text: the 202609020007 body, then 202609020013 (explicit
-- customer resolution), 202609020018 (Telecaller intake) and 20260928160000
-- (fresh round robin picks Telecallers only), each applied verbatim. No other
-- migration has changed create_lead since 202609020007.
--
-- Then the rows written while it was live are repaired the way 202609020019
-- and 202609020020 repaired the first occurrence.

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
  self_assigned boolean := false;
  resolved_team_id uuid := target_team_id;
  resolved_branch_id uuid := target_branch_id;
  contacted_at timestamptz;
  resolved_customer_id uuid;
  lead_phone_digits text;
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

  -- A front-line consultant enters a lead by hand because the enquiry is
  -- theirs. Leaving it unassigned would also make it invisible to them: an
  -- OWN_RECORDS role only sees leads where assigned_user_id is itself. Anyone
  -- holding a wider scope still creates into the queue, because a manager
  -- assigns deliberately rather than by authoring the record.
  if selected_user_id is null and exists (
    select 1
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.data_scope = 'OWN_RECORDS'
  ) and not exists (
    select 1
    from public.user_role_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and assignment_row.data_scope <> 'OWN_RECORDS'
  ) then
    selected_user_id := auth.uid();
    self_assigned := true;
  end if;

  -- The membership is the source of truth for a self-assigned lead: it names
  -- the team, and the team names the branch.
  if self_assigned and resolved_team_id is null then
    resolved_team_id := app_private.resolve_self_assigned_lead_team(
      target_organization_id, target_branch_id, auth.uid()
    );
    if resolved_team_id is null then
      raise exception using errcode = '23514', message = 'SALES_CONSULTANT_TEAM_REQUIRED';
    end if;

    select team_row.branch_id into resolved_branch_id
    from public.teams team_row
    where team_row.id = resolved_team_id
      and team_row.organization_id = target_organization_id;

    -- Deriving the destination is not a reason to skip the scope check.
    if not app_private.can_access_branch(target_organization_id, resolved_branch_id) then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED';
    end if;
  end if;

  -- A lead carried the customer's name and number but never a customer_id, so
  -- nothing created through Add Lead had a Customer 360 to open: every gate that
  -- asks "which customer is this person" joins through leads.customer_id. The
  -- match is on the phone digits, the same key the lead grouping uses, so one
  -- phone group resolves to one customer rather than a new row per enquiry.
  -- Held in its own local: inside the lookup below, a bare `normalized_phone`
  -- is ambiguous between this function's variable and customers.normalized_phone,
  -- which plpgsql rejects at runtime rather than at creation.
  lead_phone_digits := app_private.normalize_phone_digits(normalized_phone);

  if lead_phone_digits <> '' then
    select customer_row.id
    into resolved_customer_id
    from public.customers customer_row
    where customer_row.organization_id = target_organization_id
      and customer_row.deleted_at is null
      and app_private.normalize_phone_digits(customer_row.normalized_phone)
        = lead_phone_digits
    order by customer_row.created_at, customer_row.id
    limit 1;
  end if;

  if resolved_customer_id is null then
    insert into public.customers (
      organization_id, full_name, primary_phone, normalized_phone, primary_email, created_by
    ) values (
      target_organization_id,
      btrim(lead_customer_name),
      btrim(lead_phone),
      normalized_phone,
      nullif(lower(btrim(lead_email)), ''),
      auth.uid()
    ) returning id into resolved_customer_id;
  end if;

  perform set_config('app.create_lead_rpc', 'on', true);
  insert into public.leads (
    organization_id,
    customer_id,
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
    assigned_user_id,
    lifecycle_status,
    first_contacted_at
  ) values (
    target_organization_id,
    resolved_customer_id,
    resolved_branch_id,
    resolved_team_id,
    lead_source,
    nullif(btrim(lead_source_detail), ''),
    nullif(btrim(lead_campaign), ''),
    btrim(lead_customer_name),
    btrim(lead_phone),
    normalized_phone,
    nullif(lower(btrim(lead_email)), ''),
    nullif(btrim(lead_interested_model), ''),
    selected_user_id,
    case when self_assigned then 'Transferred to Sales' else 'New' end::public.lead_lifecycle,
    case when self_assigned then clock_timestamp() else null end
  ) returning id, first_contacted_at into new_lead_id, contacted_at;

  if selected_user_id is not null then
    insert into public.lead_assignments (
      organization_id, lead_id, branch_id, team_id, assigned_user_id,
      assignment_type, method, assigned_by, reason
    ) values (
      target_organization_id, new_lead_id, resolved_branch_id, resolved_team_id,
      selected_user_id, 'FRESH',
      case when self_assigned then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end::public.assignment_mode,
      auth.uid(),
      case
        when self_assigned then 'Manually created by the owning consultant'
        else 'Automatic fresh lead assignment'
      end
    ) returning id into assignment_id;
    insert into public.lead_assignment_history (
      organization_id, lead_id, branch_id, team_id, previous_owner_id,
      new_owner_id, assigned_by, method, reason
    ) values (
      target_organization_id, new_lead_id, resolved_branch_id, resolved_team_id,
      null, selected_user_id, auth.uid(),
      case when self_assigned then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end::public.assignment_mode,
      case
        when self_assigned then 'Manually created by the owning consultant'
        else 'Automatic fresh lead assignment'
      end
    );
  end if;

  if self_assigned then
    -- The handoff the consultant lead queues key off. Written with the lead's
    -- own first_contacted_at so the SALES_CONTACTED activity below cannot land
    -- before it and leave the lead stuck behind `contacted >= handoff`.
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason, created_at
    ) values (
      target_organization_id,
      new_lead_id,
      'New',
      'Transferred to Sales',
      auth.uid(),
      'Created by the owning sales consultant',
      contacted_at
    );
    insert into public.activities (
      organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
    ) values (
      target_organization_id,
      null,
      new_lead_id,
      'SALES_CONTACTED',
      auth.uid(),
      jsonb_build_object('channel', 'MANUAL', 'source', 'lead_created_by_consultant'),
      contacted_at
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
    resolved_branch_id,
    jsonb_build_object(
      'source', lead_source,
      'team_id', resolved_team_id,
      'requested_branch_id', target_branch_id,
      'team_resolved_from_membership', self_assigned and target_team_id is null,
      'assigned_user_id', selected_user_id,
      'assignment_id', assignment_id,
      'contacted_on_create', self_assigned,
      'assignment_mode', case
        when self_assigned then 'SELF_ON_CREATE'
        else coalesce(team_mode::text, 'UNASSIGNED')
      end
    )
  );
  return new_lead_id;
end;
$$;

do $migration$
declare
  signature regprocedure :=
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  -- Safe when an earlier deployment already restored the explicit workflow.
  if position('resolved_customer_id' in definition) = 0
    and position('lead_phone_digits' in definition) = 0
    and position('Customer identity is resolved explicitly after creation' in definition) > 0
  then
    return;
  end if;

  updated_definition := replace(
    updated_definition,
    E'  resolved_customer_id uuid;\n  lead_phone_digits text;\n',
    ''
  );

  updated_definition := regexp_replace(
    updated_definition,
    E'  -- A lead carried the customer''s name and number but never a customer_id,[\\s\\S]*?  perform set_config\\(''app\\.create_lead_rpc'', ''on'', true\\);',
    E'  -- Customer identity is resolved explicitly after creation. A matching\n'
      || E'  -- phone/email only produces candidates for resolve_lead_customer.\n'
      || E'  perform set_config(''app.create_lead_rpc'', ''on'', true);'
  );

  updated_definition := replace(
    updated_definition,
    E'    organization_id,\n    customer_id,\n    branch_id,\n',
    E'    organization_id,\n    branch_id,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'    target_organization_id,\n    resolved_customer_id,\n    resolved_branch_id,\n',
    E'    target_organization_id,\n    resolved_branch_id,\n'
  );

  if updated_definition = definition
    or position('resolved_customer_id' in updated_definition) > 0
    or position('lead_phone_digits' in updated_definition) > 0
    or position(E'organization_id,\n    customer_id,\n    branch_id' in updated_definition) > 0
    or position('Customer identity is resolved explicitly after creation' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'EXPLICIT_CUSTOMER_RESOLUTION_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

do $migration$
declare
  signature regprocedure :=
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'  self_assigned boolean := false;\n  resolved_team_id uuid := target_team_id;\n',
    E'  self_assigned boolean := false;\n  actor_is_sales_consultant boolean := false;\n  resolved_team_id uuid := target_team_id;\n'
  );

  updated_definition := replace(
    updated_definition,
    E'  if lead_source is null or lead_source not in (\n',
    E'  select exists (\n    select 1\n    from public.user_role_assignments assignment_row\n    join public.roles role_row\n      on role_row.id = assignment_row.role_id\n     and role_row.organization_id = assignment_row.organization_id\n    where assignment_row.organization_id = target_organization_id\n      and assignment_row.user_id = auth.uid()\n      and assignment_row.active\n      and role_row.role_key = ''sales_consultant''\n  ) into actor_is_sales_consultant;\n\n  if lead_source is null or lead_source not in (\n'
  );

  -- The stage and the contacted stamp are the visible half of the bug.
  updated_definition := replace(
    updated_definition,
    E'    case when self_assigned then ''Transferred to Sales'' else ''New'' end::public.lead_lifecycle,\n    case when self_assigned then clock_timestamp() else null end\n',
    E'    case when self_assigned and actor_is_sales_consultant then ''Transferred to Sales'' else ''New'' end::public.lead_lifecycle,\n    case when self_assigned and actor_is_sales_consultant then clock_timestamp() else null end\n'
  );

  -- The fabricated handoff history is the half that would have kept the lead
  -- looking handed-off to every downstream consumer.
  updated_definition := replace(
    updated_definition,
    E'  if self_assigned then\n    -- The handoff the consultant lead queues key off.',
    E'  if self_assigned and actor_is_sales_consultant then\n    -- The handoff the consultant lead queues key off.'
  );

  updated_definition := replace(
    updated_definition,
    E'''contacted_on_create'', self_assigned,\n',
    E'''contacted_on_create'', self_assigned and actor_is_sales_consultant,\n'
  );

  if updated_definition = definition
    or position('actor_is_sales_consultant boolean := false' in updated_definition) = 0
    or position('self_assigned and actor_is_sales_consultant then ''Transferred to Sales''' in updated_definition) = 0
    or position('if self_assigned and actor_is_sales_consultant then' in updated_definition) = 0
    or position(E'''contacted_on_create'', self_assigned and actor_is_sales_consultant' in updated_definition) = 0
    -- Self-assignment itself must survive: a Telecaller only sees leads where
    -- assigned_user_id is itself, so dropping it would hide the lead they just
    -- typed in.
    or position('self_assigned := true;' in updated_definition) = 0
    -- No unguarded branch may remain, or a Telecaller lead still becomes a
    -- handoff down whichever path was missed.
    or position(E'case when self_assigned then ''Transferred to Sales''' in updated_definition) > 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'TELECALLER_CREATE_LEAD_INTAKE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

do $migration$
declare
  signature regprocedure :=
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'        and member_row.eligible_for_fresh_leads\n        and profile_row.active\n        and profile_row.deleted_at is null\n      order by',
    E'        and member_row.eligible_for_fresh_leads\n        and profile_row.active\n        and profile_row.deleted_at is null\n        and exists (\n          select 1\n          from public.user_role_assignments intake_assignment\n          join public.roles intake_role\n            on intake_role.id = intake_assignment.role_id\n           and intake_role.organization_id = intake_assignment.organization_id\n          where intake_assignment.organization_id = target_organization_id\n            and intake_assignment.user_id = member_row.user_id\n            and intake_assignment.active\n            and intake_role.role_key = ''telecaller_bdc''\n        )\n      order by'
  );

  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'CREATE_LEAD_ROUND_ROBIN_TELECALLER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

do $assert$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure
  );
begin
  if position('actor_is_sales_consultant' in definition) = 0
    or position('Customer identity is resolved explicitly after creation' in definition) = 0
    or position('resolved_customer_id' in definition) > 0
    or position('lead_phone_digits' in definition) > 0
    or position('intake_role.role_key = ''telecaller_bdc''' in definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'CREATE_LEAD_LINEAGE_REBUILD_INCOMPLETE';
  end if;
end;
$assert$;

-- Data written while the replacement was live. The window starts after the
-- last lead that create_lead still left unlinked (09:45:38 UTC).
do $repair$
declare
  window_start constant timestamptz := '2026-09-28 09:45:39+00';
  linked_leads uuid[];
  deletable_customers uuid[];
  reset_leads uuid[];
  lead_count integer := 0;
  customer_count integer := 0;
  reset_count integer := 0;
begin
  -- Leads that received a customer at creation and that nobody has linked
  -- deliberately since (resolve_lead_customer writes CUSTOMER_LINKED or
  -- CUSTOMER_CREATED_AND_LINKED on the lead).
  select coalesce(array_agg(lead_row.id), '{}'::uuid[])
  into linked_leads
  from public.leads lead_row
  where lead_row.created_at >= window_start
    and lead_row.customer_id is not null
    and lead_row.deleted_at is null
    and not exists (
      select 1 from public.activities activity_row
      where activity_row.lead_id = lead_row.id
        and activity_row.activity_type in ('CUSTOMER_LINKED', 'CUSTOMER_CREATED_AND_LINKED')
    );

  -- Customers the replacement created: made in the same transaction as one of
  -- those leads, referenced only by those leads, and not yet used anywhere else.
  select coalesce(array_agg(customer_row.id), '{}'::uuid[])
  into deletable_customers
  from public.customers customer_row
  where customer_row.deleted_at is null
    and customer_row.created_at >= window_start
    and exists (
      select 1 from public.leads lead_row
      where lead_row.id = any(linked_leads)
        and lead_row.customer_id = customer_row.id
        and lead_row.created_at = customer_row.created_at
    )
    and not exists (
      select 1 from public.leads lead_row
      where lead_row.customer_id = customer_row.id
        and lead_row.deleted_at is null
        and not (lead_row.id = any(linked_leads))
    )
    and not exists (select 1 from public.activities r where r.customer_id = customer_row.id)
    and not exists (select 1 from public.appointments r where r.customer_id = customer_row.id)
    and not exists (select 1 from public.bookings r where r.customer_id = customer_row.id)
    and not exists (select 1 from public.calls r where r.customer_id = customer_row.id)
    and not exists (select 1 from public.conversations r where r.customer_id = customer_row.id)
    and not exists (
      select 1 from public.customer_drip_enrollments r where r.customer_id = customer_row.id
    )
    and not exists (select 1 from public.followups r where r.customer_id = customer_row.id)
    and not exists (
      select 1 from public.personal_whatsapp_conversations r where r.customer_id = customer_row.id
    )
    and not exists (select 1 from public.quotations r where r.customer_id = customer_row.id)
    and not exists (select 1 from public.tasks r where r.customer_id = customer_row.id)
    and not exists (
      select 1 from public.test_drive_appointments r where r.customer_id = customer_row.id
    )
    and not exists (select 1 from public.test_drives r where r.customer_id = customer_row.id);

  -- Only unlink a lead whose customer is one of those, or a pre-existing
  -- customer it was matched to by phone with nothing built on the link yet. A
  -- lead whose customer is already in use keeps its link rather than being
  -- left half-repaired.
  select coalesce(array_agg(lead_row.id), '{}'::uuid[])
  into linked_leads
  from public.leads lead_row
  join public.customers customer_row on customer_row.id = lead_row.customer_id
  where lead_row.id = any(linked_leads)
    and (
      customer_row.id = any(deletable_customers)
      or (
        customer_row.created_at < window_start
        and not exists (
          select 1 from public.quotations r
          where r.lead_id = lead_row.id and r.customer_id = customer_row.id
        )
        and not exists (
          select 1 from public.bookings r
          where r.lead_id = lead_row.id and r.customer_id = customer_row.id
        )
      )
    );

  lead_count := coalesce(array_length(linked_leads, 1), 0);
  customer_count := coalesce(array_length(deletable_customers, 1), 0);
  -- The replacement was live for a few hours on the demo tenant. A broad match
  -- means the rule no longer means what it was written to mean.
  if lead_count > 40 or customer_count > 40 then
    raise exception using errcode = 'P0001', message = 'AUTO_LINK_REPAIR_SCOPE_TOO_BROAD';
  end if;

  if lead_count > 0 then
    update public.leads
    set customer_id = null,
        updated_at = greatest(now(), updated_at + interval '1 microsecond')
    where id = any(linked_leads);
  end if;
  if customer_count > 0 then
    update public.customers
    set deleted_at = now(),
        deletion_reason = 'Auto-created by an out-of-band create_lead on 2026-09-28; '
          || 'customer identity is resolved explicitly (202609020013).'
    where id = any(deletable_customers);
  end if;

  -- Telecaller leads written straight to Transferred to Sales. Still owned by
  -- the Telecaller who typed them, never handed to anyone: exact, not heuristic.
  select coalesce(array_agg(lead_row.id), '{}'::uuid[])
  into reset_leads
  from public.leads lead_row
  where lead_row.created_at >= window_start
    and lead_row.lifecycle_status = 'Transferred to Sales'
    and lead_row.deleted_at is null
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = lead_row.assigned_user_id
        and assignment_row.organization_id = lead_row.organization_id
        and assignment_row.active
        and role_row.role_key = 'telecaller_bdc'
    )
    and not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = lead_row.assigned_user_id
        and assignment_row.organization_id = lead_row.organization_id
        and assignment_row.active
        and role_row.role_key = 'sales_consultant'
    )
    and not exists (
      select 1 from public.lead_assignment_history history_row
      where history_row.lead_id = lead_row.id
        and history_row.previous_owner_id is not null
        and history_row.previous_owner_id is distinct from history_row.new_owner_id
    )
    and exists (
      select 1 from public.lead_stage_history stage_row
      where stage_row.lead_id = lead_row.id
        and stage_row.reason = 'Self-assigned lead enters directly as Transferred to Sales'
    );
  reset_count := coalesce(array_length(reset_leads, 1), 0);
  if reset_count > 40 then
    raise exception using errcode = 'P0001', message = 'FALSE_HANDOFF_RESET_SCOPE_TOO_BROAD';
  end if;

  if reset_count > 0 then
    delete from public.lead_stage_history
    where lead_id = any(reset_leads)
      and from_status = 'New'
      and to_status = 'Transferred to Sales'
      and reason = 'Self-assigned lead enters directly as Transferred to Sales';
    update public.leads
    set lifecycle_status = 'New',
        first_contacted_at = null,
        updated_at = greatest(now(), updated_at + interval '1 microsecond')
    where id = any(reset_leads);
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  )
  select lead_row.organization_id, null, 'lead.out_of_band_create_lead_repaired', 'lead',
    lead_row.id::text,
    jsonb_build_object(
      'migration', '20260928175900',
      'customer_unlinked', lead_row.id = any(linked_leads),
      'false_handoff_reset', lead_row.id = any(reset_leads),
      'leads_unlinked', lead_count,
      'customers_soft_deleted', customer_count,
      'leads_reset', reset_count
    )
  from public.leads lead_row
  where lead_row.id = any(linked_leads) or lead_row.id = any(reset_leads);
end;
$repair$;

commit;
