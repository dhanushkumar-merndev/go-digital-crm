-- Review requests were queued and never sent.
--
-- create_marketing_review_request inserted a QUEUED row and nothing ever read it:
-- there was no worker for customer_review_requests, so every request sat at
-- "Queued · Awaiting adapter delivery" forever. It also could not have been
-- sent as written. A review request is business-initiated, so WhatsApp only
-- accepts it as an approved Meta template, MSG91 only as a DLT template and
-- Brevo (in this product) only as an approved transactional template. A free
-- text body had no provider that would carry it.
--
-- A request now names an approved template for its channel and the value of
-- each template field. Values may use {{customer_name}}-style fields, resolved
-- here when the request is created so the stored preview is what the customer
-- reads. The Trigger.dev marketing pass claims due requests, sends them through
-- the same provider senders as drip messages, and records SENT or the failure.
-- WhatsApp delivery receipts then move a sent request to DELIVERED.
--
-- MANUAL means the employee sends it themselves, so it is recorded as sent at
-- once (AGENTS.md section 22) instead of waiting for a worker that will never
-- run for it. Rows queued before this change have no template and are failed
-- with REVIEW_TEMPLATE_REQUIRED on the next pass, so the page stops showing
-- them as pending.

begin;

alter table public.customer_review_requests
  add column if not exists whatsapp_template_id uuid references public.whatsapp_business_templates(id),
  add column if not exists template_id uuid references public.templates(id),
  add column if not exists template_variables jsonb not null default '{}'::jsonb,
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_token text,
  add column if not exists lease_until timestamptz,
  add column if not exists safe_error_code text,
  add column if not exists failed_at timestamptz;

create index if not exists customer_review_requests_due_idx
  on public.customer_review_requests (coalesce(next_attempt_at, scheduled_for, created_at), id)
  where status = 'QUEUED' and deleted_at is null;
create index if not exists customer_review_requests_provider_message_idx
  on public.customer_review_requests (organization_id, provider_message_id)
  where provider_message_id is not null;

-- The fields a review template can be filled from. One row of context per booking.
create or replace function app_private.review_request_context(target_organization_id uuid, target_booking_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'customer_name', btrim(coalesce(customer_row.full_name, '')),
    'customer_first_name', split_part(btrim(coalesce(customer_row.full_name, '')), ' ', 1),
    'booking_number', coalesce(booking_row.booking_number, ''),
    'branch_name', coalesce(branch_row.name, ''),
    'branch_phone', coalesce(branch_row.contact_phone, ''),
    'consultant_name', coalesce(consultant_row.full_name, ''),
    'delivery_date', coalesce(to_char(booking_row.expected_delivery_date, 'DD Mon YYYY'), ''),
    'review_link', coalesce(btrim(branch_row.google_review_url), '')
  )
  from public.bookings booking_row
  join public.customers customer_row
    on customer_row.organization_id = booking_row.organization_id and customer_row.id = booking_row.customer_id
  left join public.branches branch_row
    on branch_row.organization_id = booking_row.organization_id and branch_row.id = booking_row.branch_id
  left join public.profiles consultant_row on consultant_row.id = booking_row.assigned_user_id
  where booking_row.organization_id = target_organization_id and booking_row.id = target_booking_id;
$$;

create or replace function app_private.review_field_tokens()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['customer_name', 'customer_first_name', 'booking_number', 'branch_name',
    'branch_phone', 'consultant_name', 'delivery_date', 'review_link'];
$$;

