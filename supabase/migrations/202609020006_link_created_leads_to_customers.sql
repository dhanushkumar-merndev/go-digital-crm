begin;

-- Leads created through Add Lead never carried a customer_id. create_lead wrote
-- customer_name and phone onto the lead and stopped there, so the customers
-- table only ever grew from the demo seed and from Customer 360's own create.
--
-- Every "can this user see this customer" gate joins customer -> lead ->
-- assignee. With leads.customer_id null there is no such join, so Customer 360
-- answered PERMISSION_DENIED for every hand-created lead, for every role. It
-- was invisible on Sales Consultant only because the seed pre-linked those rows.
--
-- create_lead now resolves a customer before inserting the lead: reuse the one
-- whose phone digits match, else create it. Matching on digits is the same key
-- 202609020001 groups leads by, so a phone group maps to a single customer
-- instead of a fresh customer per enquiry.

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
  if app_private.normalize_phone_digits(normalized_phone) <> '' then
    select customer_row.id
    into resolved_customer_id
    from public.customers customer_row
    where customer_row.organization_id = target_organization_id
      and customer_row.deleted_at is null
      and app_private.normalize_phone_digits(customer_row.normalized_phone)
        = app_private.normalize_phone_digits(normalized_phone)
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

-- Existing rows: attach the leads that were created before the change. Same
-- digit match, and a customer is created only for a phone that has none.
do $backfill$
declare
  lead_row record;
  matched_customer_id uuid;
begin
  for lead_row in
    select l.id, l.organization_id, l.customer_name, l.phone, l.normalized_phone, l.email
    from public.leads l
    where l.customer_id is null
      and l.deleted_at is null
      and app_private.normalize_phone_digits(l.normalized_phone) <> ''
    order by l.created_at, l.id
  loop
    select c.id
    into matched_customer_id
    from public.customers c
    where c.organization_id = lead_row.organization_id
      and c.deleted_at is null
      and app_private.normalize_phone_digits(c.normalized_phone)
        = app_private.normalize_phone_digits(lead_row.normalized_phone)
    order by c.created_at, c.id
    limit 1;

    if matched_customer_id is null then
      insert into public.customers (
        organization_id, full_name, primary_phone, normalized_phone, primary_email
      ) values (
        lead_row.organization_id,
        btrim(lead_row.customer_name),
        btrim(lead_row.phone),
        lead_row.normalized_phone,
        nullif(lower(btrim(lead_row.email)), '')
      ) returning id into matched_customer_id;
    end if;

    update public.leads
    set customer_id = matched_customer_id
    where id = lead_row.id;
  end loop;
end;
$backfill$;

commit;
