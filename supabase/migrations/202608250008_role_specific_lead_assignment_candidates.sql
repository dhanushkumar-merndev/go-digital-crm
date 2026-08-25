begin;

-- Team Managers do not search a tenant-wide profile list. Intake is routed to
-- active Telecallers; after qualification, the lead can go only to Sales.
create or replace function public.get_lead_assignment_candidates(
  target_lead_id uuid,
  target_search text default ''
)
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_lead public.leads%rowtype;
  normalized_search text;
  handoff_to_sales boolean;
begin
  if target_lead_id is null then
    raise exception using errcode = '22023', message = 'LEAD_ID_REQUIRED';
  end if;
  normalized_search := left(btrim(coalesce(target_search, '')), 160);

  select * into target_lead
  from public.leads lead_row
  where lead_row.id = target_lead_id
    and lead_row.deleted_at is null;
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

  handoff_to_sales := target_lead.lifecycle_status = 'Qualified'
    or exists (
      select 1
      from public.lead_stage_history history_row
      where history_row.organization_id = target_lead.organization_id
        and history_row.lead_id = target_lead.id
        and history_row.to_status = 'Transferred to Sales'
    );

  return query
  select distinct profile_row.id, profile_row.full_name
  from public.team_members member_row
  join public.profiles profile_row
    on profile_row.id = member_row.user_id
   and profile_row.organization_id = member_row.organization_id
  join public.user_role_assignments role_assignment
    on role_assignment.organization_id = member_row.organization_id
   and role_assignment.user_id = member_row.user_id
   and role_assignment.active
  join public.roles role_row on role_row.id = role_assignment.role_id
  where member_row.organization_id = target_lead.organization_id
    and member_row.team_id = target_lead.team_id
    and member_row.active
    and profile_row.active
    and profile_row.deleted_at is null
    and (
      (handoff_to_sales
        and member_row.eligible_for_qualified_leads
        and role_row.role_key = 'sales_consultant')
      or (
        not handoff_to_sales
        and member_row.eligible_for_fresh_leads
        and role_row.role_key = 'telecaller_bdc'
      )
    )
    and (
      normalized_search = ''
      or profile_row.full_name ilike '%' || normalized_search || '%'
    )
  order by profile_row.full_name, profile_row.id
  limit 25;
end;
$$;

revoke all on function public.get_lead_assignment_candidates(uuid, text) from public, anon;
grant execute on function public.get_lead_assignment_candidates(uuid, text) to authenticated;

create or replace function app_private.enforce_sales_lead_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_is_sales_consultant boolean;
  target_is_telecaller boolean;
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
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row on role_row.id = assignment_row.role_id
    where assignment_row.organization_id = new.organization_id
      and assignment_row.user_id = new.assigned_user_id
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) into target_is_telecaller;

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

  if current_lifecycle = 'Qualified' or has_prior_sales_handoff then
    if not target_is_sales_consultant or new.assignment_type <> 'QUALIFIED' then
      raise exception using errcode = '23514', message = 'SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD';
    end if;
  elsif not target_is_telecaller or new.assignment_type <> 'FRESH' then
    raise exception using errcode = '23514', message = 'FRESH_ASSIGNMENT_REQUIRES_TELECALLER';
  end if;

  return new;
end;
$$;

commit;
