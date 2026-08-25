begin;

-- Repairs 202608250009, which read data_scope from public.roles. The column
-- lives on public.user_role_assignments, so create_lead raised
-- `column role_row.data_scope does not exist` on every call.
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
      target_organization_id, new_lead_id, target_branch_id, target_team_id,
      null, selected_user_id, auth.uid(),
      case when self_assigned then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end::public.assignment_mode,
      case
        when self_assigned then 'Manually created by the owning consultant'
        else 'Automatic fresh lead assignment'
      end
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