-- Replaces each {{field}} in a value with the context; unknown fields stay as typed.
create or replace function app_private.render_review_value(target_value text, target_context jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  rendered text := coalesce(target_value, '');
  entry record;
begin
  for entry in select key, value from jsonb_each_text(coalesce(target_context, '{}'::jsonb)) loop
    rendered := regexp_replace(rendered, '\{\{\s*' || entry.key || '\s*\}\}',
      replace(coalesce(entry.value, ''), '\', '\\'), 'g');
  end loop;
  return btrim(rendered);
end;
$$;

-- Approved templates the Request review dialog can offer, per channel.
create or replace function public.get_marketing_review_template_options(target_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
begin
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is not null and not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'MARKETING_REVIEW_SCOPE_DENIED';
  end if;
  return jsonb_build_object(
    'tokens', to_jsonb(app_private.review_field_tokens()),
    'channels', jsonb_build_object(
      'WHATSAPP', app_private.drip_channel_connected(current_organization_id, target_branch_id, 'WHATSAPP'),
      'SMS', app_private.drip_channel_connected(current_organization_id, target_branch_id, 'SMS'),
      'EMAIL', true
    ),
    'templates', coalesce((
      select jsonb_agg(option_row order by option_row ->> 'channel', option_row ->> 'name')
      from (
        select jsonb_build_object(
          'id', meta_row.id, 'channel', 'WHATSAPP', 'name', meta_row.name,
          'language', meta_row.language, 'header', meta_row.header_text, 'body', meta_row.body,
          'footer', meta_row.footer_text, 'fields', coalesce(meta_row.fields, '[]'::jsonb)
        ) as option_row
        from public.whatsapp_business_templates meta_row
        join public.connected_accounts account_row
          on account_row.id = meta_row.connected_account_id
         and account_row.organization_id = meta_row.organization_id
         and account_row.provider_key = 'whatsapp_cloud'
         and account_row.status = 'CONNECTED'
         and account_row.deleted_at is null
        where meta_row.organization_id = current_organization_id
          and meta_row.enabled and meta_row.supported and meta_row.meta_status = 'APPROVED'
          and meta_row.removed_from_meta_at is null
          and (target_branch_id is null or account_row.scope_mode = 'ALL_BRANCHES' or exists (
            select 1 from public.integration_branch_mappings mapping_row
            where mapping_row.connected_account_id = account_row.id
              and mapping_row.branch_id = target_branch_id and mapping_row.deleted_at is null))
        union all
        select jsonb_build_object(
          'id', template_row.id, 'channel', template_row.channel, 'name', template_row.name,
          'language', null, 'header', null, 'body', template_row.content ->> 'body',
          'footer', null, 'fields', coalesce(template_row.placeholders, '[]'::jsonb)
        )
        from public.templates template_row
        where template_row.organization_id = current_organization_id
          and template_row.deleted_at is null
          and template_row.channel in ('SMS', 'EMAIL')
          and upper(template_row.status) = 'APPROVED'
          and nullif(btrim(template_row.provider_template_id), '') is not null
      ) options
    ), '[]'::jsonb)
  );
end;
$$;

drop function if exists public.create_marketing_review_request(uuid, uuid, text, text, timestamptz, uuid);
create or replace function public.create_marketing_review_request(
  target_customer_id uuid, target_booking_id uuid, target_channel text, target_message_body text,
  target_scheduled_for timestamptz, target_request_id uuid,
  target_template_id uuid default null, target_template_variables jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_organization_id uuid; booking_row public.bookings%rowtype; customer_row public.customers%rowtype;
  request_id uuid := gen_random_uuid();
  normalized_channel text := upper(btrim(coalesce(target_channel, ''))); normalized_message text := btrim(coalesce(target_message_body, ''));
  fingerprint text; replay_result jsonb; result jsonb;
  meta_row public.whatsapp_business_templates%rowtype; template_row public.templates%rowtype;
  template_fields jsonb := '[]'::jsonb; context jsonb; resolved jsonb := '{}'::jsonb;
  field_name text; field_value text; preview text; initial_status text;
begin
  if target_customer_id is null or target_booking_id is null or target_request_id is null
    or normalized_channel not in ('WHATSAPP', 'SMS', 'EMAIL', 'MANUAL')
    or (normalized_channel = 'MANUAL' and char_length(normalized_message) not between 1 and 4000)
    or jsonb_typeof(coalesce(target_template_variables, '{}'::jsonb)) <> 'object'
    or target_scheduled_for is not null and target_scheduled_for < now() - interval '5 minutes'
  then raise exception using errcode = '22023', message = 'INVALID_MARKETING_REVIEW_REQUEST'; end if;
  if normalized_channel <> 'MANUAL' and target_template_id is null then
    raise exception using errcode = '22023', message = 'REVIEW_TEMPLATE_REQUIRED'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not app_private.has_permission(current_organization_id, 'marketing.automation.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.marketing_automation_request_fingerprint(jsonb_build_object('customer_id', target_customer_id, 'booking_id', target_booking_id, 'channel', normalized_channel, 'message', normalized_message, 'scheduled_for', target_scheduled_for, 'template_id', target_template_id, 'variables', coalesce(target_template_variables, '{}'::jsonb)));
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
  select * into customer_row from public.customers source_customer
  where source_customer.organization_id = current_organization_id and source_customer.id = target_customer_id
    and source_customer.deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'MARKETING_REVIEW_BOOKING_NOT_FOUND'; end if;

  if normalized_channel = 'MANUAL' then
    preview := normalized_message;
    initial_status := 'SENT';
  else
    if exists (
      select 1 from public.customer_marketing_opt_outs opt_out_row
      where opt_out_row.organization_id = current_organization_id
        and opt_out_row.customer_id = target_customer_id
        and opt_out_row.channel = normalized_channel and opt_out_row.revoked_at is null
    ) then raise exception using errcode = '22023', message = 'REVIEW_CUSTOMER_OPTED_OUT'; end if;
    if (normalized_channel = 'EMAIL' and nullif(btrim(customer_row.primary_email), '') is null)
      or (normalized_channel = 'WHATSAPP' and coalesce(nullif(btrim(customer_row.whatsapp_phone), ''), nullif(btrim(customer_row.primary_phone), '')) is null)
      or (normalized_channel = 'SMS' and nullif(btrim(customer_row.primary_phone), '') is null)
    then raise exception using errcode = '22023', message = 'REVIEW_RECIPIENT_MISSING'; end if;

    if normalized_channel = 'WHATSAPP' then
      select template_source.* into meta_row
      from public.whatsapp_business_templates template_source
      join public.connected_accounts account_row
        on account_row.id = template_source.connected_account_id
       and account_row.organization_id = template_source.organization_id
       and account_row.provider_key = 'whatsapp_cloud' and account_row.status = 'CONNECTED'
       and account_row.deleted_at is null
      where template_source.organization_id = current_organization_id and template_source.id = target_template_id
        and template_source.enabled and template_source.supported and template_source.meta_status = 'APPROVED'
        and template_source.removed_from_meta_at is null
        and (account_row.scope_mode = 'ALL_BRANCHES' or exists (
          select 1 from public.integration_branch_mappings mapping_row
          where mapping_row.connected_account_id = account_row.id
            and mapping_row.branch_id = booking_row.branch_id and mapping_row.deleted_at is null));
      if not found then raise exception using errcode = '22023', message = 'REVIEW_TEMPLATE_NOT_AVAILABLE'; end if;
      template_fields := coalesce(meta_row.fields, '[]'::jsonb);
    else
      if normalized_channel = 'SMS'
        and not app_private.drip_channel_connected(current_organization_id, booking_row.branch_id, 'SMS') then
        raise exception using errcode = '22023', message = 'REVIEW_CHANNEL_NOT_CONNECTED'; end if;
      select template_source.* into template_row from public.templates template_source
      where template_source.organization_id = current_organization_id and template_source.id = target_template_id
        and template_source.deleted_at is null and template_source.channel = normalized_channel
        and upper(template_source.status) = 'APPROVED'
        and nullif(btrim(template_source.provider_template_id), '') is not null;
      if not found then raise exception using errcode = '22023', message = 'REVIEW_TEMPLATE_NOT_AVAILABLE'; end if;
      template_fields := coalesce(template_row.placeholders, '[]'::jsonb);
    end if;

    context := app_private.review_request_context(current_organization_id, target_booking_id);
    for field_name in select jsonb_array_elements_text(template_fields) loop
      field_value := app_private.render_review_value(target_template_variables ->> field_name, context);
      if char_length(field_value) not between 1 and 1000 then
        raise exception using errcode = '22023', message = 'REVIEW_TEMPLATE_VARIABLE_REQUIRED',
          detail = field_name;
      end if;
      resolved := resolved || jsonb_build_object(field_name, field_value);
    end loop;

    if normalized_channel = 'WHATSAPP' then
      preview := concat_ws(E'\n\n', nullif(meta_row.header_text, ''), meta_row.body, nullif(meta_row.footer_text, ''));
      for field_name, field_value in select key, value from jsonb_each_text(resolved) loop
        preview := replace(preview, '{{' || split_part(field_name, ':', 2) || '}}', field_value);
      end loop;
    else
      preview := app_private.render_drip_body(template_row.content ->> 'body', resolved);
    end if;
    preview := left(coalesce(nullif(btrim(preview), ''), 'Review request'), 4000);
    initial_status := 'QUEUED';
  end if;

  insert into public.customer_review_requests (
    id, organization_id, branch_id, customer_id, booking_id, channel, message_body, scheduled_for,
    created_by, status, sent_at, whatsapp_template_id, template_id, template_variables, next_attempt_at)
  values (
    request_id, current_organization_id, booking_row.branch_id, target_customer_id, target_booking_id,
    normalized_channel, preview, target_scheduled_for, auth.uid(), initial_status,
    case when initial_status = 'SENT' then now() end,
    case when normalized_channel = 'WHATSAPP' then target_template_id end,
    case when normalized_channel in ('SMS', 'EMAIL') then target_template_id end,
    resolved, case when initial_status = 'QUEUED' then coalesce(target_scheduled_for, now()) end);
  result := jsonb_build_object('id', request_id, 'status', initial_status, 'version', 1, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (current_organization_id, target_customer_id, booking_row.lead_id,
    case when initial_status = 'SENT' then 'MARKETING_REVIEW_REQUEST_SENT' else 'MARKETING_REVIEW_REQUEST_QUEUED' end,
    auth.uid(), jsonb_build_object('review_request_id', request_id, 'channel', normalized_channel,
      'mode', case when normalized_channel = 'MANUAL' then 'MANUAL' else 'PROVIDER' end));
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'marketing_automation.review_created', 'customer_review_request', request_id::text, booking_row.branch_id, target_request_id, jsonb_build_object('fingerprint', fingerprint, 'result', result));
  return result;
end;
$$;

-- Worker claim. Status stays QUEUED while leased; an expired lease is claimable
-- again, so a worker that died mid-send does not strand the request.
create or replace function public.claim_due_review_requests(target_worker_id text, target_batch_size integer default 20)
returns table(
  id uuid, organization_id uuid, channel text, template_provider_id text, template_language text,
  template_fields jsonb, template_parameter_format text, template_variables jsonb, recipient text,
  connected_account_id uuid, application_message_id uuid, lease_token text
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
    or target_batch_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_WORKER_CLAIM';
  end if;

  update public.customer_review_requests request_row
  set status = 'FAILED', failed_at = now(), safe_error_code = 'REVIEW_TEMPLATE_REQUIRED',
    version = request_row.version + 1, updated_at = now()
  where request_row.status = 'QUEUED' and request_row.deleted_at is null
    and request_row.whatsapp_template_id is null and request_row.template_id is null;

  update public.customer_review_requests request_row
  set status = 'CANCELLED', safe_error_code = 'REVIEW_CUSTOMER_OPTED_OUT',
    version = request_row.version + 1, updated_at = now()
  where request_row.status = 'QUEUED' and request_row.deleted_at is null
    and exists (
      select 1 from public.customer_marketing_opt_outs opt_out_row
      where opt_out_row.organization_id = request_row.organization_id
        and opt_out_row.customer_id = request_row.customer_id
        and opt_out_row.channel = request_row.channel and opt_out_row.revoked_at is null);

  return query
  with candidates as (
    select request_row.id
    from public.customer_review_requests request_row
    where request_row.status = 'QUEUED' and request_row.deleted_at is null
      and request_row.channel in ('WHATSAPP', 'SMS', 'EMAIL')
      and coalesce(request_row.next_attempt_at, request_row.scheduled_for, request_row.created_at) <= now()
      and (request_row.lease_until is null or request_row.lease_until < now())
    order by coalesce(request_row.next_attempt_at, request_row.scheduled_for, request_row.created_at), request_row.id
    for update of request_row skip locked
    limit target_batch_size
  ), claimed as (
    update public.customer_review_requests request_row
    set attempts = request_row.attempts + 1,
      lease_token = target_worker_id || ':' || gen_random_uuid()::text,
      lease_until = now() + interval '10 minutes'
    from candidates
    where request_row.id = candidates.id
    returning request_row.*
  )
  select claimed.id, claimed.organization_id, claimed.channel,
    case when claimed.channel = 'WHATSAPP' then meta_row.name else template_row.provider_template_id end,
    meta_row.language,
    case when claimed.channel = 'WHATSAPP' then meta_row.fields else template_row.placeholders end,
    meta_row.parameter_format,
    claimed.template_variables,
    -- Normalized numbers carry the country code; a bare 10-digit primary_phone
    -- is not routable by Meta or MSG91.
    case claimed.channel
      when 'EMAIL' then nullif(btrim(customer_row.primary_email), '')
      when 'WHATSAPP' then coalesce(nullif(btrim(customer_row.normalized_whatsapp_phone), ''),
        nullif(btrim(customer_row.whatsapp_phone), ''), nullif(btrim(customer_row.normalized_phone), ''),
        nullif(btrim(customer_row.primary_phone), ''))
      else coalesce(nullif(btrim(customer_row.normalized_phone), ''), nullif(btrim(customer_row.primary_phone), ''))
    end,
    case when claimed.channel = 'WHATSAPP' then meta_account.id else connection_row.id end,
    -- Stable per request, so a retry after an unknown outcome reuses the
    -- provider's idempotency key instead of sending a second copy.
    claimed.id,
    claimed.lease_token
  from claimed
  join public.customers customer_row
    on customer_row.organization_id = claimed.organization_id and customer_row.id = claimed.customer_id
   and customer_row.deleted_at is null
  left join public.whatsapp_business_templates meta_row
    on meta_row.id = claimed.whatsapp_template_id and meta_row.organization_id = claimed.organization_id
   and meta_row.enabled and meta_row.supported and meta_row.meta_status = 'APPROVED'
   and meta_row.removed_from_meta_at is null
  left join public.connected_accounts meta_account
    on meta_account.id = meta_row.connected_account_id and meta_account.organization_id = claimed.organization_id
   and meta_account.provider_key = 'whatsapp_cloud' and meta_account.status = 'CONNECTED'
   and meta_account.deleted_at is null
  left join public.templates template_row
    on template_row.id = claimed.template_id and template_row.organization_id = claimed.organization_id
   and template_row.deleted_at is null and upper(template_row.status) = 'APPROVED'
  left join lateral (
    select account_row.id
    from public.connected_accounts account_row
    where ((claimed.channel = 'SMS' and account_row.provider_key = 'msg91')
        or (claimed.channel = 'EMAIL' and account_row.provider_key = 'brevo'))
      and account_row.organization_id = claimed.organization_id
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
      and (account_row.scope_mode = 'ALL_BRANCHES' or exists (
        select 1 from public.integration_branch_mappings mapping_row
        where mapping_row.connected_account_id = account_row.id
          and mapping_row.branch_id = claimed.branch_id and mapping_row.deleted_at is null))
    order by account_row.created_at
    limit 1
  ) connection_row on true;
end;
$$;

create or replace function public.complete_review_request(
  target_request_id uuid, target_lease_token text, target_provider_message_id text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.customer_review_requests%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_provider_message_id, ''))) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_COMPLETION';
  end if;
  update public.customer_review_requests source_row
  set status = 'SENT', sent_at = now(), provider_message_id = btrim(target_provider_message_id),
    lease_token = null, lease_until = null, next_attempt_at = null, safe_error_code = null,
    version = source_row.version + 1, updated_at = now()
  where source_row.id = target_request_id and source_row.status = 'QUEUED'
    and source_row.lease_token = target_lease_token
  returning source_row.* into request_row;
  if not found then return false; end if;
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  select request_row.organization_id, request_row.customer_id, booking_row.lead_id,
    'MARKETING_REVIEW_REQUEST_SENT', null,
    jsonb_build_object('review_request_id', request_row.id, 'channel', request_row.channel, 'mode', 'PROVIDER')
  from public.bookings booking_row
  where booking_row.organization_id = request_row.organization_id and booking_row.id = request_row.booking_id;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata)
  values (request_row.organization_id, null, 'marketing_automation.review_sent', 'customer_review_request',
    request_row.id::text, request_row.branch_id,
    jsonb_build_object('channel', request_row.channel, 'attempts', request_row.attempts));
  return true;
end;
$$;

-- Permanent provider rejections fail at once; anything else retries twice more,
-- five then ten minutes later.
create or replace function public.fail_review_request(
  target_request_id uuid, target_lease_token text, target_safe_error_code text, target_permanent boolean
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.customer_review_requests%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if coalesce(target_safe_error_code, '') !~ '^[A-Z0-9_]{3,100}$' then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_FAILURE';
  end if;
  update public.customer_review_requests source_row
  set status = case when coalesce(target_permanent, false) or source_row.attempts >= 3 then 'FAILED' else 'QUEUED' end,
    failed_at = case when coalesce(target_permanent, false) or source_row.attempts >= 3 then now() end,
    next_attempt_at = case when coalesce(target_permanent, false) or source_row.attempts >= 3 then null
      else now() + make_interval(mins => 5 * source_row.attempts) end,
    safe_error_code = target_safe_error_code,
    lease_token = null, lease_until = null,
    version = source_row.version + 1, updated_at = now()
  where source_row.id = target_request_id and source_row.status = 'QUEUED'
    and source_row.lease_token = target_lease_token
  returning source_row.* into request_row;
  if not found then return null; end if;
  if request_row.status = 'FAILED' then
    insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata)
    values (request_row.organization_id, null, 'marketing_automation.review_failed', 'customer_review_request',
      request_row.id::text, request_row.branch_id,
      jsonb_build_object('channel', request_row.channel, 'attempts', request_row.attempts,
        'safe_error_code', target_safe_error_code));
  end if;
  return request_row.status;
end;
$$;

revoke all on function public.get_marketing_review_template_options(uuid),
  public.create_marketing_review_request(uuid, uuid, text, text, timestamptz, uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.get_marketing_review_template_options(uuid),
  public.create_marketing_review_request(uuid, uuid, text, text, timestamptz, uuid, uuid, jsonb)
  to authenticated;
revoke all on function public.claim_due_review_requests(text, integer),
  public.complete_review_request(uuid, text, text),
  public.fail_review_request(uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_due_review_requests(text, integer),
  public.complete_review_request(uuid, text, text),
  public.fail_review_request(uuid, text, text, boolean)
  to service_role;
revoke all on function app_private.review_request_context(uuid, uuid),
  app_private.render_review_value(text, jsonb), app_private.review_field_tokens()
  from public, anon, authenticated;

-- Patched from the deployed definition: review receipts.
CREATE OR REPLACE FUNCTION public.apply_whatsapp_message_status(target_organization_id uuid, target_connection_id uuid, target_provider_message_id text, target_application_message_id uuid, target_delivery_status text, target_occurred_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  matching_message_ids uuid[];
  target_message_id uuid;
  current_provider_message_id text;
  current_delivery_status text;
  current_status_at timestamptz;
  current_rank integer;
  target_rank integer;
  status_updated boolean := false;
  review_request_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null
    or target_connection_id is null
    or nullif(btrim(target_provider_message_id), '') is null
    or char_length(target_provider_message_id) > 512
    or target_delivery_status is null
    or target_delivery_status not in ('SENT', 'DELIVERED', 'READ', 'FAILED')
    or target_occurred_at is null
    or target_occurred_at < timestamptz '2000-01-01 00:00:00+00'
    or target_occurred_at > now() + interval '10 minutes'
  then
    raise exception using errcode = '22023', message = 'INVALID_WHATSAPP_MESSAGE_STATUS';
  end if;
  if not exists (
    select 1
    from public.connected_accounts connection_row
    where connection_row.id = target_connection_id
      and connection_row.organization_id = target_organization_id
      and connection_row.provider_key = 'whatsapp_cloud'
      and connection_row.status = 'CONNECTED'
      and connection_row.deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'ACTIVE_WHATSAPP_CONNECTION_NOT_FOUND';
  end if;

  select array_agg(message_row.id order by message_row.id)
  into matching_message_ids
  from public.conversation_messages message_row
  join public.conversations conversation_row
    on conversation_row.organization_id = message_row.organization_id
   and conversation_row.id = message_row.conversation_id
  where message_row.organization_id = target_organization_id
    and conversation_row.connection_id = target_connection_id
    and message_row.provider_message_id = btrim(target_provider_message_id)
    and message_row.direction = 'OUTBOUND';
  if coalesce(cardinality(matching_message_ids), 0) > 1 then
    raise exception using errcode = '23514', message = 'WHATSAPP_PROVIDER_MESSAGE_AMBIGUOUS';
  end if;
  target_message_id := matching_message_ids[1];

  if target_message_id is null and target_application_message_id is not null then
    select message_row.id into target_message_id
    from public.conversation_messages message_row
    join public.conversations conversation_row
      on conversation_row.organization_id = message_row.organization_id
     and conversation_row.id = message_row.conversation_id
    where message_row.organization_id = target_organization_id
      and conversation_row.connection_id = target_connection_id
      and message_row.application_message_id = target_application_message_id
      and message_row.direction = 'OUTBOUND';
  end if;
  if target_message_id is null then
    -- A review request is sent outside any conversation, so its receipt lands
    -- on the request. Only a SENT request moves; a later FAILED never undoes a
    -- delivery that was already confirmed.
    select request_row.id into review_request_id
    from public.customer_review_requests request_row
    where request_row.organization_id = target_organization_id
      and request_row.channel = 'WHATSAPP'
      and request_row.provider_message_id = btrim(target_provider_message_id);
    if review_request_id is not null then
      update public.customer_review_requests request_row
      set status = case when target_delivery_status = 'FAILED' then 'FAILED' else 'DELIVERED' end,
        failed_at = case when target_delivery_status = 'FAILED' then target_occurred_at end,
        safe_error_code = case when target_delivery_status = 'FAILED' then 'REVIEW_WHATSAPP_DELIVERY_FAILED' end,
        version = request_row.version + 1, updated_at = now()
      where request_row.id = review_request_id and request_row.status = 'SENT'
        and target_delivery_status in ('DELIVERED', 'READ', 'FAILED');
      return jsonb_build_object('matched', true, 'updated', found, 'review_request_id', review_request_id);
    end if;
    return jsonb_build_object('matched', false, 'updated', false);
  end if;

  select message_row.provider_message_id, message_row.delivery_status,
    message_row.provider_status_at
  into current_provider_message_id, current_delivery_status, current_status_at
  from public.conversation_messages message_row
  where message_row.id = target_message_id
    and message_row.organization_id = target_organization_id
  for update;
  if current_provider_message_id is not null
    and current_provider_message_id <> btrim(target_provider_message_id)
  then
    raise exception using errcode = '23514', message = 'WHATSAPP_PROVIDER_MESSAGE_CONFLICT';
  end if;

  current_rank := case upper(coalesce(current_delivery_status, ''))
    when 'READ' then 4
    when 'DELIVERED' then 3
    when 'SENT' then 2
    when 'FAILED' then 2
    else 1
  end;
  target_rank := case target_delivery_status
    when 'READ' then 4
    when 'DELIVERED' then 3
    else 2
  end;
  if target_rank >= current_rank
    and (current_status_at is null or target_occurred_at >= current_status_at)
  then
    update public.conversation_messages message_row
    set provider_message_id = coalesce(
          message_row.provider_message_id,
          btrim(target_provider_message_id)
        ),
        delivery_status = target_delivery_status,
        provider_status_at = target_occurred_at,
        safe_error_code = null
    where message_row.id = target_message_id;
    status_updated := true;
  end if;

  return jsonb_build_object(
    'matched', true,
    'updated', status_updated,
    'message_id', target_message_id
  );
end;
$function$;

-- Patched from the deployed definition: failure reason, provider-only sent count.
CREATE OR REPLACE FUNCTION public.get_marketing_automation_workspace(target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'step_count', step_count, 'version', version, 'updated_at', updated_at,
      'trigger_type', trigger_type, 'trigger_conditions', trigger_conditions,
      'activated_at', activated_at,
      'channels', coalesce((
        select jsonb_agg(distinct channel_row.channel)
        from public.marketing_drip_steps step_row
        join public.marketing_drip_step_channels channel_row on channel_row.step_id = step_row.id
        where step_row.campaign_id = page_row.id and step_row.active
      ), jsonb_build_array(default_channel)),
      'stats', (
        select jsonb_build_object(
          'enrolled', count(distinct enrollment_row.id),
          'sent', count(message_row.id) filter (where message_row.status = 'SENT'),
          'queued', count(message_row.id) filter (where message_row.status in ('QUEUED', 'SENDING')),
          'failed', count(message_row.id) filter (where message_row.status = 'FAILED'),
          'skipped', count(message_row.id) filter (where message_row.status = 'CANCELLED' and message_row.skip_reason is not null)
        )
        from public.customer_drip_enrollments enrollment_row
        left join public.customer_drip_messages message_row on message_row.enrollment_id = enrollment_row.id
        where enrollment_row.organization_id = page_row.organization_id
          and enrollment_row.source_campaign_id = page_row.id
      )
    ) order by updated_at desc, id desc) from (select * from campaigns order by updated_at desc, id desc limit 25) page_row), '[]'::jsonb),
    'review_kpis', jsonb_build_object(
      'queued', (select count(*) from reviews where status = 'QUEUED'),
      'sent_today', (select count(*) from reviews where channel <> 'MANUAL' and sent_at is not null
        and timezone(target_timezone, sent_at)::date = timezone(target_timezone, now())::date),
      'delivered', (select count(*) from reviews where status in ('DELIVERED', 'COMPLETED')),
      'completed', (select count(*) from reviews where status = 'COMPLETED')
    ),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'customer_id', customer_id, 'customer_name', customer_name,
      'customer_phone', customer_phone, 'booking_id', booking_id, 'booking_number', booking_number,
      'channel', channel, 'status', status, 'scheduled_for', scheduled_for,
      'sent_at', sent_at, 'safe_error_code', safe_error_code, 'created_at', created_at, 'updated_at', updated_at, 'version', version
    ) order by updated_at desc, id desc) from (select * from reviews order by updated_at desc, id desc limit 25) page_row), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

commit;
