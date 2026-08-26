begin;

-- Existing tenant roles are backfilled only during this controlled migration.
-- Runtime writes stay behind the security-definer RPCs below.
select set_config('request.jwt.claim.role', 'service_role', false);

-- Marketing already owns audience-wide drip campaigns. This is the other half:
-- one consultant, one customer, one sequence, written for that conversation.
--
-- The two are connected in exactly one direction. A marketing campaign can be
-- used as a starting point, and its steps are COPIED into the enrolment at the
-- moment it is created. They are never read back afterwards. A campaign the
-- marketing team edits next week must not silently rewrite what a consultant
-- already promised to send a specific customer, and a campaign that is archived
-- must not strand a sequence mid-flight.
insert into public.permissions (permission_key, module, description) values
  ('customer.drip.view', 'customers',
    'View drip message sequences on customers within authorized scope'),
  ('customer.drip.manage', 'customers',
    'Start and cancel drip message sequences for customers within authorized scope')
on conflict (permission_key) do update
  set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.system_role
  and (
    (
      role_row.role_key in (
        'sales_consultant', 'team_manager', 'showroom_manager',
        'gm_sales', 'client_admin', 'system_administrator'
      )
      and permission_row.permission_key in ('customer.drip.view', 'customer.drip.manage')
    )
    or (
      role_row.role_key in ('business_owner', 'digital_marketing_manager')
      and permission_row.permission_key = 'customer.drip.view'
    )
  )
on conflict do nothing;

create table public.customer_drip_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  lead_id uuid references public.leads(id),
  -- Provenance only. Null means the consultant started from blank, and a
  -- non-null value never causes the campaign to be re-read.
  source_campaign_id uuid references public.marketing_drip_campaigns(id),
  source_name text not null,
  status text not null default 'ACTIVE',
  enrolled_by uuid not null references public.profiles(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  completed_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (char_length(btrim(source_name)) between 2 and 180),
  check (status in ('ACTIVE', 'COMPLETED', 'CANCELLED')),
  check (cancellation_reason is null or char_length(btrim(cancellation_reason)) between 3 and 500),
  check (version > 0)
);

create table public.customer_drip_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  enrollment_id uuid not null
    references public.customer_drip_enrollments(id) on delete restrict,
  step_order smallint not null,
  channel text not null,
  -- Stored already personalised. Rendering at send time would mean a message a
  -- consultant reviewed and a message the customer receives could differ.
  message_body text not null,
  scheduled_for timestamptz not null,
  status text not null default 'QUEUED',
  sent_at timestamptz,
  failure_reason text,
  provider_message_id text,
  attempts integer not null default 0,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, step_order),
  unique (organization_id, id),
  check (step_order between 1 and 12),
  check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  check (char_length(btrim(message_body)) between 1 and 4000),
  check (status in ('QUEUED', 'SENT', 'FAILED', 'CANCELLED')),
  check (attempts between 0 and 10),
  check (version > 0)
);

alter table public.customer_drip_enrollments
  add constraint customer_drip_enrollments_branch_org_fk
    foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) not valid,
  add constraint customer_drip_enrollments_customer_org_fk
    foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) not valid,
  add constraint customer_drip_enrollments_enroller_org_fk
    foreign key (organization_id, enrolled_by)
    references public.profiles (organization_id, id) not valid;
alter table public.customer_drip_messages
  add constraint customer_drip_messages_enrollment_org_fk
    foreign key (organization_id, enrollment_id)
    references public.customer_drip_enrollments (organization_id, id) not valid;

create index customer_drip_enrollments_customer_idx
  on public.customer_drip_enrollments (organization_id, customer_id, created_at desc, id desc);
create index customer_drip_enrollments_scope_idx
  on public.customer_drip_enrollments (organization_id, branch_id, status, created_at desc);
create index customer_drip_messages_enrollment_idx
  on public.customer_drip_messages (enrollment_id, step_order);
-- The dispatcher's only query: what is due now, oldest first.
create index customer_drip_messages_due_idx
  on public.customer_drip_messages (status, scheduled_for, id)
  where status = 'QUEUED';

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order) values
  ('customer_drip_messages', 'DELETE', 509),
  ('customer_drip_enrollments', 'DELETE', 510)
