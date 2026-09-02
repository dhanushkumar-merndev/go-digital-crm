-- Untouched duplicate leads may be submitted for Team Manager approval.
-- Approval is deliberately a soft delete: the original lead, decision, actor,
-- retained opportunity and audit evidence remain available to the backend.

create table public.lead_duplicate_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  team_id uuid references public.teams(id),
  lead_id uuid not null references public.leads(id),
  retained_lead_id uuid not null references public.leads(id),
  requested_by uuid not null references public.profiles(id),
  reason text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by uuid references public.profiles(id),
  review_note text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint lead_duplicate_request_distinct_leads check (lead_id <> retained_lead_id),
  constraint lead_duplicate_request_reason_length
    check (char_length(btrim(reason)) between 5 and 500),
  constraint lead_duplicate_request_decision_shape check (
    (status = 'PENDING' and reviewed_by is null and decided_at is null)
    or (status in ('APPROVED', 'REJECTED') and reviewed_by is not null and decided_at is not null)
  ),
  constraint lead_duplicate_request_branch_org_fk
    foreign key (organization_id, branch_id)
    references public.branches (organization_id, id),
  constraint lead_duplicate_request_team_org_fk
    foreign key (organization_id, branch_id, team_id)
    references public.teams (organization_id, branch_id, id),
  constraint lead_duplicate_request_lead_org_fk
    foreign key (organization_id, lead_id)
    references public.leads (organization_id, id),
  constraint lead_duplicate_request_retained_lead_org_fk
    foreign key (organization_id, retained_lead_id)
    references public.leads (organization_id, id),
  constraint lead_duplicate_request_requester_org_fk
    foreign key (organization_id, requested_by)
    references public.profiles (organization_id, id),
  constraint lead_duplicate_request_reviewer_org_fk
    foreign key (organization_id, reviewed_by)
    references public.profiles (organization_id, id)
);

create unique index lead_duplicate_request_one_pending_idx
  on public.lead_duplicate_deletion_requests (organization_id, lead_id)
  where status = 'PENDING';
create index lead_duplicate_request_manager_queue_idx
  on public.lead_duplicate_deletion_requests
    (organization_id, status, team_id, requested_at desc, id);
create index lead_duplicate_request_requester_idx
  on public.lead_duplicate_deletion_requests
    (organization_id, requested_by, requested_at desc, id);

alter table public.leads
  add column if not exists duplicate_of_lead_id uuid,
  add column if not exists duplicate_deletion_request_id uuid,
  add column if not exists deleted_by uuid,
  add column if not exists deletion_reason text;

alter table public.leads
  add constraint leads_duplicate_of_org_fk
  foreign key (organization_id, duplicate_of_lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.leads
  add constraint leads_duplicate_deletion_request_fk
  foreign key (duplicate_deletion_request_id)
  references public.lead_duplicate_deletion_requests(id) not valid;
alter table public.leads
  add constraint leads_deleted_by_org_fk
  foreign key (organization_id, deleted_by)
  references public.profiles (organization_id, id) not valid;

alter table public.lead_duplicate_deletion_requests enable row level security;

-- RPCs are the mutation boundary. The read policy still keeps direct reads
-- tenant/scope constrained if select access is granted by a future migration.
create policy lead_duplicate_request_read on public.lead_duplicate_deletion_requests
for select to authenticated using (
  requested_by = auth.uid()
  or (
    exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = lead_duplicate_deletion_requests.organization_id
        and assignment_row.active
        and role_row.role_key = 'team_manager'
    )
    and app_private.can_access_record(
      organization_id,
      branch_id,
      team_id,
      null
    )
  )
);

create or replace function app_private.is_team_manager(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.user_id = auth.uid()
      and assignment_row.organization_id = target_organization_id
      and assignment_row.active
      and role_row.role_key = 'team_manager'
  );
$$;

