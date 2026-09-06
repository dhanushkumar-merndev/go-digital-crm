-- marketing_campaigns tracks ad spend on META and GOOGLE_ADS; nothing in this
-- system could send one message to a chosen audience. This adds that, on the
-- same claim/lease/backoff shape the drip dispatcher uses, and under the same
-- rule: a blast is never inside anyone's 24h service window, so it can only be
-- composed from a template the provider already approved.

create table public.bulk_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  name text not null,
  channel text not null,
  template_id uuid not null references public.templates(id),
  template_variables jsonb not null default '{}'::jsonb,
  -- Optional creative from the asset library. Held by reference so archiving the
  -- asset never breaks a campaign that already went out.
  asset_id uuid references public.marketing_assets(id),
  -- Kept for the record only. The recipient set is materialised once at
  -- creation, so re-reading this later could never change who was sent to.
  audience_filter jsonb not null default '{}'::jsonb,
  status text not null default 'QUEUED',
  recipient_count integer not null default 0,
  created_by uuid not null references public.profiles(id),
  cancelled_at timestamptz,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (char_length(btrim(name)) between 3 and 180),
  check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED')),
  check (jsonb_typeof(audience_filter) = 'object'),
  check (jsonb_typeof(template_variables) = 'object'),
  check (recipient_count >= 0)
);

create table public.bulk_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  campaign_id uuid not null references public.bulk_campaigns(id) on delete restrict,
  customer_id uuid not null references public.customers(id),
  -- Resolved and frozen at creation: the address reviewed is the address sent to.
  recipient text not null,
  status text not null default 'QUEUED',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token text,
  provider_message_id text,
  safe_error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One send per customer per campaign, enforced rather than trusted.
  unique (campaign_id, customer_id),
  unique (organization_id, id),
  check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
  check (attempts between 0 and 10)
);

alter table public.bulk_campaigns
  add constraint bulk_campaigns_branch_org_fk foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) not valid,
  add constraint bulk_campaigns_creator_org_fk foreign key (organization_id, created_by)
    references public.profiles (organization_id, id) not valid;
alter table public.bulk_campaign_recipients
  add constraint bulk_campaign_recipients_campaign_org_fk
    foreign key (organization_id, campaign_id)
    references public.bulk_campaigns (organization_id, id) not valid,
  add constraint bulk_campaign_recipients_customer_org_fk
    foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) not valid;

create index bulk_campaigns_workspace_idx
  on public.bulk_campaigns (organization_id, status, created_at desc, id desc)
  where deleted_at is null;
-- The dispatcher's only query: what is due now, oldest first.
create index bulk_campaign_recipients_due_idx
  on public.bulk_campaign_recipients (next_attempt_at, id) where status = 'QUEUED';
create index bulk_campaign_recipients_campaign_idx
  on public.bulk_campaign_recipients (campaign_id, status);
create index bulk_campaign_recipients_leased_idx
  on public.bulk_campaign_recipients (updated_at) where status = 'SENDING';

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order) values
  ('bulk_campaign_recipients', 'DELETE', 788),
  ('bulk_campaigns', 'DELETE', 789)
on conflict (table_name) do update
  set disposition = excluded.disposition, delete_order = excluded.delete_order;

alter table public.bulk_campaigns enable row level security;
alter table public.bulk_campaigns force row level security;
alter table public.bulk_campaign_recipients enable row level security;
alter table public.bulk_campaign_recipients force row level security;
revoke insert, update, delete, truncate
  on public.bulk_campaigns, public.bulk_campaign_recipients from anon, authenticated;

create policy bulk_campaigns_read on public.bulk_campaigns
  for select to authenticated using (
    app_private.has_permission(organization_id, 'marketing.automation.view')
    and (branch_id is null or app_private.can_access_branch(organization_id, branch_id))
  );
