begin;

-- One owner per customer, at each stage.
--
-- 1. app_private.same_customer_owner finds the person already handling a
--    customer: a telecaller holding an open intake lead on the mobile (FRESH),
--    or a Sales Consultant holding any of the customer's leads (QUALIFIED), who
--    is active and eligible in the lead's team.
-- 2. create_lead and ingest_provider_lead route a new enquiry to that
--    telecaller before any round robin / least-assigned pick.
-- 3. transfer_lead_to_sales hands a qualified lead to the customer's existing
--    consultant; a manual pick of anyone else raises CUSTOMER_HAS_SALES_OWNER.
--    get_sales_handoff_candidates offers only that consultant
--    (assignment_mode = 'SAME_CUSTOMER') so the dialog cannot pick wrong.
-- 4. record_telecaller_lead_contact: the first telecaller to contact the
--    customer takes over another telecaller's untouched leads on the same
--    mobile (same branch and team, New, never contacted), with assignment
--    history, a LEAD_TAKEN_OVER activity and an audit row per lead.
-- All four record the SAME_CUSTOMER method (202610090501).
--
-- Plus, for the lead list:
-- 5. get_lead_phone_history no longer shows a consultant other consultants'
--    leads as context; only the customer's intake pipeline. The group badge
--    count in get_sales_role_lead_workspace_page follows the same rule.
-- 6. get_sales_role_lead_workspace_page returns handed_off_by_name, the
--    previous owner on the latest assignment to the current owner.
--
-- Every existing body is text-patched from the deployed pg_get_functiondef.

CREATE OR REPLACE FUNCTION app_private.same_customer_owner(
  target_organization_id uuid,
  target_team_id uuid,
  target_phone text,
  target_customer_id uuid,
  exclude_lead_id uuid,
  assignment_kind text
)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- The person already handling this customer, if they can take another lead in
  -- this team. FRESH looks for a telecaller holding an open intake lead on the
  -- mobile; QUALIFIED for a Sales Consultant holding any of the customer's
  -- leads, preferring a live one over a lost one, then the most recent.
  select lead_row.assigned_user_id
  from public.leads lead_row
  join public.team_members member_row
    on member_row.organization_id = lead_row.organization_id
   and member_row.team_id = target_team_id
   and member_row.user_id = lead_row.assigned_user_id
   and member_row.active
   and case when assignment_kind = 'FRESH'
     then member_row.eligible_for_fresh_leads
     else member_row.eligible_for_qualified_leads end
  join public.profiles profile_row
    on profile_row.id = lead_row.assigned_user_id
   and profile_row.organization_id = lead_row.organization_id
   and profile_row.active
   and profile_row.deleted_at is null
  where lead_row.organization_id = target_organization_id
    and target_team_id is not null
    and lead_row.deleted_at is null
    and lead_row.assigned_user_id is not null
    and (exclude_lead_id is null or lead_row.id <> exclude_lead_id)
    and (
      (nullif(target_phone, '') is not null and lead_row.normalized_phone = target_phone)
      or (target_customer_id is not null and lead_row.customer_id = target_customer_id)
    )
    and (
      assignment_kind <> 'FRESH'
      or lead_row.lifecycle_status not in ('Lost', 'Transferred to Sales')
    )
    and exists (
      select 1
      from public.user_role_assignments owner_assignment
      join public.roles owner_role
        on owner_role.id = owner_assignment.role_id
       and owner_role.organization_id = owner_assignment.organization_id
      where owner_assignment.organization_id = target_organization_id
        and owner_assignment.user_id = lead_row.assigned_user_id
        and owner_assignment.active
        and owner_role.role_key = case when assignment_kind = 'FRESH'
          then 'telecaller_bdc' else 'sales_consultant' end
    )
  order by (lead_row.lifecycle_status = 'Lost') asc, lead_row.updated_at desc, lead_row.id
  limit 1;