create or replace function app_private.is_untouched_duplicate_lead(
  target_lead_id uuid,
  target_retained_lead_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.leads duplicate_lead
    join public.leads retained_lead
      on retained_lead.id = target_retained_lead_id
     and retained_lead.organization_id = duplicate_lead.organization_id
     and retained_lead.deleted_at is null
     and nullif(retained_lead.normalized_phone, '') = duplicate_lead.normalized_phone
     and (retained_lead.created_at, retained_lead.id) <
       (duplicate_lead.created_at, duplicate_lead.id)
    where duplicate_lead.id = target_lead_id
      and duplicate_lead.deleted_at is null
      and duplicate_lead.lifecycle_status = 'New'
      and duplicate_lead.first_contacted_at is null
      and duplicate_lead.next_followup_at is null
      and duplicate_lead.lost_reason is null
      and nullif(duplicate_lead.normalized_phone, '') is not null
      and not exists (
        select 1 from public.lead_stage_history history_row
        where history_row.organization_id = duplicate_lead.organization_id
          and history_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.activities activity_row
        where activity_row.organization_id = duplicate_lead.organization_id
          and activity_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.followups followup_row
        where followup_row.organization_id = duplicate_lead.organization_id
          and followup_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.calls call_row
        where call_row.organization_id = duplicate_lead.organization_id
          and call_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.conversations conversation_row
        where conversation_row.organization_id = duplicate_lead.organization_id
          and conversation_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.notes note_row
        where note_row.organization_id = duplicate_lead.organization_id
          and lower(note_row.resource_type) = 'lead'
          and note_row.resource_id = duplicate_lead.id
          and note_row.deleted_at is null
      )
      and not exists (
        select 1 from public.tasks task_row
        where task_row.organization_id = duplicate_lead.organization_id
          and (
            (lower(coalesce(task_row.resource_type, '')) = 'lead'
              and task_row.resource_id = duplicate_lead.id)
            or task_row.lead_id = duplicate_lead.id
          )
      )
      and not exists (
        select 1 from public.appointments appointment_row
        where appointment_row.organization_id = duplicate_lead.organization_id
          and appointment_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.test_drive_appointments drive_appointment_row
        where drive_appointment_row.organization_id = duplicate_lead.organization_id
          and drive_appointment_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.test_drives drive_row
        where drive_row.organization_id = duplicate_lead.organization_id
          and drive_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.quotations quotation_row
        where quotation_row.organization_id = duplicate_lead.organization_id
          and quotation_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.bookings booking_row
        where booking_row.organization_id = duplicate_lead.organization_id
          and booking_row.lead_id = duplicate_lead.id
      )
      and not exists (
        select 1 from public.ai_extraction_runs extraction_row
        where extraction_row.organization_id = duplicate_lead.organization_id
          and extraction_row.lead_id = duplicate_lead.id
      )
  );
$$;

create or replace function public.request_duplicate_lead_deletion(
  target_lead_id uuid,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
  retained_lead_id uuid;
  request_row public.lead_duplicate_deletion_requests%rowtype;
  normalized_reason text := btrim(coalesce(target_reason, ''));
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'DUPLICATE_REASON_REQUIRED';
  end if;

  select * into lead_row
  from public.leads
  where id = target_lead_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'lead.update')
    or not app_private.can_access_record(
      lead_row.organization_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select candidate.id into retained_lead_id
  from public.leads candidate
  where candidate.organization_id = lead_row.organization_id
    and candidate.deleted_at is null
    and nullif(candidate.normalized_phone, '') = lead_row.normalized_phone
    and (candidate.created_at, candidate.id) < (lead_row.created_at, lead_row.id)
  order by candidate.created_at, candidate.id
  limit 1;

  if retained_lead_id is null
    or not app_private.is_untouched_duplicate_lead(target_lead_id, retained_lead_id)
  then
    raise exception using errcode = '23514', message = 'LEAD_NOT_ELIGIBLE_FOR_DUPLICATE_DELETION';
  end if;

  begin
    insert into public.lead_duplicate_deletion_requests (
      organization_id, branch_id, team_id, lead_id, retained_lead_id,
      requested_by, reason
    ) values (
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id,
      lead_row.id, retained_lead_id, auth.uid(), normalized_reason
    ) returning * into request_row;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'DUPLICATE_DELETION_ALREADY_PENDING';
  end;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    lead_row.organization_id, auth.uid(), 'lead.duplicate_deletion_requested',
    'lead', lead_row.id::text, lead_row.branch_id,
    jsonb_build_object(
      'request_id', request_row.id,
      'retained_lead_id', retained_lead_id,
      'reason', normalized_reason
    )
  );

  return jsonb_build_object(
    'request_id', request_row.id,
    'lead_id', lead_row.id,
    'retained_lead_id', retained_lead_id,
    'status', request_row.status,
    'requested_at', request_row.requested_at
  );
