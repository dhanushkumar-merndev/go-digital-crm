begin;

-- A Sales Consultant could not add a lead at all.
--
-- `create_lead` self-assigns a manually entered lead to its author
-- (202608250009), so it writes a `lead_assignments` row whose assignee is the
-- acting consultant. That insert hits `lead_assignments_sales_handoff_guard`,
-- and the guard's first rule rejects *any* assignment inserted by a Sales
-- Consultant -- SALES_CONSULTANT_CANNOT_ASSIGN_LEADS. Every consultant-created
-- lead therefore rolled back, and because that code names no field the dialog
-- fell through to the generic "check the permitted branch and required fields".
--
-- This was the next failure in line behind the ones 202608290006/7/8 fixed:
-- the leads-table trigger rejected the row first, so the assignment insert was
-- never reached until the team/branch resolution was repaired.
--
-- The rule exists so a consultant cannot pull leads towards themselves or push
-- them at a colleague. Recording an enquiry that is already theirs is neither.
-- Both role rules are relaxed for exactly that row and nothing else:
--
--   * `app.create_lead_rpc` is set, transaction-locally, only by `create_lead`,
--     so a direct insert into `lead_assignments` cannot claim the exemption;
--   * the assignee and the assigner are both the acting user, so the exemption
--     can never move a lead between two people.
--
-- The FRESH/QUALIFIED routing rule is skipped for the same row for the same
-- reason: a self-created consultant lead is FRESH while its assignee is a Sales
-- Consultant rather than a Telecaller, and it is already 'Transferred to Sales'
-- without the Qualified intake it legitimately never went through.
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
  actor_created_own_lead boolean;
  current_lifecycle public.lead_lifecycle;
  has_prior_sales_handoff boolean;
begin
  if not new.active then
    return new;
  end if;

  -- The author of a manually created lead recording that it is theirs.
  actor_created_own_lead :=
    coalesce(current_setting('app.create_lead_rpc', true), '') = 'on'
    and auth.uid() is not null
    and new.assigned_user_id = auth.uid()
    and new.assigned_by = auth.uid();
  if actor_created_own_lead then
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