on conflict (table_name) do update
  set disposition = excluded.disposition, delete_order = excluded.delete_order;

alter table public.customer_drip_enrollments enable row level security;
alter table public.customer_drip_enrollments force row level security;
alter table public.customer_drip_messages enable row level security;
alter table public.customer_drip_messages force row level security;

create policy customer_drip_enrollments_read on public.customer_drip_enrollments
  for select to authenticated using (
    app_private.has_permission(organization_id, 'customer.drip.view')
    and app_private.can_access_branch(organization_id, branch_id)
    and app_private.can_access_customer(organization_id, customer_id)
  );
create policy customer_drip_messages_read on public.customer_drip_messages
  for select to authenticated using (
    app_private.has_permission(organization_id, 'customer.drip.view')
    and exists (
      select 1
      from public.customer_drip_enrollments enrollment_row
      where enrollment_row.id = enrollment_id
        and enrollment_row.organization_id = customer_drip_messages.organization_id
        and app_private.can_access_branch(
          enrollment_row.organization_id, enrollment_row.branch_id
        )
        and app_private.can_access_customer(
          enrollment_row.organization_id, enrollment_row.customer_id
        )
    )
  );
revoke insert, update, delete, truncate
  on public.customer_drip_enrollments, public.customer_drip_messages
  from anon, authenticated;

