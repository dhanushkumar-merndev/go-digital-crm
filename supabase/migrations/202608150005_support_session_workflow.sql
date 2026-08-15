begin;

create unique index support_sessions_one_open_per_tenant_idx
  on public.support_sessions (organization_id)
  where ended_at is null;
create unique index support_requests_one_pending_per_requester_idx
  on public.support_access_requests (organization_id, requested_by)
  where status = 'PENDING';

create or replace function public.request_support_session(
  target_organization_id uuid,
  support_purpose text,
  capability_keys text[],
  requested_minutes integer default 30
)
returns public.support_access_requests
language plpgsql
security definer
set search_path = ''
as $$
declare normalized_capabilities text[];
declare created_request public.support_access_requests%rowtype;
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;
  if char_length(btrim(coalesce(support_purpose, ''))) not between 10 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_PURPOSE';
  end if;
  if requested_minutes not between 5 and 60 then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_DURATION';
  end if;

  select array_agg(distinct btrim(capability) order by btrim(capability))
  into normalized_capabilities
  from unnest(capability_keys) capability
  where nullif(btrim(capability), '') is not null;
  if coalesce(cardinality(normalized_capabilities), 0) not between 1 and 20 then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_CAPABILITIES';
  end if;
  if normalized_capabilities && array['support.approve']::text[]
    or exists (
      select 1
      from unnest(normalized_capabilities) capability
      left join public.permissions permission_row
        on permission_row.permission_key = capability
      where permission_row.id is null
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_CAPABILITIES';
  end if;
  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = target_organization_id
      and organization_row.status = 'ACTIVE'
      and organization_row.deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'ACTIVE_TENANT_NOT_FOUND';
  end if;
  if exists (
    select 1
    from public.support_access_requests request_row
    where request_row.organization_id = target_organization_id
      and request_row.requested_by = auth.uid()
      and request_row.status = 'PENDING'
  ) then
    raise exception using errcode = '23505', message = 'SUPPORT_REQUEST_ALREADY_PENDING';
  end if;

  insert into public.support_access_requests (
    organization_id,
    requested_by,
    purpose,
    capability_scope,
    status
  ) values (
    target_organization_id,
    auth.uid(),
    btrim(support_purpose),
    jsonb_build_object(
      'permissions', to_jsonb(normalized_capabilities),
      'duration_minutes', requested_minutes
    ),
    'PENDING'
  )
  returning * into created_request;

  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    metadata
  ) values (
    target_organization_id,
    auth.uid(),
    'support.requested',
    'support_access_request',
    created_request.id::text,
    jsonb_build_object(
      'permissions', normalized_capabilities,
      'duration_minutes', requested_minutes
    )
  );
  return created_request;
end;
$$;

