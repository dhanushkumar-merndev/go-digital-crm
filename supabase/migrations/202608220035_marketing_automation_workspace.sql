begin;

-- Existing tenant roles are backfilled only during this controlled migration. Runtime writes stay
-- behind the security-definer RPCs below.
select set_config('request.jwt.claim.role', 'service_role', false);

-- Marketing automation is deliberately modelled separately from provider credentials.  A campaign
-- owns its audience and sequence; a delivery worker may later resolve the selected channel through
-- the tenant's connected account without exposing credentials to the browser.
insert into public.permissions (permission_key, module, description) values
  ('marketing.automation.view', 'marketing', 'View drip campaigns and customer review requests within authorized scope'),
  ('marketing.automation.manage', 'marketing', 'Create and control drip campaigns and customer review requests within authorized scope')
on conflict (permission_key) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null and role_row.system_role
  and (
    (role_row.role_key in ('digital_marketing_manager', 'client_admin', 'system_administrator')
      and permission_row.permission_key in ('marketing.automation.view', 'marketing.automation.manage'))
    or (role_row.role_key in ('business_owner', 'gm_sales')
      and permission_row.permission_key = 'marketing.automation.view')
  )
on conflict do nothing;

create table public.marketing_drip_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  name text not null,
  description text,
  audience_filter jsonb not null default '{}'::jsonb,
  default_channel text not null,
  status text not null default 'DRAFT',
  starts_at timestamptz,
  paused_at timestamptz,
  created_by uuid not null references public.profiles(id),
  version bigint not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (char_length(btrim(name)) between 3 and 180),
  check (description is null or char_length(description) <= 2000),
  check (jsonb_typeof(audience_filter) = 'object'),
  check (default_channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  check (status in ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
  check (version > 0)
);
create table public.marketing_drip_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  campaign_id uuid not null references public.marketing_drip_campaigns(id) on delete restrict,
  step_order smallint not null,
  delay_hours integer not null default 0,
  channel text not null,
  message_body text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, step_order),
  unique (organization_id, id),
  check (step_order between 1 and 24),
  check (delay_hours between 0 and 8760),
  check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  check (char_length(btrim(message_body)) between 1 and 4000)
);
create table public.customer_review_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  booking_id uuid references public.bookings(id),
  channel text not null,
  message_body text not null,
  status text not null default 'QUEUED',
  scheduled_for timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  provider_message_id text,
  created_by uuid not null references public.profiles(id),
  version bigint not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (channel in ('WHATSAPP', 'SMS', 'EMAIL', 'MANUAL')),
  check (char_length(btrim(message_body)) between 1 and 4000),
  check (status in ('QUEUED', 'SENT', 'DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  check (version > 0)
);

create index marketing_drip_campaigns_workspace_idx on public.marketing_drip_campaigns
  (organization_id, branch_id, status, updated_at desc, id desc) where deleted_at is null;
create index marketing_drip_steps_campaign_idx on public.marketing_drip_steps
  (organization_id, campaign_id, step_order);
create index customer_review_requests_workspace_idx on public.customer_review_requests
  (organization_id, branch_id, status, updated_at desc, id desc) where deleted_at is null;
create index customer_review_requests_customer_idx on public.customer_review_requests
  (organization_id, customer_id, created_at desc, id desc) where deleted_at is null;

alter table public.marketing_drip_campaigns
  add constraint marketing_drip_campaigns_branch_org_fk foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) not valid,
  add constraint marketing_drip_campaigns_creator_org_fk foreign key (organization_id, created_by)
    references public.profiles (organization_id, id) not valid;
alter table public.marketing_drip_steps
  add constraint marketing_drip_steps_campaign_org_fk foreign key (organization_id, campaign_id)
    references public.marketing_drip_campaigns (organization_id, id) not valid;
alter table public.customer_review_requests
  add constraint customer_review_requests_branch_org_fk foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) not valid,
  add constraint customer_review_requests_customer_org_fk foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) not valid,
  add constraint customer_review_requests_booking_org_fk foreign key (organization_id, booking_id)
    references public.bookings (organization_id, id) not valid,
  add constraint customer_review_requests_creator_org_fk foreign key (organization_id, created_by)
    references public.profiles (organization_id, id) not valid;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order) values
  ('customer_review_requests', 'DELETE', 511),
  ('marketing_drip_steps', 'DELETE', 781),
  ('marketing_drip_campaigns', 'DELETE', 782)
on conflict (table_name) do update set disposition = excluded.disposition, delete_order = excluded.delete_order;

create or replace function app_private.marketing_automation_request_fingerprint(target_payload jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(target_payload, '{}'::jsonb)::text, 'sha256'), 'hex')
$$;