create policy bulk_campaign_recipients_read on public.bulk_campaign_recipients
  for select to authenticated using (
    app_private.has_permission(organization_id, 'marketing.automation.view')
    and exists (
      select 1 from public.bulk_campaigns campaign_row
      where campaign_row.id = campaign_id
        and campaign_row.organization_id = bulk_campaign_recipients.organization_id
        and (campaign_row.branch_id is null
          or app_private.can_access_branch(campaign_row.organization_id, campaign_row.branch_id))
    )
  );

-- Resolves an audience to customers in ONE set-based statement. The cost tracks
-- the rows that match, not the size of the audience: an audience of 50,000 is
-- one insert…select, never 50,000 per-customer lookups. Every filter is
-- optional and narrows; an empty filter means every reachable customer.
create or replace function public.create_bulk_campaign(
  target_name text,
  target_channel text,
  target_template_id uuid,
  target_template_variables jsonb,
  target_asset_id uuid,
  target_branch_id uuid,
  target_audience_filter jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  template_row public.templates%rowtype;
  campaign_id uuid := gen_random_uuid();
  normalized_name text := left(btrim(coalesce(target_name, '')), 180);
  normalized_channel text := upper(btrim(coalesce(target_channel, '')));
  filter_input jsonb := coalesce(target_audience_filter, '{}'::jsonb);
  inserted integer;
  replay_result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or char_length(normalized_name) not between 3 and 180
    or normalized_channel not in ('WHATSAPP', 'SMS', 'EMAIL')
    or jsonb_typeof(filter_input) <> 'object'
  then
    raise exception using errcode = '22023', message = 'INVALID_BULK_CAMPAIGN_INPUT';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'BULK_CAMPAIGN_SCOPE_DENIED';
  end if;

  -- Sending the same request twice is a double submission, not a second blast.
  select audit_row.metadata -> 'result' into replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'bulk_campaign.created'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc limit 1;
  if replay_result is not null then
    return replay_result || jsonb_build_object('replayed', true);
  end if;

  select * into template_row from public.templates
  where id = target_template_id and organization_id = current_organization_id
    and deleted_at is null and upper(status) = 'APPROVED'
    and provider_template_id is not null;
  if not found then
    raise exception using errcode = '22023', message = 'BULK_CAMPAIGN_TEMPLATE_NOT_APPROVED';
  end if;
  if not (
    (normalized_channel = 'EMAIL' and upper(template_row.channel) = 'EMAIL')
    or (normalized_channel = 'SMS' and upper(template_row.channel) = 'SMS')
    or (normalized_channel = 'WHATSAPP'
      and upper(template_row.channel) in ('WHATSAPP', 'WHATSAPP_BUSINESS'))
  ) then
    raise exception using errcode = '22023', message = 'BULK_CAMPAIGN_TEMPLATE_CHANNEL_MISMATCH';
  end if;
  if target_asset_id is not null and not exists (
    select 1 from public.marketing_assets asset_row
    where asset_row.id = target_asset_id
      and asset_row.organization_id = current_organization_id
      and asset_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'BULK_CAMPAIGN_ASSET_NOT_FOUND';
  end if;

  insert into public.bulk_campaigns (
    id, organization_id, branch_id, name, channel, template_id, template_variables,
    asset_id, audience_filter, status, created_by
  ) values (
    campaign_id, current_organization_id, target_branch_id, normalized_name, normalized_channel,
    template_row.id, coalesce(target_template_variables, '{}'::jsonb), target_asset_id,
    filter_input, 'QUEUED', auth.uid()
  );

  -- One statement for the whole audience. distinct on collapses a customer with
  -- several leads to a single recipient, so nobody is messaged twice.
  insert into public.bulk_campaign_recipients (
    organization_id, campaign_id, customer_id, recipient
  )
  select distinct on (customer_row.id)
    current_organization_id, campaign_id, customer_row.id,
    case when normalized_channel = 'EMAIL'
      then customer_row.primary_email else customer_row.primary_phone end
  from public.customers customer_row
  join public.leads lead_row
    on lead_row.customer_id = customer_row.id
   and lead_row.organization_id = customer_row.organization_id
   and lead_row.deleted_at is null
  where customer_row.organization_id = current_organization_id
    and customer_row.deleted_at is null
    and (target_branch_id is null or lead_row.branch_id = target_branch_id)
    and app_private.can_access_branch(current_organization_id, lead_row.branch_id)
    -- A customer with no address on this channel cannot be a recipient.
    and nullif(btrim(case when normalized_channel = 'EMAIL'
      then customer_row.primary_email else customer_row.primary_phone end), '') is not null
    and (
      not filter_input ? 'lifecycle_status'
      or lead_row.lifecycle_status::text in (
        select jsonb_array_elements_text(filter_input -> 'lifecycle_status')
      )
    )
    and (
      not filter_input ? 'temperature'
      or lead_row.temperature::text in (
        select jsonb_array_elements_text(filter_input -> 'temperature')
      )
    )
    and (
      not filter_input ? 'source'
      or lead_row.source in (select jsonb_array_elements_text(filter_input -> 'source'))
    )
    and (
      not filter_input ? 'created_within_days'
      or lead_row.created_at >= now() - make_interval(
        days => greatest(1, least(3650, (filter_input ->> 'created_within_days')::integer))
      )
    )
  order by customer_row.id, lead_row.updated_at desc, lead_row.id desc;
  get diagnostics inserted = row_count;

  update public.bulk_campaigns set recipient_count = inserted, updated_at = now()
  where id = campaign_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'bulk_campaign.created', 'bulk_campaign',
    campaign_id::text, target_branch_id, target_request_id,
    jsonb_build_object(
      'result', jsonb_build_object(
        'id', campaign_id, 'recipient_count', inserted, 'status', 'QUEUED'
      ),
      'audience_filter', filter_input
    )
  );
  return jsonb_build_object(
    'id', campaign_id, 'recipient_count', inserted, 'status', 'QUEUED', 'replayed', false
  );
end;
$$;

create or replace function public.cancel_bulk_campaign(target_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid; cancelled integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_PERMISSION_REQUIRED';
  end if;
  update public.bulk_campaigns
  set status = 'CANCELLED', cancelled_at = now(), updated_at = now()
  where id = target_campaign_id and organization_id = current_organization_id
    and status in ('QUEUED', 'RUNNING') and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'BULK_CAMPAIGN_NOT_CANCELLABLE';
  end if;
  -- Anything already claimed by a worker is left alone: it may be in flight at
  -- the provider, and marking it cancelled would lose the real outcome.
  update public.bulk_campaign_recipients
  set status = 'CANCELLED', updated_at = now()
  where campaign_id = target_campaign_id and status = 'QUEUED';
  get diagnostics cancelled = row_count;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'bulk_campaign.cancelled', 'bulk_campaign',
    target_campaign_id::text, jsonb_build_object('cancelled_recipients', cancelled)
  );
  return cancelled;
end;
$$;

revoke all on function public.create_bulk_campaign(text, text, uuid, jsonb, uuid, uuid, jsonb, uuid)
  from public, anon;
grant execute on function public.create_bulk_campaign(text, text, uuid, jsonb, uuid, uuid, jsonb, uuid)
  to authenticated;
revoke all on function public.cancel_bulk_campaign(uuid) from public, anon;
grant execute on function public.cancel_bulk_campaign(uuid) to authenticated;

-- Claims a bounded batch across all campaigns. Cost tracks the batch size, never
-- the number of queued recipients, so a 50,000-recipient campaign drains at a
-- steady rate instead of being loaded at once.
create or replace function public.claim_due_bulk_messages(
  target_worker_id text,
  target_batch_size integer default 25
)
returns table (
  id uuid, organization_id uuid, campaign_id uuid, channel text,
  template_provider_id text, template_variables jsonb, recipient text,
  connected_account_id uuid, asset_object_file_id uuid, lease_token text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160
    or target_batch_size not between 1 and 200
  then
    raise exception using errcode = '22023', message = 'INVALID_BULK_WORKER_CLAIM';
  end if;

  return query
  with candidates as (
    select recipient_row.id
    from public.bulk_campaign_recipients recipient_row
    join public.bulk_campaigns campaign_row on campaign_row.id = recipient_row.campaign_id
    where recipient_row.status = 'QUEUED'
      and recipient_row.next_attempt_at <= now()
      and campaign_row.status in ('QUEUED', 'RUNNING')
      and campaign_row.deleted_at is null
    order by recipient_row.next_attempt_at, recipient_row.id
    for update of recipient_row skip locked
    limit target_batch_size
  ), claimed as (
    update public.bulk_campaign_recipients recipient_row
    set status = 'SENDING', attempts = recipient_row.attempts + 1,
      lease_token = target_worker_id || ':' || gen_random_uuid()::text,
      updated_at = now()
    from candidates where recipient_row.id = candidates.id
    returning recipient_row.*
  )
  select
    claimed.id, claimed.organization_id, claimed.campaign_id, campaign_row.channel,
    template_row.provider_template_id, campaign_row.template_variables, claimed.recipient,
    connection_row.id, asset_row.object_file_id, claimed.lease_token
  from claimed
  join public.bulk_campaigns campaign_row on campaign_row.id = claimed.campaign_id
  left join public.templates template_row
    on template_row.id = campaign_row.template_id
   and template_row.deleted_at is null
   and upper(template_row.status) = 'APPROVED'
  left join public.marketing_assets asset_row
    on asset_row.id = campaign_row.asset_id and asset_row.deleted_at is null
  -- Only WhatsApp resolves a tenant connection; Brevo is a platform-level key.
  left join lateral (
    select account_row.id
    from public.connected_accounts account_row
    where campaign_row.channel = 'WHATSAPP'
      and account_row.organization_id = claimed.organization_id
      and account_row.provider_key = 'whatsapp_cloud'
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
      and (
        account_row.scope_mode = 'ALL_BRANCHES'
        or exists (
          select 1 from public.integration_branch_mappings mapping_row
          where mapping_row.connected_account_id = account_row.id
            and mapping_row.branch_id = campaign_row.branch_id
        )
      )
    order by account_row.created_at limit 1
  ) connection_row on true;
end;
$$;

create or replace function public.complete_bulk_message(
  target_recipient_id uuid,
  target_lease_token text,
  target_provider_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare updated_rows integer; owning_campaign uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.bulk_campaign_recipients
  set status = 'SENT', sent_at = now(), updated_at = now(),
    provider_message_id = left(btrim(coalesce(target_provider_message_id, '')), 200),
    safe_error_code = null
  where id = target_recipient_id and lease_token = target_lease_token and status = 'SENDING'
  returning campaign_id into owning_campaign;
  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then return false; end if;

  -- A campaign with nothing left to attempt is finished.
  update public.bulk_campaigns campaign_row
  set status = 'COMPLETED', completed_at = now(), updated_at = now()
  where campaign_row.id = owning_campaign
    and campaign_row.status in ('QUEUED', 'RUNNING')
    and not exists (
      select 1 from public.bulk_campaign_recipients pending_row
      where pending_row.campaign_id = owning_campaign
        and pending_row.status in ('QUEUED', 'SENDING')
    );
  -- Otherwise it is visibly under way rather than still merely queued.
  update public.bulk_campaigns
  set status = 'RUNNING', updated_at = now()
  where id = owning_campaign and status = 'QUEUED';
  return true;
end;
$$;

create or replace function public.retry_bulk_message(
  target_recipient_id uuid,
  target_lease_token text,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_row public.bulk_campaign_recipients%rowtype;
  normalized_code text := left(btrim(coalesce(target_safe_error_code, '')), 100);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if normalized_code !~ '^[A-Z0-9_]{3,100}$' then
    normalized_code := 'BULK_SEND_RETRY';
  end if;
  select * into recipient_row from public.bulk_campaign_recipients
  where id = target_recipient_id and lease_token = target_lease_token and status = 'SENDING'
  for update;
  if not found then return false; end if;

  if recipient_row.attempts >= 10 then
    update public.bulk_campaign_recipients
    set status = 'FAILED', safe_error_code = normalized_code, updated_at = now()
    where id = recipient_row.id;
  else
    update public.bulk_campaign_recipients
    set status = 'QUEUED', safe_error_code = normalized_code, updated_at = now(),
      next_attempt_at = now() + least(interval '6 hours',
        interval '2 minutes' * power(2, least(recipient_row.attempts, 6)))
    where id = recipient_row.id;
  end if;
  return true;
end;
$$;

create or replace function public.release_stalled_bulk_messages(
  target_stale_minutes integer default 15
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare released integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_stale_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'INVALID_BULK_STALE_WINDOW';
  end if;
  update public.bulk_campaign_recipients
  set status = 'QUEUED', lease_token = null, next_attempt_at = now(),
    safe_error_code = 'BULK_LEASE_EXPIRED', updated_at = now()
  where status = 'SENDING' and updated_at < now() - make_interval(mins => target_stale_minutes);
  get diagnostics released = row_count;
  return released;
end;
$$;

create or replace function public.get_bulk_campaign_workspace(
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid; offset_rows integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.view')
  then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_PERMISSION_REQUIRED';
  end if;
  if target_page not between 1 and 100000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_BULK_CAMPAIGN_PAGE';
  end if;
  offset_rows := (target_page - 1) * target_page_size;
  return jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', campaign_row.id, 'name', campaign_row.name, 'channel', campaign_row.channel,
        'status', campaign_row.status, 'recipient_count', campaign_row.recipient_count,
        'created_at', campaign_row.created_at,
        -- Counted per campaign in one grouped pass, not once per campaign row.
        'sent', coalesce(progress_row.sent, 0),
        'failed', coalesce(progress_row.failed, 0),
        'pending', coalesce(progress_row.pending, 0)
      ) order by campaign_row.created_at desc, campaign_row.id desc)
      from (
        select * from public.bulk_campaigns
        where organization_id = current_organization_id and deleted_at is null
          and (branch_id is null
            or app_private.can_access_branch(current_organization_id, branch_id))
        order by created_at desc, id desc limit target_page_size offset offset_rows
      ) campaign_row
      left join (
        select recipient_row.campaign_id,
          count(*) filter (where recipient_row.status = 'SENT') as sent,
          count(*) filter (where recipient_row.status = 'FAILED') as failed,
          count(*) filter (where recipient_row.status in ('QUEUED', 'SENDING')) as pending
        from public.bulk_campaign_recipients recipient_row
        where recipient_row.organization_id = current_organization_id
        group by recipient_row.campaign_id
      ) progress_row on progress_row.campaign_id = campaign_row.id
    ), '[]'::jsonb),
    'total', (
      select count(*)::integer from public.bulk_campaigns
      where organization_id = current_organization_id and deleted_at is null
        and (branch_id is null
          or app_private.can_access_branch(current_organization_id, branch_id))
    )
  );
end;
$$;

revoke all on function public.claim_due_bulk_messages(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_bulk_messages(text, integer) to service_role;
revoke all on function public.complete_bulk_message(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_bulk_message(uuid, text, text) to service_role;
revoke all on function public.retry_bulk_message(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.retry_bulk_message(uuid, text, text) to service_role;
revoke all on function public.release_stalled_bulk_messages(integer)
  from public, anon, authenticated;
grant execute on function public.release_stalled_bulk_messages(integer) to service_role;
revoke all on function public.get_bulk_campaign_workspace(integer, integer) from public, anon;
grant execute on function public.get_bulk_campaign_workspace(integer, integer) to authenticated;