create or replace function public.decide_support_session_request(
  target_request_id uuid,
  decision text,
  decision_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare request_row public.support_access_requests%rowtype;
declare created_session public.support_sessions%rowtype;
declare session_minutes integer;
declare expired_session_id uuid;
begin
  select * into request_row
  from public.support_access_requests
  where id = target_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUPPORT_REQUEST_NOT_FOUND';
  end if;
  if request_row.status <> 'PENDING' then
    raise exception using errcode = '23514', message = 'SUPPORT_REQUEST_ALREADY_DECIDED';
  end if;
  if decision not in ('APPROVE', 'REJECT') then
    raise exception using errcode = '22023', message = 'INVALID_SUPPORT_DECISION';
  end if;
  if request_row.requested_by = auth.uid()
    or not app_private.mfa_policy_satisfied(request_row.organization_id)
    or not app_private.has_organization_wide_scope(request_row.organization_id)
    or not exists (
      select 1
      from public.profiles profile_row
      join public.user_role_assignments assignment_row
        on assignment_row.user_id = profile_row.id
       and assignment_row.organization_id = profile_row.organization_id
       and assignment_row.active
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      join public.role_permissions role_permission_row
        on role_permission_row.role_id = role_row.id
      join public.permissions permission_row
        on permission_row.id = role_permission_row.permission_id
       and permission_row.permission_key = 'support.approve'
      where profile_row.id = auth.uid()
        and profile_row.organization_id = request_row.organization_id
        and profile_row.active
        and profile_row.deleted_at is null
        and role_row.role_key = 'business_owner'
    )
  then
    raise exception using errcode = '42501', message = 'BUSINESS_OWNER_MFA_REQUIRED';
  end if;
  if char_length(coalesce(decision_note, '')) > 500 then
    raise exception using errcode = '22023', message = 'DECISION_NOTE_TOO_LONG';
  end if;

  update public.support_access_requests
  set status = case when decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
      approved_by = auth.uid(),
      decided_at = now()
  where id = request_row.id;

  if decision = 'REJECT' then
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      request_row.organization_id, auth.uid(), 'support.rejected',
      'support_access_request', request_row.id::text,
      jsonb_build_object('decision_note', nullif(btrim(coalesce(decision_note, '')), ''))
    );
    return jsonb_build_object('request_id', request_row.id, 'status', 'REJECTED');
  end if;

  perform 1
  from public.organizations organization_row
  where organization_row.id = request_row.organization_id
    and organization_row.status in ('ACTIVE', 'SUPPORT_MAINTENANCE')
    and organization_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'TENANT_NOT_AVAILABLE_FOR_SUPPORT';
  end if;

  update public.support_sessions
  set ended_at = now(), termination_reason = 'Automatically expired before a new approval'
  where organization_id = request_row.organization_id
    and ended_at is null
    and expires_at <= now()
  returning id into expired_session_id;
  if expired_session_id is not null then
    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      request_row.organization_id, auth.uid(), 'support.expired',
      'support_session', expired_session_id::text,
      jsonb_build_object('expired_by', 'approval_boundary')
    );
    update public.organizations
    set status = 'ACTIVE', updated_at = now()
    where id = request_row.organization_id
      and status = 'SUPPORT_MAINTENANCE';
    if found then
      insert into public.tenant_status_history (
        organization_id, from_status, to_status, changed_by, reason
      ) values (
        request_row.organization_id, 'SUPPORT_MAINTENANCE', 'ACTIVE', auth.uid(),
        'Previous approved support window expired'
      );
    end if;
  end if;
  if exists (
    select 1
    from public.support_sessions session_row
    where session_row.organization_id = request_row.organization_id
      and session_row.ended_at is null
      and session_row.expires_at > now()
  ) then
    raise exception using errcode = '23505', message = 'SUPPORT_SESSION_ALREADY_ACTIVE';
  end if;
  session_minutes := least(
    60,
    greatest(5, coalesce((request_row.capability_scope ->> 'duration_minutes')::integer, 30))
  );
  insert into public.support_sessions (
    organization_id,
    request_id,
    requester_id,
    approver_id,
    purpose,
    capability_scope,
    starts_at,
    expires_at
  ) values (
    request_row.organization_id,
    request_row.id,
    request_row.requested_by,
    auth.uid(),
    request_row.purpose,
    request_row.capability_scope,
    now(),
    now() + make_interval(mins => session_minutes)
  ) returning * into created_session;

  update public.organizations
  set status = 'SUPPORT_MAINTENANCE', updated_at = now()
  where id = request_row.organization_id;
  insert into public.tenant_status_history (
    organization_id, from_status, to_status, changed_by, reason
  ) values (
    request_row.organization_id, 'ACTIVE', 'SUPPORT_MAINTENANCE', auth.uid(),
    'Approved time-limited platform support session'
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    request_row.organization_id, auth.uid(), 'support.approved',
    'support_session', created_session.id::text,
    jsonb_build_object(
      'request_id', request_row.id,
      'requester_id', request_row.requested_by,
      'expires_at', created_session.expires_at,
      'decision_note', nullif(btrim(coalesce(decision_note, '')), '')
    )
  );
  return jsonb_build_object(
    'request_id', request_row.id,
    'session_id', created_session.id,
    'status', 'APPROVED',
    'expires_at', created_session.expires_at
  );
end;
$$;