create or replace function app_private.replay_marketing_automation_request(
  target_organization_id uuid, target_action text, target_request_id uuid, target_fingerprint text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare previous_action text; previous_metadata jsonb;
begin
  select audit_row.action, audit_row.metadata into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id and audit_row.action like 'marketing_automation.%'
  order by audit_row.created_at desc limit 1;
  if previous_action is null then return null; end if;
  if previous_action <> target_action or previous_metadata->>'fingerprint' is distinct from target_fingerprint then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return coalesce(previous_metadata->'result', '{}'::jsonb) || jsonb_build_object('replayed', true);
end;
$$;

create or replace function public.get_marketing_automation_workspace(
  target_timezone text default 'Asia/Kolkata'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid; result jsonb;
begin
  if target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_AUTOMATION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.view') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_VIEW_PERMISSION_REQUIRED';
  end if;
  with campaigns as materialized (
    select campaign_row.*,
      coalesce((select count(*) from public.marketing_drip_steps step_row
        where step_row.organization_id = campaign_row.organization_id and step_row.campaign_id = campaign_row.id and step_row.active), 0) as step_count
    from public.marketing_drip_campaigns campaign_row
    where campaign_row.organization_id = current_organization_id and campaign_row.deleted_at is null
      and ((campaign_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
        or (campaign_row.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign_row.branch_id)))
  ), reviews as materialized (
    select request_row.*, customer_row.full_name as customer_name, customer_row.primary_phone as customer_phone,
      booking_row.booking_number
    from public.customer_review_requests request_row
    join public.customers customer_row on customer_row.organization_id = request_row.organization_id
      and customer_row.id = request_row.customer_id and customer_row.deleted_at is null
    left join public.bookings booking_row on booking_row.organization_id = request_row.organization_id
      and booking_row.id = request_row.booking_id and booking_row.deleted_at is null
    where request_row.organization_id = current_organization_id and request_row.deleted_at is null
      and app_private.can_access_branch(current_organization_id, request_row.branch_id)
      and app_private.can_access_customer(current_organization_id, request_row.customer_id)
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'drip_kpis', jsonb_build_object(
      'total', (select count(*) from campaigns),
      'active', (select count(*) from campaigns where status = 'ACTIVE'),
      'paused', (select count(*) from campaigns where status = 'PAUSED'),
      'steps', (select coalesce(sum(step_count), 0) from campaigns)
    ),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'description', description, 'branch_id', branch_id,
      'default_channel', default_channel, 'status', status, 'starts_at', starts_at,
      'step_count', step_count, 'version', version, 'updated_at', updated_at
    ) order by updated_at desc, id desc) from (select * from campaigns order by updated_at desc, id desc limit 25) page_row), '[]'::jsonb),
    'review_kpis', jsonb_build_object(
      'queued', (select count(*) from reviews where status = 'QUEUED'),
      'sent_today', (select count(*) from reviews where sent_at is not null
        and timezone(target_timezone, sent_at)::date = timezone(target_timezone, now())::date),
      'delivered', (select count(*) from reviews where status in ('DELIVERED', 'COMPLETED')),
      'completed', (select count(*) from reviews where status = 'COMPLETED')
    ),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'customer_id', customer_id, 'customer_name', customer_name,
      'customer_phone', customer_phone, 'booking_id', booking_id, 'booking_number', booking_number,
      'channel', channel, 'status', status, 'scheduled_for', scheduled_for,
      'sent_at', sent_at, 'created_at', created_at, 'updated_at', updated_at, 'version', version
    ) order by updated_at desc, id desc) from (select * from reviews order by updated_at desc, id desc limit 25) page_row), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.get_marketing_review_customer_options(
  target_search text default '', target_limit integer default 25
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid; normalized_search text := lower(btrim(coalesce(target_search, ''))); result jsonb;
begin
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_REVIEW_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb) into result
  from (
    select customer_row.id as customer_id, customer_row.full_name as customer_name,
      customer_row.primary_phone as phone, booking_row.id as booking_id, booking_row.booking_number,
      booking_row.branch_id, booking_row.updated_at
    from public.customers customer_row
    join lateral (
      select source_booking.* from public.bookings source_booking
      where source_booking.organization_id = customer_row.organization_id
        and source_booking.customer_id = customer_row.id and source_booking.deleted_at is null
        and app_private.can_access_record(source_booking.organization_id, source_booking.branch_id,
          source_booking.team_id, source_booking.assigned_user_id)
      order by source_booking.updated_at desc, source_booking.id desc limit 1
    ) booking_row on true
    where customer_row.organization_id = current_organization_id and customer_row.deleted_at is null
      and app_private.can_access_customer(current_organization_id, customer_row.id)
      and (normalized_search = '' or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or (app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone) = app_private.normalize_phone_digits(normalized_search)))
    order by customer_row.updated_at desc, customer_row.id desc limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.get_marketing_automation_scope_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  return jsonb_build_object(
    'can_use_organization_scope', app_private.has_organization_wide_scope(current_organization_id),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', branch_row.id, 'name', branch_row.name) order by branch_row.name, branch_row.id)
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id and branch_row.active
        and app_private.can_access_branch(current_organization_id, branch_row.id)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.create_marketing_drip_campaign(
  target_name text, target_description text, target_branch_id uuid, target_default_channel text,
  target_audience_filter jsonb, target_steps jsonb, target_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_organization_id uuid; normalized_name text := btrim(coalesce(target_name, ''));
  normalized_description text := nullif(btrim(coalesce(target_description, '')), ''); normalized_channel text := upper(btrim(coalesce(target_default_channel, '')));
  campaign_id uuid := gen_random_uuid(); fingerprint text; replay_result jsonb; result jsonb; step_count integer;
begin
  if target_request_id is null or char_length(normalized_name) not between 3 and 180
    or char_length(coalesce(normalized_description, '')) > 2000
    or normalized_channel not in ('WHATSAPP', 'SMS', 'EMAIL')
    or jsonb_typeof(coalesce(target_audience_filter, '{}'::jsonb)) <> 'object'
    or jsonb_typeof(target_steps) <> 'array' or jsonb_array_length(target_steps) not between 1 and 24
  then raise exception using errcode = '22023', message = 'INVALID_MARKETING_DRIP_CAMPAIGN'; end if;
  select count(*) into step_count from jsonb_to_recordset(target_steps)
    as step_row(step_order integer, delay_hours integer, channel text, message_body text)
  where step_order between 1 and 24 and delay_hours between 0 and 8760
    and upper(btrim(channel)) in ('WHATSAPP', 'SMS', 'EMAIL') and char_length(btrim(message_body)) between 1 and 4000;
  if step_count <> jsonb_array_length(target_steps) or exists (
    select 1 from jsonb_to_recordset(target_steps) as step_row(step_order integer, delay_hours integer, channel text, message_body text)
    group by step_order having count(*) <> 1
  ) then raise exception using errcode = '22023', message = 'INVALID_MARKETING_DRIP_STEPS'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED'; end if;
  if target_branch_id is not null and not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_SCOPE_DENIED'; end if;
  if target_branch_id is null and not app_private.has_organization_wide_scope(current_organization_id) then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_ORGANIZATION_SCOPE_REQUIRED'; end if;
  fingerprint := app_private.marketing_automation_request_fingerprint(jsonb_build_object('name', normalized_name, 'description', normalized_description, 'branch_id', target_branch_id, 'channel', normalized_channel, 'audience', target_audience_filter, 'steps', target_steps));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0));
  replay_result := app_private.replay_marketing_automation_request(current_organization_id, 'marketing_automation.drip_created', target_request_id, fingerprint);
  if replay_result is not null then return replay_result; end if;
  insert into public.marketing_drip_campaigns (id, organization_id, branch_id, name, description, audience_filter, default_channel, created_by)
  values (campaign_id, current_organization_id, target_branch_id, normalized_name, normalized_description, coalesce(target_audience_filter, '{}'::jsonb), normalized_channel, auth.uid());
  insert into public.marketing_drip_steps (organization_id, campaign_id, step_order, delay_hours, channel, message_body)
  select current_organization_id, campaign_id, step_row.step_order, step_row.delay_hours,
    upper(btrim(step_row.channel)), btrim(step_row.message_body)
  from jsonb_to_recordset(target_steps) as step_row(step_order integer, delay_hours integer, channel text, message_body text);
  result := jsonb_build_object('id', campaign_id, 'status', 'DRAFT', 'version', 1, 'replayed', false);
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'marketing_automation.drip_created', 'marketing_drip_campaign', campaign_id::text, target_branch_id, target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result));
  return result;
