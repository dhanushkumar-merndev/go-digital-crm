begin;

-- A Sales Consultant who types a lead in by hand is standing in front of the
-- customer. The enquiry is already theirs and the conversation has already
-- happened, so two things that used to be left blank are now recorded at
-- creation:
--
-- 1. The handoff. Consultant lead queues key off `sales_handoff_at`, which is
--    derived from a `lead_stage_history` row reaching 'Transferred to Sales'.
--    A self-created lead had no stage history at all, so `sales_handoff_at` was
--    null and the lead matched *none* of the New / Pending / Contacted tabs --
--    it existed only under All. This was not a cosmetic gap: the lead was
--    invisible in every working queue on the page.
--
-- 2. The contact. A `SALES_CONTACTED` activity is written with the same
--    timestamp, so `sales_contacted_at >= sales_handoff_at` holds and the lead
--    lands on the Contacted rung rather than sitting in Pending as work the
--    consultant has supposedly not started.
--
-- Both are written only on the self-assigned path -- the same condition that
-- already decides a consultant owns what they created. A manager creating into
-- a team queue is not the person who spoke to the customer, so nothing about
-- their leads changes.
--
-- The consultant's team is also resolved here rather than asked for. A
-- consultant belongs to one active sales team (202608290002), so the Team
-- picker in the create dialog offered a choice that was never theirs to make
-- and defaulted to "No team yet", quietly creating teamless leads.

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
  contacted_at timestamptz;
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

  -- Derived rather than asked for: the consultant's own active sales team in
  -- this branch. Scoped to the branch so a member of a team elsewhere cannot
  -- drag the lead out of the branch it was created in.
  if self_assigned and resolved_team_id is null then
    select member_row.team_id into resolved_team_id
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_organization_id
      and member_row.user_id = auth.uid()
      and member_row.active
      and member_row.member_type = 'SALES_CONSULTANT'
      and team_row.active
      and team_row.branch_id = target_branch_id
    order by member_row.joined_at, member_row.team_id
    limit 1;
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
    assigned_user_id,
    lifecycle_status,
    first_contacted_at
  ) values (
    target_organization_id,
    target_branch_id,
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
      target_organization_id, new_lead_id, target_branch_id, resolved_team_id,
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
      target_organization_id, new_lead_id, target_branch_id, resolved_team_id,
      null, selected_user_id, auth.uid(),
      case when self_assigned then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end::public.assignment_mode,
      case
        when self_assigned then 'Manually created by the owning consultant'
        else 'Automatic fresh lead assignment'
      end
    );
  end if;

  if self_assigned then
    -- The handoff the consultant queues key off. Written with the lead's own
    -- first_contacted_at so the SALES_CONTACTED activity below cannot land
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
    target_branch_id,
    jsonb_build_object(
      'source', lead_source,
      'team_id', resolved_team_id,
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

commit;