create or replace function public.end_support_session(
  target_session_id uuid,
  termination_reason text
)
returns public.support_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare session_row public.support_sessions%rowtype;
declare normalized_termination_reason text;
begin
  select * into session_row
  from public.support_sessions
  where id = target_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUPPORT_SESSION_NOT_FOUND';
  end if;
  if not (
    (
      auth.uid() = session_row.requester_id
      and app_private.is_platform_admin()
      and app_private.mfa_policy_satisfied(null)
    )
    or (
      app_private.is_tenant_support_controller(session_row.organization_id)
      and app_private.has_organization_wide_scope(session_row.organization_id)
    )
  ) then
    raise exception using errcode = '42501', message = 'SUPPORT_TERMINATION_DENIED';
  end if;
  if session_row.ended_at is not null then
    return session_row;
  end if;
  normalized_termination_reason := btrim(coalesce(termination_reason, ''));
  if char_length(normalized_termination_reason) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_TERMINATION_REASON';
  end if;

  update public.support_sessions
  set ended_at = now(), termination_reason = normalized_termination_reason
  where id = session_row.id
  returning * into session_row;

  perform 1
  from public.organizations organization_row
  where organization_row.id = session_row.organization_id
  for update;
  if not exists (
    select 1
    from public.support_sessions other_session
    where other_session.organization_id = session_row.organization_id
      and other_session.id <> session_row.id
      and other_session.ended_at is null
      and other_session.expires_at > now()
  ) then
    update public.organizations
    set status = 'ACTIVE', updated_at = now()
    where id = session_row.organization_id
      and status = 'SUPPORT_MAINTENANCE';
    if found then
      insert into public.tenant_status_history (
        organization_id, from_status, to_status, changed_by, reason
      ) values (
        session_row.organization_id, 'SUPPORT_MAINTENANCE', 'ACTIVE', auth.uid(),
        'Platform support session ended'
      );
    end if;
  end if;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    session_row.organization_id, auth.uid(), 'support.ended', 'support_session',
    session_row.id::text, jsonb_build_object('reason', session_row.termination_reason)
  );
  return session_row;
end;
$$;

create or replace function public.expire_support_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare expired_count integer := 0;
declare expired_session record;
declare restored_organization_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;

  for expired_session in
    select session_row.id, session_row.organization_id
    from public.support_sessions session_row
    where session_row.ended_at is null
      and session_row.expires_at <= now()
    order by session_row.expires_at, session_row.id
    for update skip locked
  loop
    update public.support_sessions
    set ended_at = now(), termination_reason = 'Automatically expired at the approved limit'
    where id = expired_session.id
      and ended_at is null;
    if found then
      expired_count := expired_count + 1;
      insert into public.audit_logs (
        organization_id, actor_id, action, resource_type, resource_id, metadata
      ) values (
        expired_session.organization_id, null, 'support.expired', 'support_session',
        expired_session.id::text, jsonb_build_object('expired_by', 'scheduled_worker')
      );
    end if;
  end loop;

  for restored_organization_id in
    update public.organizations organization_row
    set status = 'ACTIVE', updated_at = now()
    where organization_row.status = 'SUPPORT_MAINTENANCE'
      and not exists (
        select 1
        from public.support_sessions session_row
        where session_row.organization_id = organization_row.id
          and session_row.ended_at is null
          and session_row.expires_at > now()
      )
    returning organization_row.id
  loop
    insert into public.tenant_status_history (
      organization_id, from_status, to_status, changed_by, reason
    ) values (
      restored_organization_id, 'SUPPORT_MAINTENANCE', 'ACTIVE', null,
      'Approved platform support window expired'
    );
  end loop;
  return expired_count;
end;
$$;

revoke all on function public.request_support_session(uuid, text, text[], integer)
from public, anon;
grant execute on function public.request_support_session(uuid, text, text[], integer)
to authenticated;
revoke all on function public.decide_support_session_request(uuid, text, text)
from public, anon;
grant execute on function public.decide_support_session_request(uuid, text, text)
to authenticated;
revoke all on function public.end_support_session(uuid, text)
from public, anon;
grant execute on function public.end_support_session(uuid, text)
to authenticated;
revoke all on function public.expire_support_sessions()
from public, anon, authenticated;
grant execute on function public.expire_support_sessions()
to service_role;

commit;