end;
$$;

create or replace function public.create_marketing_review_request(
  target_customer_id uuid, target_booking_id uuid, target_channel text, target_message_body text,
  target_scheduled_for timestamptz, target_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_organization_id uuid; booking_row public.bookings%rowtype; request_id uuid := gen_random_uuid();
  normalized_channel text := upper(btrim(coalesce(target_channel, ''))); normalized_message text := btrim(coalesce(target_message_body, ''));
  fingerprint text; replay_result jsonb; result jsonb;
begin
  if target_customer_id is null or target_booking_id is null or target_request_id is null
    or normalized_channel not in ('WHATSAPP', 'SMS', 'EMAIL', 'MANUAL')
    or char_length(normalized_message) not between 1 and 4000
    or target_scheduled_for is not null and target_scheduled_for < now() - interval '5 minutes'
  then raise exception using errcode = '22023', message = 'INVALID_MARKETING_REVIEW_REQUEST'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.marketing_automation_request_fingerprint(jsonb_build_object('customer_id', target_customer_id, 'booking_id', target_booking_id, 'channel', normalized_channel, 'message', normalized_message, 'scheduled_for', target_scheduled_for));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0));
  replay_result := app_private.replay_marketing_automation_request(current_organization_id, 'marketing_automation.review_created', target_request_id, fingerprint);
  if replay_result is not null then return replay_result; end if;
  select * into booking_row from public.bookings source_row
  where source_row.organization_id = current_organization_id and source_row.id = target_booking_id
    and source_row.customer_id = target_customer_id and source_row.deleted_at is null for share;
  if not found then raise exception using errcode = 'P0002', message = 'MARKETING_REVIEW_BOOKING_NOT_FOUND'; end if;
  if not app_private.can_access_record(booking_row.organization_id, booking_row.branch_id, booking_row.team_id, booking_row.assigned_user_id)
    or not app_private.can_access_customer(current_organization_id, target_customer_id) then
    raise exception using errcode = '42501', message = 'MARKETING_REVIEW_SCOPE_DENIED'; end if;
  insert into public.customer_review_requests (id, organization_id, branch_id, customer_id, booking_id, channel, message_body, scheduled_for, created_by)
  values (request_id, current_organization_id, booking_row.branch_id, target_customer_id, target_booking_id, normalized_channel, normalized_message, target_scheduled_for, auth.uid());
  result := jsonb_build_object('id', request_id, 'status', 'QUEUED', 'version', 1, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (current_organization_id, target_customer_id, booking_row.lead_id, 'MARKETING_REVIEW_REQUEST_QUEUED', auth.uid(), jsonb_build_object('review_request_id', request_id, 'channel', normalized_channel));
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'marketing_automation.review_created', 'customer_review_request', request_id::text, booking_row.branch_id, target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result));
  return result;