$function$;
revoke all on function app_private.same_customer_owner(uuid, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_lead(target_organization_id uuid, target_branch_id uuid, target_team_id uuid, lead_source text, lead_customer_name text, lead_phone text, lead_email text DEFAULT NULL::text, lead_source_detail text DEFAULT NULL::text, lead_campaign text DEFAULT NULL::text, lead_interested_model text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_phone text;
  new_lead_id uuid;
  team_mode public.assignment_mode;
  selected_user_id uuid;
  assignment_id uuid;
  self_assigned boolean := false;
  actor_is_sales_consultant boolean := false;
  resolved_team_id uuid := target_team_id;
  resolved_branch_id uuid := target_branch_id;
  contacted_at timestamptz;
begin
  if not app_private.has_permission(target_organization_id, 'lead.create')
    or not app_private.can_access_branch(target_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into actor_is_sales_consultant;

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

    -- The telecaller already working this mobile keeps the customer, whatever
    -- the team's mode, so one person talks to them about every enquiry.
    selected_user_id := app_private.same_customer_owner(
      target_organization_id, target_team_id,
      app_private.canonical_indian_mobile(normalized_phone), null, null, 'FRESH'
    );
    if selected_user_id is not null then
      team_mode := 'SAME_CUSTOMER';
    elsif team_mode = 'LEAST_ASSIGNED' then
      selected_user_id := app_private.claim_least_assigned_member(
        target_organization_id, target_team_id, 'FRESH'
      );
      if selected_user_id is null then
        raise exception using errcode = '23514', message = 'NO_ELIGIBLE_FRESH_ASSIGNEE';
      end if;
    elsif team_mode = 'ROUND_ROBIN' then
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
        and exists (
          select 1
          from public.user_role_assignments intake_assignment
          join public.roles intake_role
            on intake_role.id = intake_assignment.role_id
           and intake_role.organization_id = intake_assignment.organization_id
          where intake_assignment.organization_id = target_organization_id
            and intake_assignment.user_id = member_row.user_id
            and intake_assignment.active
            and intake_role.role_key = 'telecaller_bdc'
        )
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

  -- Customer identity is resolved explicitly after creation. A matching
  -- phone/email only produces candidates for resolve_lead_customer.
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
    case when self_assigned and actor_is_sales_consultant then 'Transferred to Sales' else 'New' end::public.lead_lifecycle,
    case when self_assigned and actor_is_sales_consultant then clock_timestamp() else null end
  ) returning id, first_contacted_at into new_lead_id, contacted_at;

  if selected_user_id is not null then
    insert into public.lead_assignments (
      organization_id, lead_id, branch_id, team_id, assigned_user_id,
      assignment_type, method, assigned_by, reason
    ) values (
      target_organization_id, new_lead_id, resolved_branch_id, resolved_team_id,
      selected_user_id, 'FRESH',
      case when self_assigned then 'MANUAL_ASSIGNMENT' else coalesce(team_mode, 'ROUND_ROBIN') end::public.assignment_mode,
      auth.uid(),
      case
        when self_assigned then 'Manually created by the owning consultant'
        when team_mode = 'SAME_CUSTOMER'
          then 'Kept with the telecaller already handling this customer'
        else 'Automatic fresh lead assignment'
      end
    ) returning id into assignment_id;
    insert into public.lead_assignment_history (
      organization_id, lead_id, branch_id, team_id, previous_owner_id,
      new_owner_id, assigned_by, method, reason
    ) values (
      target_organization_id, new_lead_id, resolved_branch_id, resolved_team_id,
      null, selected_user_id, auth.uid(),
      case when self_assigned then 'MANUAL_ASSIGNMENT' else coalesce(team_mode, 'ROUND_ROBIN') end::public.assignment_mode,
      case
        when self_assigned then 'Manually created by the owning consultant'
        when team_mode = 'SAME_CUSTOMER'
          then 'Kept with the telecaller already handling this customer'
        else 'Automatic fresh lead assignment'
      end
    );
  end if;

  if self_assigned and actor_is_sales_consultant then
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
      'contacted_on_create', self_assigned and actor_is_sales_consultant,
      'assignment_mode', case
        when self_assigned then 'SELF_ON_CREATE'
        else coalesce(team_mode::text, 'UNASSIGNED')
      end
    )
  );
  return new_lead_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ingest_provider_lead(target_organization_id uuid, target_connection_id uuid, target_branch_id uuid, target_team_id uuid, target_external_lead_id text, target_source text, target_source_detail text, target_campaign text, target_customer_name text, target_phone text, target_normalized_phone text, target_email text, target_interested_model text, target_raw_payload jsonb, target_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  connection_row public.connected_accounts%rowtype;
  team_row public.teams%rowtype;
  resolved_team_id uuid;
  selected_user_id uuid;
  existing_lead_id uuid;
  existing_assigned_user_id uuid;
  created_lead_id uuid;
  normalized_customer_name text;
  normalized_external_lead_id text;
  normalized_phone_value text;
  normalized_email_value text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  normalized_external_lead_id := btrim(coalesce(target_external_lead_id, ''));
  if normalized_external_lead_id = '' then
    raise exception using errcode = '23514', message = 'EXTERNAL_LEAD_ID_REQUIRED';
  end if;
  if char_length(normalized_external_lead_id) > 255 then
    raise exception using errcode = '23514', message = 'EXTERNAL_LEAD_ID_TOO_LONG';
  end if;
  if target_source not in ('Facebook','Instagram','Google Ads','Website','WhatsApp Business','CarWale','CarDekho','Justdial','IndiaMART','Other') then
    raise exception using errcode = '23514', message = 'INVALID_PROVIDER_SOURCE';
  end if;

  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and deleted_at is null
    and status = 'CONNECTED';
  if not found then
    raise exception using errcode = '23503', message = 'ACTIVE_CONNECTION_NOT_FOUND';
  end if;
  if connection_row.scope_mode <> 'ALL_BRANCHES'
    and not exists (
      select 1
      from public.integration_branch_mappings scope_mapping
      where scope_mapping.organization_id = target_organization_id
        and scope_mapping.connected_account_id = target_connection_id
        and scope_mapping.branch_id = target_branch_id
        and scope_mapping.external_resource_type = 'CONNECTION_SCOPE'
        and scope_mapping.deleted_at is null
    )
  then
    raise exception using errcode = '42501', message = 'CONNECTION_BRANCH_NOT_MAPPED';
  end if;
  if not exists (
    select 1 from public.branches
    where id = target_branch_id and organization_id = target_organization_id and active
  ) then
    raise exception using errcode = '23503', message = 'ACTIVE_BRANCH_NOT_FOUND';
  end if;

  normalized_customer_name := btrim(coalesce(target_customer_name, ''));
  normalized_phone_value := regexp_replace(coalesce(target_phone, ''), '[^0-9]', '', 'g');
  normalized_email_value := nullif(lower(btrim(coalesce(target_email, ''))), '');
  if char_length(normalized_customer_name) not between 2 and 200
    or char_length(normalized_phone_value) not between 7 and 15
    or char_length(coalesce(target_phone, '')) > 30
    or coalesce(target_phone, '') !~ '^[0-9+()., -]+$'
    or char_length(coalesce(target_source_detail, '')) > 255
    or char_length(coalesce(target_campaign, '')) > 255
    or char_length(coalesce(target_interested_model, '')) > 255
    or (
      normalized_email_value is not null
      and (
        char_length(normalized_email_value) > 254
        or normalized_email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    )
  then
    raise exception using errcode = '23514', message = 'INVALID_PROVIDER_LEAD_IDENTITY';
  end if;

  select id, assigned_user_id into existing_lead_id, existing_assigned_user_id
  from public.leads
  where organization_id = target_organization_id
    and connection_id = target_connection_id
    and external_lead_id = normalized_external_lead_id
  limit 1;
  if existing_lead_id is not null then
    return jsonb_build_object(
      'lead_id', existing_lead_id,
      'duplicate', true,
      'assigned_user_id', existing_assigned_user_id
    );
  end if;

  resolved_team_id := coalesce(target_team_id, connection_row.default_team_id);
  if resolved_team_id is not null then
    select * into team_row
    from public.teams
    where id = resolved_team_id
      and organization_id = target_organization_id
      and branch_id = target_branch_id
      and active
    for update;
    if not found then
      raise exception using errcode = '23503', message = 'ACTIVE_TEAM_NOT_FOUND';
    end if;

    -- Same rule as create_lead: the telecaller already working this mobile
    -- keeps the customer. Overriding the row's mode locally makes the
    -- assignment rows below record SAME_CUSTOMER.
    selected_user_id := app_private.same_customer_owner(
      target_organization_id, resolved_team_id,
      app_private.canonical_indian_mobile(normalized_phone_value), null, null, 'FRESH'
    );
    if selected_user_id is not null then
      team_row.fresh_assignment_mode := 'SAME_CUSTOMER';
    elsif team_row.fresh_assignment_mode = 'LEAST_ASSIGNED' then
      selected_user_id := app_private.claim_least_assigned_member(
        target_organization_id, resolved_team_id, 'FRESH'
      );
    elsif team_row.fresh_assignment_mode = 'ROUND_ROBIN' then
      select tm.user_id into selected_user_id
      from public.team_members tm
      join public.profiles p on p.id = tm.user_id
      where tm.organization_id = target_organization_id
        and tm.team_id = resolved_team_id
        and tm.active
        and tm.eligible_for_fresh_leads
        and p.active
        and p.deleted_at is null
        and exists (
          select 1
          from public.user_role_assignments intake_assignment
          join public.roles intake_role
            on intake_role.id = intake_assignment.role_id
           and intake_role.organization_id = intake_assignment.organization_id
          where intake_assignment.organization_id = target_organization_id
            and intake_assignment.user_id = tm.user_id
            and intake_assignment.active
            and intake_role.role_key = 'telecaller_bdc'
        )
      order by tm.last_fresh_assigned_at asc nulls first, tm.joined_at asc, tm.user_id
      for update of tm
      limit 1;
    end if;
  end if;

  begin
    insert into public.leads (
      organization_id, branch_id, team_id, source, source_detail, campaign,
      connection_id, external_lead_id, raw_payload, customer_name, phone,
      normalized_phone, email, interested_model, assigned_user_id, sla_due_at
    ) values (
      target_organization_id, target_branch_id, resolved_team_id, target_source,
      target_source_detail, target_campaign, target_connection_id,
      normalized_external_lead_id, target_raw_payload, normalized_customer_name,
      target_phone, normalized_phone_value, normalized_email_value,
      nullif(trim(target_interested_model), ''), selected_user_id,
      now() + make_interval(mins => connection_row.lead_sla_minutes)
    ) returning id into created_lead_id;
  exception when unique_violation then
    select id, assigned_user_id into existing_lead_id, existing_assigned_user_id
    from public.leads
    where organization_id = target_organization_id
      and connection_id = target_connection_id
      and external_lead_id = normalized_external_lead_id;
    return jsonb_build_object(
      'lead_id', existing_lead_id,
      'duplicate', true,
      'assigned_user_id', existing_assigned_user_id
    );
  end;

  if selected_user_id is not null then
    update public.team_members
    set last_fresh_assigned_at = now()
    where team_id = resolved_team_id and user_id = selected_user_id;
    insert into public.lead_assignments (
      organization_id, lead_id, branch_id, team_id, assigned_user_id,
      assignment_type, method, reason
    ) values (
      target_organization_id, created_lead_id, target_branch_id, resolved_team_id,
      selected_user_id, 'FRESH', team_row.fresh_assignment_mode, 'Provider lead ingestion'
    );
    insert into public.lead_assignment_history (
      organization_id, lead_id, branch_id, team_id, previous_owner_id,
      new_owner_id, method, reason
    ) values (
      target_organization_id, created_lead_id, target_branch_id, resolved_team_id,
      null, selected_user_id, team_row.fresh_assignment_mode, 'Provider lead ingestion'
    );
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id,
    request_id, metadata
  ) values (
    target_organization_id, null, 'lead.provider_ingested', 'lead',
    created_lead_id::text, target_branch_id, target_request_id,
    jsonb_build_object(
      'connection_id', target_connection_id,
      'external_lead_id', normalized_external_lead_id,
      'assignment_mode', case when selected_user_id is null then 'MANUAL_QUEUE' else team_row.fresh_assignment_mode::text end
    )
  );

  return jsonb_build_object(
    'lead_id', created_lead_id,
    'duplicate', false,
    'assigned_user_id', selected_user_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_lead_to_sales(target_lead_id uuid, target_user_id uuid DEFAULT NULL::uuid, transfer_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  normalized_reason text := nullif(btrim(coalesce(transfer_reason, '')), '');
  actor_is_owning_telecaller boolean := false;
  selected_user_id uuid := target_user_id;
  selected_method public.assignment_mode;
  selected_open_leads bigint;
  qualified_mode public.assignment_mode;
  assignment_id uuid;
  prior_owner_id uuid;
  handoff_at timestamptz := clock_timestamp();
  customer_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if char_length(coalesce(normalized_reason, '')) > 500 then
    raise exception using errcode = '22023', message = 'TRANSFER_REASON_TOO_LONG';
  end if;

  if normalized_reason is null then
    raise exception using errcode = '22023', message = 'TRANSFER_REASON_REQUIRED';
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
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;
  select team_row.qualified_assignment_mode into qualified_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = current_organization_id
  for update;
  if not app_private.can_access_record(
    current_organization_id, target_lead.branch_id, target_lead.team_id, target_lead.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;

  -- An unassigned lead leaves the comparison NULL, and a NULL guard is a guard
  -- that never fires, so the ownership test is pinned to false explicitly.
  actor_is_owning_telecaller := coalesce(target_lead.assigned_user_id = auth.uid(), false)
    and app_private.has_permission(current_organization_id, 'lead.update')
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.organization_id = current_organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
        and role_row.role_key = 'telecaller_bdc'
    );
  if not actor_is_owning_telecaller
    and not app_private.has_permission(current_organization_id, 'lead.assign') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  if target_lead.lifecycle_status = 'Lost' then
    raise exception using errcode = '23514', message = 'LOST_LEAD_CANNOT_TRANSFER';
  end if;

  if exists (
    select 1 from public.followups followup_row
    where followup_row.organization_id = current_organization_id
      and followup_row.lead_id = target_lead.id
      and followup_row.status in ('OPEN', 'OVERDUE')
  ) then
    raise exception using errcode = '23514', message = 'FOLLOWUP_PENDING_BEFORE_SALES_HANDOFF';
  end if;

  if target_lead.customer_id is null then
    raise exception using errcode = '23514', message = 'LEAD_CUSTOMER_REQUIRED';
  end if;
  if target_lead.lifecycle_status = 'Transferred to Sales' then
    raise exception using errcode = '23514', message = 'LEAD_ALREADY_WITH_SALES';
  end if;

  -- These transaction-local flags are trusted because only this SECURITY
  -- DEFINER RPC sets them. They let the automatic handoff trigger write the
  -- system-owned lifecycle and let this RPC replace the lead owner.
  perform set_config('app.sales_handoff_rpc', 'on', true);
  perform set_config('app.assign_lead_rpc', 'on', true);

  -- One Sales Consultant per customer: if another of this customer's leads is
  -- already with an eligible consultant in this team, this one goes to them
  -- too, whatever the team's mode. Managers can still reassign afterwards.
  customer_owner_id := app_private.same_customer_owner(
    current_organization_id, target_lead.team_id, target_lead.normalized_phone,
    target_lead.customer_id, target_lead.id, 'QUALIFIED'
  );
  if customer_owner_id is not null then
    if selected_user_id is not null and selected_user_id <> customer_owner_id then
      raise exception using errcode = '23514', message = 'CUSTOMER_HAS_SALES_OWNER';
    end if;
    selected_user_id := customer_owner_id;
  end if;

  if selected_user_id is not null then
    -- A manual pick must still be a Sales Consultant this team can hand to.
    if not exists (
      select 1
      from public.team_members member_row
      join public.profiles profile_row
        on profile_row.id = member_row.user_id
       and profile_row.organization_id = member_row.organization_id
      where member_row.organization_id = current_organization_id
        and member_row.team_id = target_lead.team_id
        and member_row.user_id = selected_user_id
        and member_row.active
        and member_row.eligible_for_qualified_leads
        and profile_row.active
        and profile_row.deleted_at is null
        and exists (
          select 1
          from public.user_role_assignments assignment_row
          join public.roles role_row
            on role_row.id = assignment_row.role_id
           and role_row.organization_id = assignment_row.organization_id
          where assignment_row.organization_id = current_organization_id
            and assignment_row.user_id = member_row.user_id
            and assignment_row.active
            and role_row.role_key = 'sales_consultant'
        )
    ) then
      raise exception using errcode = '23514', message = 'SALES_CONSULTANT_NOT_ELIGIBLE';
    end if;
    selected_method := case
      when customer_owner_id is not null then 'SAME_CUSTOMER'
      else 'MANUAL_ASSIGNMENT'
    end::public.assignment_mode;
  else
    select candidate.user_id, candidate.open_leads
    into selected_user_id, selected_open_leads
    from (
      select member_row.user_id,
        member_row.last_qualified_assigned_at,
        member_row.joined_at,
        (
          select count(*)::bigint
          from public.leads lead_row
          where lead_row.organization_id = current_organization_id
            and lead_row.team_id = target_lead.team_id
            and lead_row.assigned_user_id = member_row.user_id
            and lead_row.deleted_at is null
            and lead_row.lifecycle_status <> 'Lost'
        ) as open_leads
      from public.team_members member_row
      join public.profiles profile_row
        on profile_row.id = member_row.user_id
       and profile_row.organization_id = member_row.organization_id
      where member_row.organization_id = current_organization_id
        and member_row.team_id = target_lead.team_id
        and member_row.active
        and member_row.eligible_for_qualified_leads
        and profile_row.active
        and profile_row.deleted_at is null
        and exists (
          select 1
          from public.user_role_assignments assignment_row
          join public.roles role_row
            on role_row.id = assignment_row.role_id
           and role_row.organization_id = assignment_row.organization_id
          where assignment_row.organization_id = current_organization_id
            and assignment_row.user_id = member_row.user_id
            and assignment_row.active
            and role_row.role_key = 'sales_consultant'
        )
    ) candidate
    order by case when qualified_mode = 'ROUND_ROBIN' then 0 else candidate.open_leads end asc,
      candidate.last_qualified_assigned_at asc nulls first,
      candidate.joined_at asc,
      candidate.user_id
    limit 1;
    if selected_user_id is null then
      raise exception using errcode = '23514', message = 'NO_ELIGIBLE_SALES_CONSULTANT';
    end if;
    selected_method := case
      when qualified_mode = 'ROUND_ROBIN' then 'ROUND_ROBIN'
      else 'LEAST_ASSIGNED'
    end::public.assignment_mode;
  end if;

  prior_owner_id := target_lead.assigned_user_id;

  -- Qualified is the state the handoff guard and trigger both key off, so it
  -- has to land before the assignment row is written.
  if target_lead.lifecycle_status <> 'Qualified' then
    update public.leads
    set lifecycle_status = 'Qualified',
        first_contacted_at = coalesce(first_contacted_at, handoff_at),
        updated_at = greatest(handoff_at, updated_at + interval '1 microsecond')
    where id = target_lead.id;

    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_organization_id,
      target_lead.id,
      target_lead.lifecycle_status,
      'Qualified',
      auth.uid(),
      coalesce(normalized_reason, 'Qualified for sales handoff')
    );
  end if;

  update public.lead_assignments
  set active = false
  where lead_id = target_lead.id and active;

  insert into public.lead_assignments (
    organization_id, lead_id, branch_id, team_id, assigned_user_id,
    assignment_type, method, assigned_by, reason
  ) values (
    current_organization_id,
    target_lead.id,
    target_lead.branch_id,
    target_lead.team_id,
    selected_user_id,
    'QUALIFIED',
    selected_method,
    auth.uid(),
    coalesce(
      normalized_reason,
      case
        when selected_method = 'ROUND_ROBIN'
          then 'Auto-assigned to the next Sales Consultant in rotation.'
        when selected_method = 'LEAST_ASSIGNED'
          then 'Auto-assigned to the Sales Consultant with the fewest open leads.'
        when selected_method = 'SAME_CUSTOMER'
          then 'Kept with the Sales Consultant already handling this customer.'
        else 'Transferred to the selected Sales Consultant.'
      end
    )
  ) returning id into assignment_id;

  insert into public.lead_assignment_history (
    organization_id, lead_id, branch_id, team_id, previous_owner_id,
    new_owner_id, assigned_by, method, reason
  ) values (
    current_organization_id,
    target_lead.id,
    target_lead.branch_id,
    target_lead.team_id,
    prior_owner_id,
    selected_user_id,
    auth.uid(),
    selected_method,
    normalized_reason
  );

  update public.leads
  set assigned_user_id = selected_user_id,
      updated_at = greatest(handoff_at, updated_at + interval '1 microsecond')
  where id = target_lead.id;

  update public.team_members
  set last_qualified_assigned_at = handoff_at
  where organization_id = current_organization_id
    and team_id = target_lead.team_id
    and user_id = selected_user_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id,
    auth.uid(),
    'lead.sales_handoff_requested',
    'lead',
    target_lead.id::text,
    target_lead.branch_id,
    jsonb_build_object(
      'assignment_id', assignment_id,
      'sales_consultant_id', selected_user_id,
      'previous_owner_id', prior_owner_id,
      'method', selected_method,
      'open_leads_at_assignment', selected_open_leads,
      'reason', normalized_reason
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'assignment_id', assignment_id,
    'assigned_user_id', selected_user_id,
    'method', selected_method,
    'lifecycle_status', (
      select lead_row.lifecycle_status
      from public.leads lead_row
      where lead_row.id = target_lead.id
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_handoff_candidates(target_lead_id uuid, target_search text DEFAULT ''::text)
 RETURNS TABLE(user_id uuid, full_name text, open_leads bigint, hot_leads bigint, recommended boolean, assignment_mode text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target_lead public.leads%rowtype;
  normalized_search text;
  qualified_mode public.assignment_mode;
  customer_owner_id uuid;
begin
  if target_lead_id is null then
    raise exception using errcode = '22023', message = 'LEAD_ID_REQUIRED';
  end if;
  normalized_search := left(btrim(coalesce(target_search, '')), 160);

  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.id = target_lead_id
    and lead_row.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
      target_lead.organization_id,
      target_lead.branch_id,
      target_lead.team_id,
      target_lead.assigned_user_id
    )
    or not (
      app_private.has_permission(target_lead.organization_id, 'lead.assign')
      or (
        coalesce(target_lead.assigned_user_id = auth.uid(), false)
        and app_private.has_permission(target_lead.organization_id, 'lead.update')
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if target_lead.team_id is null then
    raise exception using errcode = '23514', message = 'LEAD_TEAM_REQUIRED';
  end if;

  select team_row.qualified_assignment_mode into qualified_mode
  from public.teams team_row
  where team_row.id = target_lead.team_id
    and team_row.organization_id = target_lead.organization_id;

  -- The customer's existing consultant is the only valid pick (see
  -- transfer_lead_to_sales); offering anyone else would fail on submit.
  customer_owner_id := app_private.same_customer_owner(
    target_lead.organization_id, target_lead.team_id, target_lead.normalized_phone,
    target_lead.customer_id, target_lead.id, 'QUALIFIED'
  );

  return query
  with eligible as (
    select member_row.user_id,
      profile_row.full_name,
      member_row.last_qualified_assigned_at,
      member_row.joined_at
    from public.team_members member_row
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = target_lead.organization_id
      and member_row.team_id = target_lead.team_id
      and member_row.active
      and member_row.eligible_for_qualified_leads
      and profile_row.active
      and profile_row.deleted_at is null
      and (customer_owner_id is null or member_row.user_id = customer_owner_id)
      and exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.organization_id = target_lead.organization_id
          and assignment_row.user_id = member_row.user_id
          and assignment_row.active
          and role_row.role_key = 'sales_consultant'
      )
  ), loaded as (
    select eligible_row.*,
      coalesce(book.open_leads, 0)::bigint as open_leads,
      coalesce(book.hot_leads, 0)::bigint as hot_leads
    from eligible eligible_row
    left join lateral (
      select count(*)::bigint as open_leads,
        count(*) filter (where lead_row.temperature = 'HOT')::bigint as hot_leads
      from public.leads lead_row
      where lead_row.organization_id = target_lead.organization_id
        and lead_row.team_id = target_lead.team_id
        and lead_row.assigned_user_id = eligible_row.user_id
        and lead_row.deleted_at is null
        and lead_row.lifecycle_status <> 'Lost'
    ) book on true
  ), ranked as (
    -- The recommendation is a property of the team, not of the search box, so
    -- it is decided before any name filter is applied. It mirrors the order
    -- transfer_lead_to_sales uses for an automatic pick.
    select loaded_row.*,
      row_number() over (
        order by case when qualified_mode = 'ROUND_ROBIN' then 0 else loaded_row.open_leads end asc,
          loaded_row.last_qualified_assigned_at asc nulls first,
          loaded_row.joined_at asc,
          loaded_row.user_id
      ) = 1 as recommended
    from loaded loaded_row
  )
  select ranked_row.user_id,
    ranked_row.full_name,
    ranked_row.open_leads,
    ranked_row.hot_leads,
    ranked_row.recommended,
    case
      when customer_owner_id is not null then 'SAME_CUSTOMER'
      else coalesce(qualified_mode::text, 'MANUAL_ASSIGNMENT')
    end
  from ranked ranked_row
  where customer_owner_id is not null
    or normalized_search = ''
    or ranked_row.full_name ilike '%' || normalized_search || '%'
  order by ranked_row.open_leads asc, ranked_row.full_name, ranked_row.user_id
  limit 50;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_telecaller_lead_contact(target_lead_id uuid, contact_channel text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  normalized_channel text := upper(btrim(coalesce(contact_channel, '')));
  contacted_at timestamptz := clock_timestamp();
  next_lifecycle public.lead_lifecycle;
  sibling record;
  taken_over_lead_ids uuid[] := '{}'::uuid[];
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
  -- First contact wins the customer. Another telecaller's untouched leads on
  -- the same mobile (same branch and team, still New, never contacted) move to
  -- this telecaller, so one person handles the customer. A lead someone has
  -- already started working stays where it is.
  perform set_config('app.assign_lead_rpc', 'on', true);
  for sibling in
    select lead_row.id, lead_row.assigned_user_id, lead_row.branch_id,
      lead_row.team_id, lead_row.customer_id
    from public.leads lead_row
    where lead_row.organization_id = current_organization_id
      and lead_row.id <> target_lead.id
      and lead_row.deleted_at is null
      and lead_row.branch_id = target_lead.branch_id
      and lead_row.team_id is not distinct from target_lead.team_id
      and lead_row.lifecycle_status = 'New'
      and lead_row.first_contacted_at is null
      and lead_row.assigned_user_id is not null
      and lead_row.assigned_user_id <> auth.uid()
      and (
        (nullif(target_lead.normalized_phone, '') is not null
          and lead_row.normalized_phone = target_lead.normalized_phone)
        or (target_lead.customer_id is not null and lead_row.customer_id = target_lead.customer_id)
      )
      and exists (
        select 1
        from public.user_role_assignments owner_assignment
        join public.roles owner_role
          on owner_role.id = owner_assignment.role_id
         and owner_role.organization_id = owner_assignment.organization_id
        where owner_assignment.organization_id = current_organization_id
          and owner_assignment.user_id = lead_row.assigned_user_id
          and owner_assignment.active
          and owner_role.role_key = 'telecaller_bdc'
      )
    order by lead_row.created_at, lead_row.id
    for update of lead_row
  loop
    update public.leads
    set assigned_user_id = auth.uid(),
        updated_at = greatest(contacted_at, updated_at + interval '1 microsecond')
    where id = sibling.id;
    update public.lead_assignments
    set active = false
    where lead_id = sibling.id and active;
    insert into public.lead_assignments (
      organization_id, lead_id, branch_id, team_id, assigned_user_id,
      assignment_type, method, assigned_by, reason
    ) values (
      current_organization_id, sibling.id, sibling.branch_id, sibling.team_id,
      auth.uid(), 'FRESH', 'SAME_CUSTOMER', auth.uid(),
      'Customer contacted first on L-' || upper(left(target_lead.id::text, 8))
    );
    insert into public.lead_assignment_history (
      organization_id, lead_id, branch_id, team_id, previous_owner_id,
      new_owner_id, assigned_by, method, reason
    ) values (
      current_organization_id, sibling.id, sibling.branch_id, sibling.team_id,
      sibling.assigned_user_id, auth.uid(), auth.uid(), 'SAME_CUSTOMER',
      'Customer contacted first on L-' || upper(left(target_lead.id::text, 8))
    );
    insert into public.activities (
      organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
    ) values (
      current_organization_id, sibling.customer_id, sibling.id, 'LEAD_TAKEN_OVER', auth.uid(),
      jsonb_build_object(
        'previous_owner_id', sibling.assigned_user_id,
        'contacted_lead_id', target_lead.id,
        'channel', normalized_channel
      ),
      contacted_at
    );
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
    ) values (
      current_organization_id, auth.uid(), 'lead.taken_over_same_customer', 'lead',
      sibling.id::text, sibling.branch_id,
      jsonb_build_object(
        'previous_owner_id', sibling.assigned_user_id,
        'contacted_lead_id', target_lead.id
      )
    );
    taken_over_lead_ids := taken_over_lead_ids || sibling.id;
  end loop;

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
      'lifecycle_status', next_lifecycle,
      'taken_over_lead_ids', to_jsonb(taken_over_lead_ids)
    )
  );

  return jsonb_build_object(
    'lead_id', target_lead.id,
    'contacted_at', contacted_at,
    'lifecycle_status', next_lifecycle,
    'taken_over_lead_ids', to_jsonb(taken_over_lead_ids)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_lead_phone_history(target_lead_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  access_context jsonb;
  current_organization_id uuid;
  workspace_scope record;
  actor_is_sales_consultant boolean := false;
  actor_is_telecaller boolean := false;
  anchor_phone text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'organization_id' is null
    or not (access_context->>'role_key' = any(array[
      'telecaller', 'sales-consultant', 'team-manager', 'showroom-manager', 'gm-sales'
    ]::text[]))
  then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  select * into workspace_scope
  from app_private.resolve_sales_lead_workspace_scope(current_organization_id);
  if not ('lead.view' = any(workspace_scope.permission_keys)) then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;
  actor_is_sales_consultant := access_context->>'role_key' = 'sales-consultant';
  actor_is_telecaller := access_context->>'role_key' = 'telecaller';

  select lead_row.normalized_phone into anchor_phone
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
    and (
      workspace_scope.organization_wide
      or lead_row.branch_id = any(workspace_scope.branch_scope_ids)
      or (lead_row.team_id is not null and lead_row.team_id = any(workspace_scope.team_scope_ids))
      or (
        workspace_scope.owner_scope
        and lead_row.branch_id = any(workspace_scope.owner_branch_ids)
        and (
          lead_row.assigned_user_id = auth.uid()
          or (
            actor_is_telecaller
            and app_private.is_telecaller_handoff_viewer(
              current_organization_id, lead_row.id, auth.uid()
            )
          )
        )
      )
    )
    and (
      not actor_is_sales_consultant
      or (
        lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
        and (
          lead_row.assigned_user_id = auth.uid()
          or exists (
            select 1
            from public.lead_stage_history handoff_history
            where handoff_history.organization_id = current_organization_id
              and handoff_history.lead_id = lead_row.id
              and handoff_history.to_status = 'Transferred to Sales'
          )
        )
      )
    );
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  return (
    with phone_leads as materialized (
      -- in_scope is the workspace rule this function always applied. A
      -- consultant additionally sees the other enquiries on the same mobile
      -- in their branches, as context rows with a reduced field set, so a
      -- customer's separate opportunities are visible beside their own.
      select lead_row.*,
        (
            (
              workspace_scope.organization_wide
              or lead_row.branch_id = any(workspace_scope.branch_scope_ids)
              or (lead_row.team_id is not null and lead_row.team_id = any(workspace_scope.team_scope_ids))
              or (
                workspace_scope.owner_scope
                and lead_row.branch_id = any(workspace_scope.owner_branch_ids)
                and (
                  lead_row.assigned_user_id = auth.uid()
                  or (
                    actor_is_telecaller
                    and app_private.is_telecaller_handoff_viewer(
                      current_organization_id, lead_row.id, auth.uid()
                    )
                  )
                )
              )
            )
            and (
              not actor_is_sales_consultant
              or (
                lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
                and (
                  lead_row.assigned_user_id = auth.uid()
                  or exists (
                    select 1
                    from public.lead_stage_history handoff_history
                    where handoff_history.organization_id = current_organization_id
                      and handoff_history.lead_id = lead_row.id
                      and handoff_history.to_status = 'Transferred to Sales'
                  )
                )
              )
            )
            ) as in_scope
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and (
          (nullif(anchor_phone, '') is not null and lead_row.normalized_phone = anchor_phone)
          or lead_row.id = target_lead_id
        )
    ), scoped_phone_leads as materialized (
      select phone_lead.*
      from phone_leads phone_lead
      where phone_lead.in_scope
        or (
          actor_is_sales_consultant
          and (
            workspace_scope.organization_wide
            or phone_lead.branch_id = any(workspace_scope.branch_scope_ids)
            or phone_lead.branch_id = any(workspace_scope.owner_branch_ids)
          )
          -- Only the customer's intake pipeline is context for a consultant.
          -- Another consultant's lead is theirs alone; with one sales owner per
          -- customer it should not exist for new enquiries anyway.
          and not exists (
            select 1
            from public.user_role_assignments context_owner_assignment
            join public.roles context_owner_role
              on context_owner_role.id = context_owner_assignment.role_id
             and context_owner_role.organization_id = context_owner_assignment.organization_id
            where context_owner_assignment.organization_id = current_organization_id
              and context_owner_assignment.user_id = phone_lead.assigned_user_id
              and context_owner_assignment.active
              and context_owner_role.role_key = 'sales_consultant'
          )
        )
    ), history_rows as (
      select
        lead_row.*,
        profile_row.full_name as assigned_user_name,
        case when exists (
          select 1
          from public.user_role_assignments consultant_assignment
          join public.roles consultant_role
            on consultant_role.id = consultant_assignment.role_id
           and consultant_role.organization_id = consultant_assignment.organization_id
          where consultant_assignment.organization_id = lead_row.organization_id
            and consultant_assignment.user_id = lead_row.assigned_user_id
            and consultant_assignment.active
            and consultant_role.role_key = 'sales_consultant'
        ) then profile_row.full_name end as assigned_consultant_name,
        case
          when lead_row.lifecycle_status = 'Lost' then 'Lost'
          when exists (
            select 1 from public.bookings booking_row
            where booking_row.organization_id = current_organization_id
              and booking_row.lead_id = lead_row.id
              and booking_row.deleted_at is null
              and booking_row.status <> 'CANCELLED'
          ) then 'Booking'
          when exists (
            select 1 from public.quotations quotation_row
            where quotation_row.organization_id = current_organization_id
              and quotation_row.lead_id = lead_row.id
              and quotation_row.deleted_at is null
          ) then 'Quotation'
          when exists (
            select 1 from public.test_drive_appointments drive_row
            where drive_row.organization_id = current_organization_id
              and drive_row.lead_id = lead_row.id
          ) then 'Test Drive'
          when actor_is_sales_consultant
            and lead_row.lifecycle_status = 'Transferred to Sales'
            and exists (
              select 1 from public.activities activity_row
              where activity_row.organization_id = current_organization_id
                and activity_row.lead_id = lead_row.id
                and activity_row.activity_type = 'SALES_CONTACTED'
            ) then 'Sales Contacted'
          else lead_row.lifecycle_status::text
        end as lead_stage,
        case
          when lead_row.lifecycle_status = 'Lost' then null
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and lead_row.created_at < pg_catalog.timezone('Asia/Kolkata', date_trunc('day', pg_catalog.timezone('Asia/Kolkata', now()))) then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      from scoped_phone_leads lead_row
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
       and profile_row.active
       and profile_row.deleted_at is null
      order by lead_row.created_at desc, lead_row.id desc
      limit 100
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          case
            when history_row.in_scope then
              to_jsonb(history_row) - 'deleted_at' - 'connection_id' - 'external_lead_id' - 'in_scope'
                || jsonb_build_object('context_only', false)
            else jsonb_build_object(
              'id', history_row.id,
              'organization_id', history_row.organization_id,
              'customer_name', history_row.customer_name,
              'phone', history_row.phone,
              'normalized_phone', history_row.normalized_phone,
              'interested_model', history_row.interested_model,
              'source', history_row.source,
              'lifecycle_status', history_row.lifecycle_status,
              'lead_stage', history_row.lead_stage,
              'temperature', history_row.temperature,
              'assigned_user_id', history_row.assigned_user_id,
              'assigned_consultant_name', history_row.assigned_consultant_name,
              'created_at', history_row.created_at,
              'updated_at', history_row.updated_at,
              'read_only', true,
              'context_only', true
            )
          end
          order by history_row.created_at desc, history_row.id desc
        )
        from history_rows history_row
      ), '[]'::jsonb),
      'total', (select count(*) from scoped_phone_leads)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION app_private.get_sales_role_lead_workspace_page(target_organization_id uuid, target_actor_id uuid, target_organization_wide boolean, target_branch_scope_ids uuid[], target_team_scope_ids uuid[], target_owner_scope boolean, target_owner_branch_ids uuid[], target_page integer, target_page_size integer, target_search text, target_status text, target_sort text, target_model text, target_source text, target_stage text, target_temperature text, target_followup_from date, target_followup_to date, target_include_records boolean DEFAULT true, target_include_kpis boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_search text;
  search_phone_digits text;
  search_lead_id uuid;
  normalized_model text;
  normalized_source text;
  followup_from_at timestamptz;
  followup_to_exclusive_at timestamptz;
  query_now timestamptz := now();
  actor_is_sales_consultant boolean := false;
  actor_is_telecaller boolean := false;
  -- Personal pins for this viewer, most recently pinned first. Capped so the
  -- ordering join below stays a tiny hash probe even for heavy pinners.
  pinned_lead_ids uuid[];
  -- Leads this Telecaller handed to Sales; resolved once, not per row.
  telecaller_handoff_lead_ids uuid[] := array[]::uuid[];
  -- Windowed paging: records-only requests without search walk the scope in
  -- sort order and evaluate only a window of it (plus pins and phone-group
  -- siblings). candidate_lead_ids null means the whole scope.
  candidate_lead_ids uuid[];
  walk_ids uuid[];
  walk_sql text;
  walk_order text;
  walk_scope text;
  window_size integer;
  window_rows integer;
  window_last_id uuid;
  window_last_updated timestamptz;
  window_last_created timestamptz;
  window_last_name text;
  window_exhausted boolean := true;
  window_needed bigint;
  result jsonb;
begin
  if target_organization_id is null
    or target_actor_id is null
    or target_actor_id is distinct from auth.uid()
  then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;
  if target_page is null or target_page < 1
    or target_page_size is null or target_page_size not in (25, 50, 100)
    or target_status is null or target_status not in (
      'all', 'hot', 'warm', 'cold', 'follow-up', 'test-drive', 'quotation', 'booking',
      'new', 'contacted', 'qualified', 'appointment-scheduled', 'transferred-to-sales',
      'lost', 'new-today', 'pending', 'sla-risk',
      'sales-new', 'sales-pending', 'sales-contacted',
      'starred'
    )
    or target_stage is null or target_stage not in (
      'all', 'New', 'Contacted', 'Qualified', 'Appointment Scheduled',
      'Transferred to Sales', 'Lost', 'Test Drive', 'Quotation', 'Booking'
    )
    or target_temperature is null or target_temperature not in ('all', 'HOT', 'WARM', 'COLD', 'DORMANT')
    or target_sort is null or target_sort not in (
      'updated:desc', 'updated:asc', 'created:desc', 'created:asc',
      'customer:asc', 'customer:desc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)
  then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_WORKSPACE_QUERY';
  end if;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) into actor_is_sales_consultant;

  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = target_actor_id
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) into actor_is_telecaller;

  normalized_search := left(
    btrim(regexp_replace(coalesce(target_search, ''), '[^[:alnum:] @+_-]+', '', 'g')),
    160
  );
  search_phone_digits := coalesce(
    app_private.normalize_phone_digits(normalized_search),
    ''
  );
  normalized_model := nullif(left(btrim(coalesce(target_model, '')), 160), '');
  normalized_source := nullif(left(btrim(coalesce(target_source, '')), 100), '');
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_lead_id := normalized_search::uuid;
  end if;
  if target_followup_from is not null then
    followup_from_at := pg_catalog.timezone(
      'Asia/Kolkata',
      target_followup_from::timestamp
    );
  end if;
  if target_followup_to is not null then
    followup_to_exclusive_at := pg_catalog.timezone(
      'Asia/Kolkata',
      (target_followup_to + 1)::timestamp
    );
  end if;

  if actor_is_telecaller then
    select coalesce(array_agg(distinct history_row.lead_id), array[]::uuid[])
      into telecaller_handoff_lead_ids
    from public.lead_assignment_history history_row
    where history_row.organization_id = target_organization_id
      and history_row.previous_owner_id = target_actor_id
      and history_row.new_owner_id is not null
      and exists (
        select 1
        from public.lead_stage_history stage_row
        where stage_row.organization_id = target_organization_id
          and stage_row.lead_id = history_row.lead_id
          and stage_row.to_status = 'Transferred to Sales'
      );
  end if;

  select coalesce(array_agg(preference_row.lead_id order by preference_row.pinned_at desc), '{}'::uuid[])
  into pinned_lead_ids
  from (
    select preference_row.lead_id, preference_row.pinned_at
    from public.user_lead_preferences preference_row
    where preference_row.organization_id = target_organization_id
      and preference_row.user_id = target_actor_id
      and preference_row.pinned
    order by preference_row.pinned_at desc
    limit 200
  ) preference_row;

  window_needed := target_page::bigint * target_page_size;
  if target_include_records and not target_include_kpis
    and window_needed <= 5000
  then
    window_size := greatest(window_needed * 4, 200)::integer;
    window_exhausted := false;
    walk_order := case target_sort
      when 'updated:desc' then 'lead_row.updated_at desc, lead_row.id desc'
      when 'updated:asc' then 'lead_row.updated_at asc, lead_row.id desc'
      when 'created:desc' then 'lead_row.created_at desc, lead_row.id desc'
      when 'created:asc' then 'lead_row.created_at asc, lead_row.id desc'
      when 'customer:asc' then 'lead_row.customer_name asc, lead_row.id desc'
      when 'customer:desc' then 'lead_row.customer_name desc, lead_row.id desc'
    end;
    -- The walk may cover more leads than the workspace scope -- scoped_leads
    -- re-applies the exact predicate -- but never fewer: every in-scope lead
    -- that sorts before the window's last lead must be in the window.
    walk_scope := case when target_organization_wide then 'true' else concat_ws(' or ',
      case when cardinality(coalesce(target_branch_scope_ids, '{}')) > 0
        then 'lead_row.branch_id = any($5)' end,
      case when cardinality(coalesce(target_team_scope_ids, '{}')) > 0
        then 'lead_row.team_id = any($6)' end,
      case when target_owner_scope then
        '(lead_row.branch_id = any($8) and (lead_row.assigned_user_id = $3'
        || case when cardinality(telecaller_handoff_lead_ids) > 0
          then ' or lead_row.id = any($9)' else '' end
        || '))' end,
      'false'
    ) end;
    -- Column filters every matching lead must satisfy, so the walk skips leads
    -- that can never be paged. Each is implied by the exact filter applied later.
    walk_scope := '(' || walk_scope || ')'
      || case when target_status in ('hot', 'warm', 'cold')
        then ' and lead_row.temperature::text = ' || quote_literal(upper(target_status)) else '' end
      || case when target_temperature <> 'all'
        then ' and lead_row.temperature::text = ' || quote_literal(target_temperature) else '' end
      || case target_status
        when 'new' then ' and lead_row.lifecycle_status::text = ''New'''
        when 'contacted' then ' and lead_row.lifecycle_status::text = ''Contacted'''
        when 'qualified' then ' and lead_row.lifecycle_status::text = ''Qualified'''
        when 'appointment-scheduled' then ' and lead_row.lifecycle_status::text = ''Appointment Scheduled'''
        when 'transferred-to-sales' then ' and lead_row.lifecycle_status::text = ''Transferred to Sales'''
        when 'lost' then ' and lead_row.lifecycle_status::text = ''Lost'''
        else '' end
      || case when normalized_model is not null
        then ' and lead_row.interested_model = ' || quote_literal(normalized_model) else '' end
      || case when normalized_source is not null
        then ' and lead_row.source = ' || quote_literal(normalized_source) else '' end
      || case when followup_from_at is not null
        then ' and lead_row.next_followup_at >= ' || quote_literal(followup_from_at::text) || '::timestamptz' else '' end
      || case when followup_to_exclusive_at is not null
        then ' and lead_row.next_followup_at < ' || quote_literal(followup_to_exclusive_at::text) || '::timestamptz' else '' end
      -- The same search predicate filtered_lead_ids applies; the name arm can
      -- use the trigram index, so a search no longer reads the whole scope.
      || case when normalized_search <> '' then
        ' and (lead_row.id = $10'
        || ' or lower(lead_row.customer_name) like $11 escape ' || quote_literal(chr(92))
        || case when search_phone_digits <> ''
          then ' or lead_row.normalized_phone = $12 or lead_row.normalized_phone like $12 || ''%'' or lead_row.normalized_phone like ''+'' || $12 || ''%'' or lead_row.normalized_phone like ''+91'' || nullif(ltrim($12, ''0''), '''') || ''%'' or lead_row.normalized_phone like ''91'' || nullif(ltrim($12, ''0''), '''') || ''%''' else '' end
        || ')' else '' end;
    walk_sql := format($walk$
      select
        coalesce(array_agg(walk.id order by walk.rn), '{}'::uuid[]),
        count(*)::integer,
        (array_agg(walk.id order by walk.rn desc))[1],
        (array_agg(walk.updated_at order by walk.rn desc))[1],
        (array_agg(walk.created_at order by walk.rn desc))[1],
        (array_agg(walk.customer_name order by walk.rn desc))[1]
      from (
        select lead_row.id, lead_row.updated_at, lead_row.created_at, lead_row.customer_name,
          row_number() over (order by %1$s) as rn
        from public.leads lead_row
        where lead_row.organization_id = $1
          and lead_row.deleted_at is null
          and (%2$s)
          and (
            not $2
            or (
              lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
              and (
                lead_row.assigned_user_id = $3
                or exists (
                  select 1 from app_private.lead_sales_facts fact_row
                  where fact_row.lead_id = lead_row.id
                    and fact_row.sales_handoff_at is not null
                )
              )
            )
          )
        order by %1$s
        limit $4
      ) walk
    $walk$, walk_order, walk_scope);
  end if;

  loop
    if not window_exhausted then
      execute walk_sql
        into walk_ids, window_rows, window_last_id,
          window_last_updated, window_last_created, window_last_name
        using target_organization_id, actor_is_sales_consultant, target_actor_id,
          window_size, target_branch_scope_ids, target_team_scope_ids,
          target_owner_scope, target_owner_branch_ids, telecaller_handoff_lead_ids,
          search_lead_id,
          '%' || replace(lower(normalized_search), '_', E'\\_') || '%',
          search_phone_digits;
      if window_rows < window_size then
        -- The walk reached the end of the scope: the window is the scope.
        window_exhausted := true;
        window_last_id := null;
      end if;
      -- Pins always page first, and every phone group touched by the window
      -- must be complete for group heads and phone_lead_count to be exact.
      select coalesce(array_agg(distinct member_id), '{}'::uuid[])
        into candidate_lead_ids
      from (
        select unnest(walk_ids || pinned_lead_ids) as member_id
        union
        select sibling_row.id
        from public.leads sibling_row
        where sibling_row.organization_id = target_organization_id
          and sibling_row.deleted_at is null
          and sibling_row.normalized_phone <> ''
          and sibling_row.normalized_phone in (
            select member_row.normalized_phone
            from public.leads member_row
            where member_row.id = any(walk_ids || pinned_lead_ids)
              and member_row.organization_id = target_organization_id
              and member_row.normalized_phone <> ''
          )
      ) members;
    end if;

    result := (
    with pinned_leads as materialized (
      select
        pin_id as lead_id,
        pin_rank
      from unnest(pinned_lead_ids) with ordinality as pins(pin_id, pin_rank)
    ), scoped_leads as materialized (
      select
        lead_row.id,
        lead_row.source,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        lead_row.first_contacted_at,
        lead_row.sla_due_at,
        lead_row.created_at,
        lead_row.updated_at,
        count(*) over (partition by coalesce(
          nullif(lead_row.normalized_phone, ''),
          lead_row.id::text
        )) as phone_lead_count,
        lead_row.next_followup_at,
        actor_is_telecaller and (lead_row.id = any(telecaller_handoff_lead_ids) and lead_row.assigned_user_id is distinct from target_actor_id) as is_handoff_read_only,
        fact_row.sales_handoff_at,
        fact_row.sales_contacted_at,
        coalesce(fact_row.has_test_drive, false) as has_test_drive,
        coalesce(fact_row.has_quotation, false) as has_quotation,
        coalesce(fact_row.has_booking, false) as has_booking,
        case
          when lead_row.lifecycle_status = 'Lost' then null
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and query_now > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and lead_row.created_at < pg_catalog.timezone('Asia/Kolkata', date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))) then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      -- Two branches gated by one-time filters: a window is fetched by primary
      -- key, the full scope by the usual scan. A single OR here would scan the
      -- whole scope even for a 200-lead window.
      from (
        select window_row.* from public.leads window_row
        where candidate_lead_ids is not null and window_row.id = any(candidate_lead_ids)
        union all
        select scope_row.* from public.leads scope_row
        where candidate_lead_ids is null and scope_row.organization_id = target_organization_id
      ) lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      left join app_private.lead_sales_facts fact_row on fact_row.lead_id = lead_row.id
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
        and (
          not actor_is_sales_consultant
          or (
            lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
            and (
              lead_row.assigned_user_id = target_actor_id
              or fact_row.sales_handoff_at is not null
            )
          )
        )
        and (
          target_organization_wide
          or lead_row.branch_id = any(target_branch_scope_ids)
          or (
            lead_row.team_id is not null
            and lead_row.team_id = any(target_team_scope_ids)
          )
          or (
            target_owner_scope
            and lead_row.branch_id = any(target_owner_branch_ids)
            and (
              lead_row.assigned_user_id = target_actor_id
              or (
                actor_is_telecaller
                and (lead_row.id = any(telecaller_handoff_lead_ids) and lead_row.assigned_user_id is distinct from target_actor_id)
              )
            )
          )
        )
    ), staged_leads as materialized (
      select
        lead_row.*,
        case
          when lead_row.lifecycle_status = 'Lost' then 'Lost'
          when lead_row.has_booking then 'Booking'
          when lead_row.has_quotation then 'Quotation'
          when lead_row.has_test_drive then 'Test Drive'
          when actor_is_sales_consultant
            and lead_row.lifecycle_status = 'Transferred to Sales'
            and lead_row.sales_contacted_at >= lead_row.sales_handoff_at then 'Sales Contacted'
          else lead_row.lifecycle_status::text
        end as lead_stage
      from scoped_leads lead_row
    ), filtered_lead_ids as materialized (
      select
        lead_row.id,
        lead_row.updated_at,
        lead_row.created_at,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.lifecycle_status
      from staged_leads lead_row
      where (
        not lead_row.is_handoff_read_only
        or target_status in ('all', 'transferred-to-sales', 'starred')
      )
      and (
        target_status = 'all'
        or (target_status = 'hot' and lead_row.temperature = 'HOT')
        or (target_status = 'starred' and exists (
          select 1
          from public.user_lead_preferences starred_row
          where starred_row.organization_id = target_organization_id
            and starred_row.user_id = target_actor_id
            and starred_row.lead_id = lead_row.id
            and starred_row.starred
        ))
        or (target_status = 'warm' and lead_row.temperature = 'WARM')
        or (target_status = 'cold' and lead_row.temperature = 'COLD')
        or (target_status = 'follow-up' and lead_row.next_followup_at is not null
          and lead_row.lifecycle_status <> 'Lost'
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking)
        or (target_status = 'test-drive' and lead_row.has_test_drive and not lead_row.has_quotation and not lead_row.has_booking and lead_row.lifecycle_status <> 'Lost')
        or (target_status = 'quotation' and lead_row.has_quotation and not lead_row.has_booking and lead_row.lifecycle_status <> 'Lost')
        or (target_status = 'booking' and lead_row.has_booking and lead_row.lifecycle_status <> 'Lost')
        or (target_status = 'new' and lead_row.lifecycle_status = 'New')
        or (target_status = 'contacted' and lead_row.lifecycle_status = 'Contacted'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.next_followup_at is null)
        or (target_status = 'qualified' and lead_row.lifecycle_status = 'Qualified')
        or (target_status = 'appointment-scheduled'
          and lead_row.lifecycle_status = 'Appointment Scheduled'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking)
        or (target_status = 'transferred-to-sales'
          and lead_row.lifecycle_status = 'Transferred to Sales')
        or (target_status = 'lost' and lead_row.lifecycle_status = 'Lost')
        or (
          target_status = 'new-today'
          and (
            (
              actor_is_sales_consultant
              and lead_row.sales_handoff_at >= pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
              and lead_row.sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now)) + interval '1 day'
              )
            )
            or (not actor_is_sales_consultant and lead_row.work_state = 'NEW_TODAY')
          )
        )
        or (target_status = 'pending' and lead_row.work_state = 'PENDING')
        or (target_status = 'sla-risk' and lead_row.work_state = 'SLA_RISK')
        or (
          target_status = 'sales-new'
          and actor_is_sales_consultant
          and lead_row.lifecycle_status <> 'Lost'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and lead_row.next_followup_at is null
          and lead_row.sales_handoff_at >= pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and lead_row.sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              ) + interval '1 day'
          and (lead_row.sales_contacted_at is null or lead_row.sales_contacted_at < lead_row.sales_handoff_at)
        )
        or (
          target_status = 'sales-pending'
          and actor_is_sales_consultant
          and lead_row.lifecycle_status <> 'Lost'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and lead_row.next_followup_at is null
          and lead_row.sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and (lead_row.sales_contacted_at is null or lead_row.sales_contacted_at < lead_row.sales_handoff_at)
        )
        or (
          target_status = 'sales-contacted'
          and actor_is_sales_consultant
          and lead_row.lifecycle_status <> 'Lost'
          and not lead_row.has_test_drive
          and not lead_row.has_quotation
          and not lead_row.has_booking
          and lead_row.lifecycle_status <> 'Appointment Scheduled'
          and lead_row.next_followup_at is null
          and lead_row.sales_contacted_at >= lead_row.sales_handoff_at
        )
      )
      and (normalized_model is null or lead_row.interested_model = normalized_model)
      and (normalized_source is null or lead_row.source = normalized_source)
      and (target_stage = 'all' or lead_row.lead_stage = target_stage)
      and (target_temperature = 'all' or lead_row.temperature::text = target_temperature)
      and (followup_from_at is null or lead_row.next_followup_at >= followup_from_at)
      and (
        followup_to_exclusive_at is null
        or lead_row.next_followup_at < followup_to_exclusive_at
      )
      and (
        normalized_search = ''
        or lead_row.id = search_lead_id
        -- `_` is valid sanitized input but is also a LIKE wildcard. Escape it so
        -- a literal underscore cannot turn a narrow name search into an
        -- accidental full-scope match.
        or lower(lead_row.customer_name) like
          '%' || replace(lower(normalized_search), '_', E'\\_') || '%'
          escape E'\\'
        or (
          search_phone_digits <> ''
          and (
            lead_row.normalized_phone = search_phone_digits
            or lead_row.normalized_phone like search_phone_digits || '%' or lead_row.normalized_phone like '+' || search_phone_digits || '%' or lead_row.normalized_phone like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%' or lead_row.normalized_phone like '91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'
          )
        )
      )
    ), phone_group_lead_ids as materialized (
      select distinct on (
        coalesce(nullif(lead_row.normalized_phone, ''), lead_row.id::text)
      )
        lead_row.id,
        lead_row.updated_at,
        lead_row.created_at,
        lead_row.customer_name,
        lead_row.normalized_phone,
        lead_row.lifecycle_status
      from filtered_lead_ids lead_row
      order by
        coalesce(nullif(lead_row.normalized_phone, ''), lead_row.id::text),
        case
          when lead_row.lifecycle_status = 'Lost' then 2
          when lead_row.lifecycle_status = 'Transferred to Sales'
            and not actor_is_sales_consultant then 1
          else 0
        end,
        lead_row.created_at desc,
        lead_row.id desc
    ), page_ids as materialized (
      select lead_row.id
      from phone_group_lead_ids lead_row
      left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
      where target_include_records
        and (
        window_last_id is null
        or pin_row.lead_id is not null
        or case target_sort
          when 'updated:desc' then lead_row.updated_at > window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'updated:asc' then lead_row.updated_at < window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'created:desc' then lead_row.created_at > window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'created:asc' then lead_row.created_at < window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'customer:asc' then lead_row.customer_name < window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end
      )
      order by
        pin_row.pin_rank asc nulls last,
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,
        case when target_sort = 'updated:desc' then lead_row.updated_at end desc nulls last,
        case when target_sort = 'created:asc' then lead_row.created_at end asc nulls last,
        case when target_sort = 'created:desc' then lead_row.created_at end desc nulls last,
        case when target_sort = 'customer:asc' then lead_row.customer_name end asc nulls last,
        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        lead_row.id desc
      limit target_page_size
      offset ((target_page - 1)::bigint * target_page_size)
    ), page_rows as materialized (
      select
        lead_row.id,
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.customer_id,
        lead_row.source,
        lead_row.customer_name,
        lead_row.phone,
        lead_row.normalized_phone,
        lead_row.email,
        lead_row.interested_model,
        lead_row.lifecycle_status,
        lead_row.temperature,
        lead_row.lost_reason,
        lead_row.assigned_user_id,
        stage_row.is_handoff_read_only,
        stage_row.work_state,
        stage_row.lead_stage,
        lead_row.first_contacted_at,
        lead_row.sla_due_at,
        lead_row.next_followup_at,
        stage_row.sales_handoff_at,
        stage_row.sales_contacted_at,
        lead_row.created_at,
        lead_row.updated_at,
        profile_row.full_name as assigned_user_name,
        case when exists (
          select 1
          from public.user_role_assignments consultant_assignment
          join public.roles consultant_role
            on consultant_role.id = consultant_assignment.role_id
           and consultant_role.organization_id = consultant_assignment.organization_id
          where consultant_assignment.organization_id = lead_row.organization_id
            and consultant_assignment.user_id = lead_row.assigned_user_id
            and consultant_assignment.active
            and consultant_role.role_key = 'sales_consultant'
        ) then profile_row.full_name end as assigned_consultant_name,
        -- A consultant's group badge counts the same-mobile leads that
        -- get_lead_phone_history returns to them, so it matches what expands.
        case
          when actor_is_sales_consultant and lead_row.normalized_phone <> '' then greatest(
            stage_row.phone_lead_count,
            (
              select count(*)
              from public.leads sibling_row
              where sibling_row.organization_id = target_organization_id
                and sibling_row.normalized_phone = lead_row.normalized_phone
                and sibling_row.deleted_at is null
                and (
                  target_organization_wide
                  or sibling_row.branch_id = any(target_branch_scope_ids)
                  or sibling_row.branch_id = any(target_owner_branch_ids)
                )
                and (
                  sibling_row.assigned_user_id = target_actor_id
                  or not exists (
                  select 1
                  from public.user_role_assignments sibling_owner_assignment
                  join public.roles sibling_owner_role
                    on sibling_owner_role.id = sibling_owner_assignment.role_id
                   and sibling_owner_role.organization_id = sibling_owner_assignment.organization_id
                  where sibling_owner_assignment.organization_id = target_organization_id
                    and sibling_owner_assignment.user_id = sibling_row.assigned_user_id
                    and sibling_owner_assignment.active
                    and sibling_owner_role.role_key = 'sales_consultant'
                )
                )
            )
          )
          else stage_row.phone_lead_count
        end as phone_lead_count,
        -- Who handed this lead to its current owner: shown to a Sales
        -- Consultant as "from <telecaller>". Per page row only.
        (
          select handoff_profile.full_name
          from public.lead_assignment_history handoff_row
          join public.profiles handoff_profile
            on handoff_profile.id = handoff_row.previous_owner_id
           and handoff_profile.organization_id = handoff_row.organization_id
          where handoff_row.organization_id = lead_row.organization_id
            and handoff_row.lead_id = lead_row.id
            and handoff_row.new_owner_id = lead_row.assigned_user_id
            and handoff_row.previous_owner_id is not null
            and handoff_row.previous_owner_id <> lead_row.assigned_user_id
          order by handoff_row.created_at desc, handoff_row.id desc
          limit 1
        ) as handed_off_by_name
      from page_ids page_id
      join staged_leads stage_row on stage_row.id = page_id.id
      join public.leads lead_row
        on lead_row.organization_id = target_organization_id
       and lead_row.id = page_id.id
       and lead_row.deleted_at is null
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
       and profile_row.active
       and profile_row.deleted_at is null
    ), kpis as (
      select
        count(*)::bigint as total,
        count(*) filter (where temperature = 'HOT')::bigint as hot,
        count(*) filter (where temperature = 'WARM')::bigint as warm,
        count(*) filter (where temperature = 'COLD')::bigint as cold,
        count(*) filter (where next_followup_at is not null
          and lifecycle_status <> 'Lost'
          and lifecycle_status <> 'Appointment Scheduled'
          and not has_test_drive
          and not has_quotation
          and not has_booking)::bigint as follow_up,
        count(*) filter (where has_test_drive and not has_quotation and not has_booking and lifecycle_status <> 'Lost')::bigint as test_drive,
        count(*) filter (where has_quotation and not has_booking and lifecycle_status <> 'Lost')::bigint as quotation,
        count(*) filter (where has_booking and lifecycle_status <> 'Lost')::bigint as booking,
        count(*) filter (where (
          actor_is_sales_consultant
          and sales_handoff_at >= pg_catalog.timezone(
            'Asia/Kolkata',
            date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
          )
          and sales_handoff_at < pg_catalog.timezone(
            'Asia/Kolkata',
            date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now)) + interval '1 day'
          )
        ) or (not actor_is_sales_consultant and work_state = 'NEW_TODAY'))::bigint as new_today,
        count(*) filter (where work_state = 'PENDING')::bigint as pending,
        count(*) filter (where work_state = 'SLA_RISK')::bigint as sla_risk,
        count(*) filter (where lifecycle_status = 'Qualified')::bigint as qualified,
        count(*) filter (where lifecycle_status = 'New')::bigint as new_count,
        count(*) filter (
          where lifecycle_status = 'Contacted'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and next_followup_at is null
        )::bigint as contacted_count,
        count(*) filter (
          where lifecycle_status = 'Appointment Scheduled'
            and not has_test_drive
            and not has_quotation
            and not has_booking
        )::bigint as appointment_scheduled_count,
        count(*) filter (
          where lifecycle_status = 'Transferred to Sales'
        )::bigint as transferred_to_sales_count,
        count(*) filter (where lifecycle_status = 'Lost')::bigint as lost_count,
        count(*) filter (where actor_is_sales_consultant
          and lifecycle_status <> 'Lost'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and lifecycle_status <> 'Appointment Scheduled'
          and next_followup_at is null
          and sales_handoff_at >= pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              ) + interval '1 day'
          and (sales_contacted_at is null or sales_contacted_at < sales_handoff_at))::bigint as sales_new_today,
        count(*) filter (where actor_is_sales_consultant
          and lifecycle_status <> 'Lost'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and lifecycle_status <> 'Appointment Scheduled'
          and next_followup_at is null
          and sales_handoff_at < pg_catalog.timezone(
                'Asia/Kolkata',
                date_trunc('day', pg_catalog.timezone('Asia/Kolkata', query_now))
              )
          and (sales_contacted_at is null or sales_contacted_at < sales_handoff_at))::bigint as sales_pending,
        count(*) filter (where actor_is_sales_consultant
          and lifecycle_status <> 'Lost'
          and not has_test_drive
          and not has_quotation
          and not has_booking
          and lifecycle_status <> 'Appointment Scheduled'
          and next_followup_at is null
          and sales_contacted_at >= sales_handoff_at)::bigint as sales_contacted,
        count(*) filter (where exists (
          select 1
          from public.user_lead_preferences starred_kpi_row
          where starred_kpi_row.organization_id = target_organization_id
            and starred_kpi_row.user_id = target_actor_id
            and starred_kpi_row.lead_id = staged_leads.id
            and starred_kpi_row.starred
        ))::bigint as starred_count
      from staged_leads
      where target_include_kpis
    )
    select jsonb_build_object(
      'window_eligible', case when window_last_id is null then null else (
        select count(*)
        from phone_group_lead_ids lead_row
        left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
        where (
        window_last_id is null
        or pin_row.lead_id is not null
        or case target_sort
          when 'updated:desc' then lead_row.updated_at > window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'updated:asc' then lead_row.updated_at < window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'created:desc' then lead_row.created_at > window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'created:asc' then lead_row.created_at < window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'customer:asc' then lead_row.customer_name < window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end
      )
      ) end,
      'records', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id,
          'organization_id', organization_id,
          'branch_id', branch_id,
          'team_id', team_id,
          'customer_id', customer_id,
          'source', source,
          'customer_name', customer_name,
          'phone', phone,
          'normalized_phone', normalized_phone,
          'email', email,
          'interested_model', interested_model,
          'lifecycle_status', lifecycle_status,
          'temperature', temperature,
          'lost_reason', lost_reason,
          'work_state', work_state,
          'lead_stage', lead_stage,
          'assigned_user_id', assigned_user_id,
          'assigned_user_name', assigned_user_name,
          'assigned_consultant_name', assigned_consultant_name,
          'handed_off_by_name', handed_off_by_name,
          'read_only', is_handoff_read_only,
          'phone_lead_count', phone_lead_count,
          'first_contacted_at', first_contacted_at,
          'sla_due_at', sla_due_at,
          'next_followup_at', next_followup_at,
          'created_at', created_at,
          'updated_at', updated_at
        ) order by
          (select pin_row.pin_rank from pinned_leads pin_row where pin_row.lead_id = page_rows.id)
            asc nulls last,
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,
          case when target_sort = 'updated:desc' then updated_at end desc nulls last,
          case when target_sort = 'created:asc' then created_at end asc nulls last,
          case when target_sort = 'created:desc' then created_at end desc nulls last,
          case when target_sort = 'customer:asc' then customer_name end asc nulls last,
          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          id desc
        )
        from page_rows
      ), '[]'::jsonb),
      'total', case
        when target_include_kpis then (select count(*) from phone_group_lead_ids)
        else null
      end,
      'lead_total', case
        when target_include_kpis then (select count(*) from filtered_lead_ids)
        else null
      end,
      'kpis', case when target_include_kpis then (select to_jsonb(kpis) from kpis) else null end,
      'filters', case when not target_include_kpis then null else jsonb_build_object(
        'models', coalesce((
          select jsonb_agg(model_name order by model_name)
          from (
            select distinct interested_model as model_name
            from scoped_leads
            where nullif(btrim(interested_model), '') is not null
            order by interested_model
            limit 100
          ) model_options
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(source_name order by source_name)
          from (
            select distinct source as source_name
            from scoped_leads
            where nullif(btrim(source), '') is not null
            order by source
            limit 100
          ) source_options
        ), '[]'::jsonb)
      ) end
    )
    );
    exit when window_exhausted
      or (result->>'window_eligible')::bigint >= window_needed;
    -- Not enough heads before the window's end: widen it, and past a bound
    -- evaluate the whole scope instead.
    window_size := window_size * 4;
    if window_size > 20000 then
      window_exhausted := true;
      window_last_id := null;
      candidate_lead_ids := null;
    end if;
  end loop;
  return result - 'window_eligible';
end;
$function$;

commit;