-- Sequences a consultant can start from. Read through this RPC rather than the
-- marketing tables directly, because a consultant has no marketing permission
-- and should not gain one just to reuse a phrasing the team already approved.
create or replace function public.get_customer_drip_templates()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.drip.manage')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_MANAGE_PERMISSION_REQUIRED';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'campaign_id', campaign_row.id,
        'name', campaign_row.name,
        'description', campaign_row.description,
        'default_channel', campaign_row.default_channel,
        'steps', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'step_order', step_row.step_order,
              'delay_hours', step_row.delay_hours,
              'channel', step_row.channel,
              'message_body', step_row.message_body
            ) order by step_row.step_order
          )
          from public.marketing_drip_steps step_row
          where step_row.campaign_id = campaign_row.id
            and step_row.organization_id = campaign_row.organization_id
            and step_row.active
        ), '[]'::jsonb)
      ) order by campaign_row.name
    )
    from public.marketing_drip_campaigns campaign_row
    where campaign_row.organization_id = current_organization_id
      and campaign_row.deleted_at is null
      and campaign_row.status = 'ACTIVE'
      and (
        campaign_row.branch_id is null
        or app_private.can_access_branch(campaign_row.organization_id, campaign_row.branch_id)
      )
      and exists (
        select 1
        from public.marketing_drip_steps step_row
        where step_row.campaign_id = campaign_row.id
          and step_row.organization_id = campaign_row.organization_id
          and step_row.active
      )
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_customer_drip_panel(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  if auth.uid() is null or target_customer_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.drip.view')
    or not app_private.can_access_customer(current_organization_id, target_customer_id)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_VIEW_PERMISSION_REQUIRED';
  end if;
  return jsonb_build_object(
    'can_manage', app_private.has_permission(current_organization_id, 'customer.drip.manage'),
    'enrollments', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', enrollment_row.id,
          'source_name', enrollment_row.source_name,
          'source_campaign_id', enrollment_row.source_campaign_id,
          'status', enrollment_row.status,
          'version', enrollment_row.version,
          'enrolled_by_name', profile_row.full_name,
          'created_at', enrollment_row.created_at,
          'cancelled_at', enrollment_row.cancelled_at,
          'cancellation_reason', enrollment_row.cancellation_reason,
          'completed_at', enrollment_row.completed_at,
          'messages', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', message_row.id,
                'step_order', message_row.step_order,
                'channel', message_row.channel,
                'message_body', message_row.message_body,
                'scheduled_for', message_row.scheduled_for,
                'status', message_row.status,
                'sent_at', message_row.sent_at,
                'failure_reason', message_row.failure_reason
              ) order by message_row.step_order
            )
            from public.customer_drip_messages message_row
            where message_row.enrollment_id = enrollment_row.id
              and message_row.organization_id = enrollment_row.organization_id
          ), '[]'::jsonb)
        ) order by enrollment_row.created_at desc, enrollment_row.id desc
      )
      from public.customer_drip_enrollments enrollment_row
      join public.profiles profile_row
        on profile_row.id = enrollment_row.enrolled_by
       and profile_row.organization_id = enrollment_row.organization_id
      where enrollment_row.organization_id = current_organization_id
        and enrollment_row.customer_id = target_customer_id
        and app_private.can_access_branch(
          enrollment_row.organization_id, enrollment_row.branch_id
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.create_customer_drip_enrollment(
  target_customer_id uuid,
  target_lead_id uuid,
  target_source_campaign_id uuid,
  target_source_name text,
  target_steps jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  customer_row public.customers%rowtype;
  resolved_branch_id uuid;
  resolved_lead_id uuid;
  normalized_name text := btrim(coalesce(target_source_name, ''));
  normalized_steps jsonb := coalesce(target_steps, '[]'::jsonb);
  step_element jsonb;
  step_index integer := 0;
  running_offset_hours integer := 0;
  enrollment_id uuid := gen_random_uuid();
  enrolled_at timestamptz := now();
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_customer_id is null
    or target_request_id is null
    or char_length(normalized_name) not between 2 and 180
    or jsonb_typeof(normalized_steps) <> 'array'
    or jsonb_array_length(normalized_steps) not between 1 and 12
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_INPUT';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.drip.manage')
    or not app_private.can_access_customer(current_organization_id, target_customer_id)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_MANAGE_PERMISSION_REQUIRED';
  end if;

  select * into customer_row
  from public.customers customer_source
  where customer_source.id = target_customer_id
    and customer_source.organization_id = current_organization_id
    and customer_source.deleted_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'CUSTOMER_NOT_FOUND';
  end if;

  -- The branch decides who may later read the sequence, so it is taken from a
  -- lead the actor can actually reach rather than from the request body.
  select lead_row.id, lead_row.branch_id
  into resolved_lead_id, resolved_branch_id
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.customer_id = target_customer_id
    and lead_row.deleted_at is null
    and (target_lead_id is null or lead_row.id = target_lead_id)
    and app_private.can_access_record(
      lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
    )
  order by lead_row.updated_at desc, lead_row.id desc
  limit 1;
  if resolved_branch_id is null then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_SCOPE_DENIED';
  end if;

  if target_source_campaign_id is not null and not exists (
    select 1
    from public.marketing_drip_campaigns campaign_row
    where campaign_row.id = target_source_campaign_id
      and campaign_row.organization_id = current_organization_id
      and campaign_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'CUSTOMER_DRIP_TEMPLATE_NOT_FOUND';
  end if;

  fingerprint := jsonb_build_object(
    'customer_id', target_customer_id,
    'source_campaign_id', target_source_campaign_id,
    'source_name', normalized_name,
    'steps', normalized_steps
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'customer_drip.enrolled'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;

  insert into public.customer_drip_enrollments (
    id, organization_id, branch_id, customer_id, lead_id,
    source_campaign_id, source_name, status, enrolled_by
  ) values (
    enrollment_id, current_organization_id, resolved_branch_id, target_customer_id,
    resolved_lead_id, target_source_campaign_id, normalized_name, 'ACTIVE', auth.uid()
  );

  for step_element in select * from jsonb_array_elements(normalized_steps) loop
    step_index := step_index + 1;
    if jsonb_typeof(step_element) <> 'object'
      or coalesce(step_element ->> 'channel', '') not in ('WHATSAPP', 'SMS', 'EMAIL')
      or char_length(btrim(coalesce(step_element ->> 'message_body', ''))) not between 1 and 4000
    then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_STEP';
    end if;

    begin
      -- Delays are relative to the previous step, which is how a consultant
      -- reads a sequence; the stored schedule is absolute so a later edit to
      -- one step cannot silently move every step after it.
      running_offset_hours := running_offset_hours
        + greatest(0, least(8760, coalesce((step_element ->> 'delay_hours')::integer, 0)));
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_STEP';
    end;

    insert into public.customer_drip_messages (
      organization_id, enrollment_id, step_order, channel, message_body, scheduled_for, status
    ) values (
      current_organization_id, enrollment_id, step_index,
      step_element ->> 'channel',
      btrim(step_element ->> 'message_body'),
      enrolled_at + make_interval(hours => running_offset_hours),
      'QUEUED'
    );
  end loop;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, target_customer_id, resolved_lead_id,
    'DRIP_ENROLLED', auth.uid(),
    jsonb_build_object(
      'enrollment_id', enrollment_id, 'source_name', normalized_name, 'steps', step_index
    )
  );

  result := jsonb_build_object(
    'id', enrollment_id, 'status', 'ACTIVE', 'version', 1, 'steps', step_index, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'customer_drip.enrolled', 'customer_drip_enrollment',
    enrollment_id::text, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.cancel_customer_drip_enrollment(
  target_enrollment_id uuid,
  expected_version bigint,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  enrollment_row public.customer_drip_enrollments%rowtype;
  normalized_reason text := btrim(coalesce(target_reason, ''));
  cancelled_count integer := 0;
  next_version bigint;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_enrollment_id is null
    or expected_version is null or expected_version < 1
    or target_request_id is null
    or char_length(normalized_reason) not between 3 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_CANCELLATION';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.drip.manage')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_MANAGE_PERMISSION_REQUIRED';
  end if;

  select * into enrollment_row
  from public.customer_drip_enrollments enrollment_source
  where enrollment_source.id = target_enrollment_id
    and enrollment_source.organization_id = current_organization_id
  for update;
  if not found
    or not app_private.can_access_branch(current_organization_id, enrollment_row.branch_id)
    or not app_private.can_access_customer(current_organization_id, enrollment_row.customer_id)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_DRIP_SCOPE_DENIED';
  end if;

  -- Cancelling twice is not an error worth surfacing; the caller wanted the
  -- sequence stopped and it is stopped.
  if enrollment_row.status <> 'ACTIVE' then
    return jsonb_build_object(
      'id', enrollment_row.id, 'status', enrollment_row.status,
      'version', enrollment_row.version, 'cancelled_messages', 0, 'replayed', true
    );
  end if;
  if enrollment_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'STALE_CUSTOMER_DRIP_VERSION';
  end if;

  -- Only messages that have not gone out. A sent message cannot be unsent, and
  -- rewriting its status would lose the record that the customer received it.
  with cancelled as (
    update public.customer_drip_messages message_row
    set status = 'CANCELLED', updated_at = now(), version = message_row.version + 1
    where message_row.enrollment_id = enrollment_row.id
      and message_row.organization_id = current_organization_id
      and message_row.status = 'QUEUED'
    returning 1
  )
  select count(*) into cancelled_count from cancelled;

  update public.customer_drip_enrollments enrollment_target
  set status = 'CANCELLED',
      cancelled_at = now(),
      cancellation_reason = normalized_reason,
      updated_at = now(),
      version = enrollment_target.version + 1
  where enrollment_target.id = enrollment_row.id
  returning enrollment_target.version into next_version;

  result := jsonb_build_object(
    'id', enrollment_row.id, 'status', 'CANCELLED', 'version', next_version,
    'cancelled_messages', cancelled_count, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'customer_drip.cancelled', 'customer_drip_enrollment',
    enrollment_row.id::text, target_request_id,
    jsonb_build_object('reason', normalized_reason, 'result', result)
  );
  return result;
end;
$$;

revoke all on function
  public.get_customer_drip_templates(),
  public.get_customer_drip_panel(uuid),
  public.create_customer_drip_enrollment(uuid, uuid, uuid, text, jsonb, uuid),
  public.cancel_customer_drip_enrollment(uuid, bigint, text, uuid)
  from public, anon;
grant execute on function
  public.get_customer_drip_templates(),
  public.get_customer_drip_panel(uuid),
  public.create_customer_drip_enrollment(uuid, uuid, uuid, text, jsonb, uuid),
  public.cancel_customer_drip_enrollment(uuid, bigint, text, uuid)
  to authenticated;

drop trigger if exists realtime_customer_drip_enrollments_invalidate
  on public.customer_drip_enrollments;
create trigger realtime_customer_drip_enrollments_invalidate
after insert or update on public.customer_drip_enrollments
for each row execute function app_private.broadcast_tenant_invalidation('communications');
drop trigger if exists realtime_customer_drip_messages_invalidate
  on public.customer_drip_messages;
create trigger realtime_customer_drip_messages_invalidate
after insert or update on public.customer_drip_messages
for each row execute function app_private.broadcast_tenant_invalidation('communications');

commit;