end;
$$;

alter table public.marketing_drip_campaigns enable row level security;
alter table public.marketing_drip_campaigns force row level security;
alter table public.marketing_drip_steps enable row level security;
alter table public.marketing_drip_steps force row level security;
alter table public.customer_review_requests enable row level security;
alter table public.customer_review_requests force row level security;
create policy marketing_drip_campaigns_read on public.marketing_drip_campaigns for select to authenticated using (
  deleted_at is null and app_private.has_permission(organization_id, 'marketing.automation.view') and
  ((branch_id is null and app_private.has_organization_wide_scope(organization_id)) or (branch_id is not null and app_private.can_access_branch(organization_id, branch_id))));
create policy marketing_drip_steps_read on public.marketing_drip_steps for select to authenticated using (
  app_private.has_permission(organization_id, 'marketing.automation.view') and exists (
    select 1 from public.marketing_drip_campaigns campaign_row where campaign_row.id = campaign_id
      and campaign_row.organization_id = marketing_drip_steps.organization_id and campaign_row.deleted_at is null
      and ((campaign_row.branch_id is null and app_private.has_organization_wide_scope(campaign_row.organization_id)) or (campaign_row.branch_id is not null and app_private.can_access_branch(campaign_row.organization_id, campaign_row.branch_id)))));
create policy customer_review_requests_read on public.customer_review_requests for select to authenticated using (
  deleted_at is null and app_private.has_permission(organization_id, 'marketing.automation.view')
  and app_private.can_access_branch(organization_id, branch_id) and app_private.can_access_customer(organization_id, customer_id));
revoke insert, update, delete, truncate on public.marketing_drip_campaigns, public.marketing_drip_steps, public.customer_review_requests from anon, authenticated;
revoke all on function public.get_marketing_automation_workspace(text), public.get_marketing_review_customer_options(text, integer), public.get_marketing_automation_scope_options(), public.create_marketing_drip_campaign(text, text, uuid, text, jsonb, jsonb, uuid), public.create_marketing_review_request(uuid, uuid, text, text, timestamptz, uuid) from public, anon;
grant execute on function public.get_marketing_automation_workspace(text), public.get_marketing_review_customer_options(text, integer), public.get_marketing_automation_scope_options(), public.create_marketing_drip_campaign(text, text, uuid, text, jsonb, jsonb, uuid), public.create_marketing_review_request(uuid, uuid, text, text, timestamptz, uuid) to authenticated;

drop trigger if exists realtime_marketing_drip_campaigns_invalidate on public.marketing_drip_campaigns;
create trigger realtime_marketing_drip_campaigns_invalidate after insert or update on public.marketing_drip_campaigns
for each row execute function app_private.broadcast_tenant_invalidation('marketing');
drop trigger if exists realtime_customer_review_requests_invalidate on public.customer_review_requests;
create trigger realtime_customer_review_requests_invalidate after insert or update on public.customer_review_requests
for each row execute function app_private.broadcast_tenant_invalidation('marketing');

commit;