end;
$$;

create or replace function public.get_duplicate_lead_deletion_requests(
  target_status text default 'PENDING',
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_status text := upper(btrim(coalesce(target_status, 'PENDING')));
  normalized_search text := btrim(coalesce(target_search, ''));
  result jsonb;
begin
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.is_team_manager(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_APPROVAL_REQUIRED';
  end if;
  if normalized_status not in ('PENDING', 'APPROVED', 'REJECTED') then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST_STATUS';
  end if;
  if target_page < 1 or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 120
  then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION_OR_SEARCH';
  end if;

  with filtered as (
    select
      request_row.id,
      request_row.status,
      request_row.reason,
      request_row.review_note,
      request_row.requested_at,
      request_row.decided_at,
      request_row.lead_id,
      duplicate_lead.customer_name,
      duplicate_lead.phone,
      duplicate_lead.source,
      duplicate_lead.interested_model,
      duplicate_lead.lifecycle_status,
      duplicate_lead.branch_id,
      duplicate_lead.team_id,
      branch_row.name as branch_name,
      team_row.name as team_name,
      request_row.retained_lead_id,
      retained_lead.customer_name as retained_customer_name,
      retained_lead.source as retained_source,
      retained_lead.lifecycle_status as retained_lifecycle_status,
      retained_lead.created_at as retained_created_at,
      requester.full_name as requester_name,
      reviewer.full_name as reviewer_name
    from public.lead_duplicate_deletion_requests request_row
    join public.leads duplicate_lead
      on duplicate_lead.id = request_row.lead_id
     and duplicate_lead.organization_id = request_row.organization_id
    join public.leads retained_lead
      on retained_lead.id = request_row.retained_lead_id
     and retained_lead.organization_id = request_row.organization_id
    join public.branches branch_row on branch_row.id = request_row.branch_id
    left join public.teams team_row on team_row.id = request_row.team_id
    join public.profiles requester on requester.id = request_row.requested_by
    left join public.profiles reviewer on reviewer.id = request_row.reviewed_by
    where request_row.organization_id = current_organization_id
      and request_row.status = normalized_status
      and app_private.can_access_record(
        request_row.organization_id,
        request_row.branch_id,
        request_row.team_id,
        duplicate_lead.assigned_user_id
      )
      and (
        normalized_search = ''
        or duplicate_lead.customer_name ilike '%' || normalized_search || '%'
        or duplicate_lead.phone ilike '%' || normalized_search || '%'
        or duplicate_lead.id::text ilike '%' || normalized_search || '%'
        or requester.full_name ilike '%' || normalized_search || '%'
      )
  ), counted as (
    select filtered.*, count(*) over () as full_count
    from filtered
  ), paged as (
    select *
    from counted
    order by requested_at desc, id
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce(
      jsonb_agg(to_jsonb(paged) - 'full_count' order by requested_at desc, id),
      '[]'::jsonb
    ),
    'total', coalesce(max(full_count), 0),
    'page', target_page,
    'page_size', target_page_size
  ) into result
  from paged;

  return result;
end;
$$;

create or replace function public.decide_duplicate_lead_deletion(
  target_request_id uuid,
  target_decision text,
  target_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.lead_duplicate_deletion_requests%rowtype;
  lead_row public.leads%rowtype;
  normalized_decision text := upper(btrim(coalesce(target_decision, '')));
  normalized_note text := nullif(btrim(coalesce(target_review_note, '')), '');
begin
  if normalized_decision not in ('APPROVED', 'REJECTED') then
    raise exception using errcode = '22023', message = 'INVALID_DUPLICATE_DECISION';
  end if;
  if char_length(coalesce(normalized_note, '')) > 500
    or (normalized_decision = 'REJECTED' and char_length(coalesce(normalized_note, '')) < 5)
  then
    raise exception using errcode = '22023', message = 'REVIEW_NOTE_REQUIRED';
  end if;

  select * into request_row
  from public.lead_duplicate_deletion_requests
  where id = target_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DUPLICATE_REQUEST_NOT_FOUND';
  end if;
  if request_row.status <> 'PENDING' then
    raise exception using errcode = '23514', message = 'DUPLICATE_REQUEST_ALREADY_DECIDED';
  end if;
  if request_row.requested_by = auth.uid() then
    raise exception using errcode = '42501', message = 'REQUESTER_CANNOT_APPROVE';
  end if;

  select * into lead_row from public.leads where id = request_row.lead_id for update;
  if not app_private.is_team_manager(request_row.organization_id)
    or not app_private.has_permission(request_row.organization_id, 'lead.update')
    or not app_private.can_access_record(
      request_row.organization_id,
      request_row.branch_id,
      request_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_APPROVAL_REQUIRED';
  end if;

  if normalized_decision = 'APPROVED' then
    if not app_private.is_untouched_duplicate_lead(
      request_row.lead_id,
      request_row.retained_lead_id
    ) then
      raise exception using errcode = '23514', message = 'LEAD_NO_LONGER_ELIGIBLE';
    end if;
    update public.leads
    set deleted_at = now(),
        duplicate_of_lead_id = request_row.retained_lead_id,
        duplicate_deletion_request_id = request_row.id,
        deleted_by = auth.uid(),
        deletion_reason = 'Approved duplicate lead: ' || request_row.reason,
        updated_at = now()
    where id = request_row.lead_id;
  end if;

  update public.lead_duplicate_deletion_requests
  set status = normalized_decision,
      reviewed_by = auth.uid(),
      review_note = normalized_note,
      decided_at = now(),
      updated_at = now()
  where id = request_row.id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    request_row.organization_id,
    auth.uid(),
    case normalized_decision
      when 'APPROVED' then 'lead.duplicate_deletion_approved'
      else 'lead.duplicate_deletion_rejected'
    end,
    'lead', request_row.lead_id::text, request_row.branch_id,
    jsonb_build_object(
      'request_id', request_row.id,
      'retained_lead_id', request_row.retained_lead_id,
      'request_reason', request_row.reason,
      'review_note', normalized_note,
      'soft_deleted', normalized_decision = 'APPROVED'
    )
  );

  return jsonb_build_object(
    'request_id', request_row.id,
    'lead_id', request_row.lead_id,
    'retained_lead_id', request_row.retained_lead_id,
    'status', normalized_decision,
    'soft_deleted', normalized_decision = 'APPROVED'
  );
end;
$$;

revoke all on table public.lead_duplicate_deletion_requests from public, anon, authenticated;
revoke all on function app_private.is_team_manager(uuid) from public, anon, authenticated;
revoke all on function app_private.is_untouched_duplicate_lead(uuid, uuid) from public, anon, authenticated;
revoke all on function public.request_duplicate_lead_deletion(uuid, text) from public, anon;
revoke all on function public.get_duplicate_lead_deletion_requests(text, text, integer, integer) from public, anon;
revoke all on function public.decide_duplicate_lead_deletion(uuid, text, text) from public, anon;
grant execute on function public.request_duplicate_lead_deletion(uuid, text) to authenticated;
grant execute on function public.get_duplicate_lead_deletion_requests(text, text, integer, integer) to authenticated;
grant execute on function public.decide_duplicate_lead_deletion(uuid, text, text) to authenticated;
