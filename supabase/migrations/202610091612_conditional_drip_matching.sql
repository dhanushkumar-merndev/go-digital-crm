begin;

-- Conditional drip matching and delivery.
--
-- run_event_drip_matches (service role, every minute from marketing-dispatch)
-- enrolls new leads, birthdays, anniversaries, bookings, deliveries and
-- delivery anniversaries into their active event campaigns, renders each
-- placeholder from the customer/lead and queues one message per step channel.
--
-- claim_due_drip_messages re-checks DORMANT, opt-outs and paused event
-- campaigns at send time, claims HOT before WARM before COLD (AGENTS.md 9.7),
-- sends to a lead's own phone/email when no customer is linked yet, and
-- resolves the tenant MSG91 connection for SMS as it does WhatsApp.
-- complete_drip_message writes a DRIP_MESSAGE_SENT timeline activity.
--
-- The hourly audience match is limited to AUDIENCE campaigns, and a new insert
-- trigger keeps a delayed step from being sent before its scheduled time.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

-- A step's send time is its own clock. Inserts that left next_attempt_at at its
-- now() default made every step of a sequence go out at once.
create or replace function app_private.drip_message_start_at_schedule()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.next_attempt_at := greatest(coalesce(new.next_attempt_at, new.scheduled_for), new.scheduled_for);
  return new;
end;
$function$;
revoke all on function app_private.drip_message_start_at_schedule() from public, anon, authenticated;
drop trigger if exists drip_message_start_at_schedule on public.customer_drip_messages;
create trigger drip_message_start_at_schedule
  before insert on public.customer_drip_messages
  for each row execute function app_private.drip_message_start_at_schedule();

-- Tokens a template placeholder can be mapped to.
create or replace function app_private.drip_variable_tokens()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array['customer_name', 'customer_first_name', 'interested_model', 'vehicle_model',
    'lead_source', 'branch_name', 'branch_phone', 'consultant_name', 'booking_number',
    'delivery_date']::text[];
$function$;
revoke all on function app_private.drip_variable_tokens() from public, anon;
grant execute on function app_private.drip_variable_tokens() to authenticated;

-- placeholder -> token map, resolved against one recipient's context. Providers
-- reject an empty parameter, so a missing value falls back to neutral text.
create or replace function app_private.render_drip_variables(target_map jsonb, target_context jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select coalesce(jsonb_object_agg(
    entry.key,
    coalesce(
      nullif(btrim(coalesce(target_context, '{}'::jsonb) ->> (entry.value #>> '{}')), ''),
      case entry.value #>> '{}'
        when 'customer_name' then 'Customer'
        when 'customer_first_name' then 'Customer'
        when 'interested_model' then 'your new car'
        when 'vehicle_model' then 'your car'
        else '-'
      end
    )
  ), '{}'::jsonb)
  from jsonb_each(coalesce(target_map, '{}'::jsonb)) entry;
$function$;
revoke all on function app_private.render_drip_variables(jsonb, jsonb) from public, anon, authenticated;

-- The copy the customer receives, kept on the message for review and history.
create or replace function app_private.render_drip_body(target_body text, target_variables jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  rendered text := coalesce(target_body, '');
  entry record;
begin
  for entry in select key, value from jsonb_each_text(coalesce(target_variables, '{}'::jsonb)) loop
    rendered := regexp_replace(
      rendered,
      '\{\{\s*' || entry.key || '\s*\}\}',
      replace(coalesce(entry.value, ''), '\', '\\'),
      'g'
    );
  end loop;
  return left(coalesce(nullif(btrim(rendered), ''), '-'), 4000);
end;
$function$;
revoke all on function app_private.render_drip_body(text, jsonb) from public, anon, authenticated;

-- Event-triggered enrollment. One set-based statement for every active event
-- campaign: match, enroll (idempotent by occurrence_key), render and queue one
-- message per step channel the recipient can be reached on and has not opted
-- out of. DORMANT leads and customers are filtered here -- the per-row
-- reject_dormant_drip_enrollment trigger would otherwise fail the whole batch.
create or replace function public.run_event_drip_matches(target_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  pass_at timestamptz := now();
  today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  new_ids uuid[];
  queued integer := 0;
  cancelled integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'INVALID_EVENT_MATCH_LIMIT';
  end if;

  with campaign as materialized (
    select campaign_row.id, campaign_row.organization_id, campaign_row.branch_id,
      campaign_row.name, campaign_row.created_by, campaign_row.trigger_type,
      campaign_row.activated_at, campaign_row.trigger_conditions as conditions,
      least(30, greatest(0, coalesce((campaign_row.trigger_conditions ->> 'days_before')::integer, 0))) as days_before,
      least(23, greatest(0, coalesce((campaign_row.trigger_conditions ->> 'send_hour')::integer, 10))) as send_hour
    from public.marketing_drip_campaigns campaign_row
    where campaign_row.status = 'ACTIVE'
      and campaign_row.deleted_at is null
      and campaign_row.trigger_type <> 'AUDIENCE'
      and campaign_row.activated_at is not null
  ), lead_match as (
    select campaign.id as campaign_id, lead_row.organization_id, lead_row.customer_id,
      lead_row.id as lead_id, lead_row.branch_id, lead_row.id as resource_id,
      'lead:' || lead_row.id as occurrence_key
    from campaign
    join public.leads lead_row on lead_row.organization_id = campaign.organization_id
    where campaign.trigger_type = 'LEAD_CREATED'
      and lead_row.deleted_at is null
      and lead_row.created_at >= campaign.activated_at
      and lead_row.created_at >= pass_at - interval '3 days'
      and (campaign.branch_id is null or lead_row.branch_id = campaign.branch_id)
      and (
        coalesce(jsonb_array_length(campaign.conditions -> 'sources'), 0) = 0
        or lead_row.source in (select jsonb_array_elements_text(campaign.conditions -> 'sources'))
      )
      and (
        coalesce(jsonb_array_length(campaign.conditions -> 'models'), 0) = 0
        or lower(btrim(lead_row.interested_model)) in (
          select lower(btrim(model_name))
          from jsonb_array_elements_text(campaign.conditions -> 'models') model_name
        )
      )
  ), date_match as (
    select campaign.id as campaign_id, customer_row.organization_id,
      customer_row.id as customer_id, latest.lead_id, latest.branch_id,
      customer_row.id as resource_id,
      lower(campaign.trigger_type) || ':' || customer_row.id || ':'
        || extract(year from target.event_day)::integer as occurrence_key
    from campaign
    cross join lateral (select today_ist + campaign.days_before as event_day) target
    join public.custom_field_definitions definition_row
      on definition_row.organization_id = campaign.organization_id
     and definition_row.module = 'CUSTOMERS'
     and definition_row.field_type = 'DATE'
     and definition_row.active
     and definition_row.field_key = case campaign.trigger_type
       when 'BIRTHDAY' then 'date_of_birth' else 'wedding_anniversary' end
    join public.custom_field_values value_row
      on value_row.organization_id = campaign.organization_id
     and value_row.definition_id = definition_row.id
     and value_row.resource_type = 'CUSTOMER'
     and jsonb_typeof(value_row.value) = 'string'
     and (
       substring(value_row.value #>> '{}' from 6 for 5) = to_char(target.event_day, 'MM-DD')
       -- 29 February is celebrated on the 28th in other years.
       or (
         to_char(target.event_day, 'MM-DD') = '02-28'
         and substring(value_row.value #>> '{}' from 6 for 5) = '02-29'
         and extract(day from (date_trunc('year', target.event_day) + interval '2 months' - interval '1 day')) = 28
       )
     )
    join public.customers customer_row
      on customer_row.id = value_row.resource_id
     and customer_row.organization_id = campaign.organization_id
     and customer_row.deleted_at is null
    cross join lateral (
      select lead_row.id as lead_id, lead_row.branch_id
      from public.leads lead_row
      where lead_row.organization_id = customer_row.organization_id
        and lead_row.customer_id = customer_row.id
        and lead_row.deleted_at is null
        and (campaign.branch_id is null or lead_row.branch_id = campaign.branch_id)
      order by lead_row.updated_at desc, lead_row.id desc
      limit 1
    ) latest
    where campaign.trigger_type in ('BIRTHDAY', 'ANNIVERSARY')
  ), booking_match as (
    select campaign.id as campaign_id, booking_row.organization_id, booking_row.customer_id,
      booking_row.lead_id, booking_row.branch_id, booking_row.id as resource_id,
      'booking:' || booking_row.id as occurrence_key
    from campaign
    join public.bookings booking_row on booking_row.organization_id = campaign.organization_id
    where campaign.trigger_type = 'BOOKING_CONFIRMED'
      and booking_row.deleted_at is null
      and booking_row.status <> 'CANCELLED'
      and booking_row.created_at >= campaign.activated_at
      and booking_row.created_at >= pass_at - interval '3 days'
      and (campaign.branch_id is null or booking_row.branch_id = campaign.branch_id)
  ), delivery_match as (
    select campaign.id as campaign_id, delivery_row.organization_id, delivery_row.customer_id,
      booking_row.lead_id, delivery_row.branch_id, delivery_row.id as resource_id,
      case campaign.trigger_type
        when 'VEHICLE_DELIVERED' then 'delivery:' || delivery_row.id
        else 'delivery-anniversary:' || delivery_row.id || ':'
          || extract(year from today_ist + campaign.days_before)::integer
      end as occurrence_key
    from campaign
    join public.delivery_cases delivery_row
      on delivery_row.organization_id = campaign.organization_id
     and delivery_row.deleted_at is null
     and delivery_row.status = 'DELIVERED'
     and delivery_row.delivered_at is not null
    left join public.bookings booking_row
      on booking_row.organization_id = delivery_row.organization_id
     and booking_row.id = delivery_row.booking_id
    where (campaign.branch_id is null or delivery_row.branch_id = campaign.branch_id)
      and (
        (
          campaign.trigger_type = 'VEHICLE_DELIVERED'
          and delivery_row.delivered_at >= campaign.activated_at
          and delivery_row.delivered_at >= pass_at - interval '3 days'
        )
        or (
          campaign.trigger_type = 'DELIVERY_ANNIVERSARY'
          and to_char(timezone('Asia/Kolkata', delivery_row.delivered_at), 'MM-DD')
            = to_char(today_ist + campaign.days_before, 'MM-DD')
          and extract(year from timezone('Asia/Kolkata', delivery_row.delivered_at))
            < extract(year from today_ist + campaign.days_before)
        )
      )
  ), all_match as (
    select * from lead_match
    union all select * from date_match
    union all select * from booking_match
    union all select * from delivery_match
  ), matched as (
    select all_match.*
    from all_match
    where (all_match.customer_id is not null or all_match.lead_id is not null)
      and all_match.branch_id is not null
      and not exists (
        select 1 from public.customer_drip_enrollments enrollment_row
        where enrollment_row.organization_id = all_match.organization_id
          and enrollment_row.source_campaign_id = all_match.campaign_id
          and enrollment_row.occurrence_key = all_match.occurrence_key
      )
      -- Do not disturb: the lead itself, or any lead of the same customer.
      and not exists (
        select 1 from public.leads dormant_row
        where dormant_row.organization_id = all_match.organization_id
          and dormant_row.deleted_at is null
          and dormant_row.temperature = 'DORMANT'
          and (
            dormant_row.id = all_match.lead_id
            or (all_match.customer_id is not null and dormant_row.customer_id = all_match.customer_id)
          )
      )
    order by all_match.campaign_id, all_match.occurrence_key
    limit target_limit
  ), new_enrollments as (
    insert into public.customer_drip_enrollments (
      organization_id, branch_id, customer_id, lead_id, source_campaign_id, source_name,
      status, enrolled_by, trigger_type, trigger_resource_id, occurrence_key,
      created_at, updated_at
    )
    select matched.organization_id, matched.branch_id, matched.customer_id, matched.lead_id,
      campaign.id, campaign.name, 'ACTIVE', campaign.created_by, campaign.trigger_type,
      matched.resource_id, matched.occurrence_key, pass_at, pass_at
    from matched
    join campaign on campaign.id = matched.campaign_id
    on conflict (organization_id, source_campaign_id, occurrence_key)
      where occurrence_key is not null
      do nothing
    returning id, organization_id, source_campaign_id, customer_id, lead_id, branch_id,
      trigger_type, trigger_resource_id
  ), enrollment_context as (
    select enrollment_row.id as enrollment_id, enrollment_row.organization_id,
      enrollment_row.source_campaign_id as campaign_id, enrollment_row.customer_id,
      jsonb_build_object(
        'customer_name', coalesce(customer_row.full_name, lead_row.customer_name),
        'customer_first_name',
          split_part(btrim(coalesce(customer_row.full_name, lead_row.customer_name, '')), ' ', 1),
        'interested_model', lead_row.interested_model,
        'vehicle_model', lead_row.interested_model,
        'lead_source', lead_row.source,
        'branch_name', branch_row.name,
        'branch_phone', branch_row.contact_phone,
        'consultant_name', owner_row.full_name,
        'booking_number', booking_row.booking_number,
        'delivery_date', to_char(
          timezone('Asia/Kolkata', coalesce(delivery_row.delivered_at, booking_row.expected_delivery_date::timestamptz)),
          'DD Mon YYYY'
        )
      ) as context,
      coalesce(nullif(btrim(customer_row.whatsapp_phone), ''), nullif(btrim(customer_row.primary_phone), ''),
        nullif(btrim(lead_row.phone), '')) as whatsapp_to,
      coalesce(nullif(btrim(customer_row.primary_phone), ''), nullif(btrim(lead_row.phone), '')) as sms_to,
      coalesce(nullif(btrim(customer_row.primary_email), ''), nullif(btrim(lead_row.email), '')) as email_to
    from new_enrollments enrollment_row
    left join public.customers customer_row
      on customer_row.id = enrollment_row.customer_id
     and customer_row.organization_id = enrollment_row.organization_id
     and customer_row.deleted_at is null
    left join public.leads lead_row
      on lead_row.id = enrollment_row.lead_id
     and lead_row.organization_id = enrollment_row.organization_id
    left join public.branches branch_row on branch_row.id = enrollment_row.branch_id
    left join public.delivery_cases delivery_row
      on enrollment_row.trigger_type in ('VEHICLE_DELIVERED', 'DELIVERY_ANNIVERSARY')
     and delivery_row.id = enrollment_row.trigger_resource_id
    left join public.bookings booking_row
      on booking_row.organization_id = enrollment_row.organization_id
     and booking_row.id = case
       when enrollment_row.trigger_type = 'BOOKING_CONFIRMED' then enrollment_row.trigger_resource_id
       else delivery_row.booking_id
     end
    left join public.profiles owner_row
      on owner_row.id = coalesce(booking_row.assigned_user_id, lead_row.assigned_user_id)
  ), step_timing as (
    select step_row.id as step_id, step_row.campaign_id, step_row.step_order,
      sum(step_row.delay_hours) over (
        partition by step_row.campaign_id order by step_row.step_order
        rows between unbounded preceding and current row
      ) as cumulative_hours
    from public.marketing_drip_steps step_row
    where step_row.active and step_row.campaign_id in (select campaign.id from campaign)
  ), step_channel as (
    select step_timing.*, channel_row.channel, channel_row.template_id, channel_row.variable_map,
      template_row.content ->> 'body' as body
    from step_timing
    join public.marketing_drip_step_channels channel_row on channel_row.step_id = step_timing.step_id
    join public.templates template_row
      on template_row.id = channel_row.template_id
     and template_row.deleted_at is null
     and upper(template_row.status) = 'APPROVED'
  ), queued_messages as (
    insert into public.customer_drip_messages (
      organization_id, enrollment_id, step_order, channel, message_body, scheduled_for,
      next_attempt_at, status, template_id, template_variables
    )
    select enrollment_context.organization_id, enrollment_context.enrollment_id,
      step_channel.step_order, step_channel.channel,
      app_private.render_drip_body(step_channel.body, rendered.variables),
      send_base.starts_at + make_interval(hours => step_channel.cumulative_hours::integer),
      send_base.starts_at + make_interval(hours => step_channel.cumulative_hours::integer),
      'QUEUED', step_channel.template_id, rendered.variables
    from enrollment_context
    join campaign on campaign.id = enrollment_context.campaign_id
    join step_channel on step_channel.campaign_id = enrollment_context.campaign_id
    cross join lateral (
      select app_private.render_drip_variables(step_channel.variable_map, enrollment_context.context) as variables
    ) rendered
    cross join lateral (
      -- Wishes go out at the campaign's send hour; events go out now.
      select case
        when campaign.trigger_type in ('BIRTHDAY', 'ANNIVERSARY', 'DELIVERY_ANNIVERSARY')
          then greatest(pass_at, timezone('Asia/Kolkata', today_ist + make_time(campaign.send_hour, 0, 0)))
        else pass_at
      end as starts_at
    ) send_base
    where case step_channel.channel
        when 'WHATSAPP' then enrollment_context.whatsapp_to
        when 'SMS' then enrollment_context.sms_to
        else enrollment_context.email_to
      end is not null
      and not exists (
        select 1 from public.customer_marketing_opt_outs opt_out_row
        where opt_out_row.organization_id = enrollment_context.organization_id
          and opt_out_row.customer_id = enrollment_context.customer_id
          and opt_out_row.channel = step_channel.channel
          and opt_out_row.revoked_at is null
      )
    returning enrollment_id
  )
  select coalesce((select array_agg(new_enrollments.id) from new_enrollments), '{}'::uuid[]),
    (select count(*)::integer from queued_messages)
  into new_ids, queued;

  if cardinality(new_ids) = 0 then
    return jsonb_build_object('enrolled', 0, 'messages', 0, 'cancelled', 0);
  end if;

  -- Nobody to send to on any of the campaign's channels: close it, visibly.
  update public.customer_drip_enrollments enrollment_row
  set status = 'CANCELLED', cancelled_at = pass_at, updated_at = pass_at,
    cancellation_reason = 'No reachable channel for this customer'
  where enrollment_row.id = any(new_ids)
    and enrollment_row.status = 'ACTIVE'
    and not exists (
      select 1 from public.customer_drip_messages message_row
      where message_row.enrollment_id = enrollment_row.id
    );
  get diagnostics cancelled = row_count;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  )
  select enrollment_row.organization_id, campaign_row.created_by, 'drip_campaign.event_matched',
    'marketing_drip_campaign', campaign_row.id::text,
    jsonb_build_object('trigger_type', campaign_row.trigger_type, 'enrolled', count(*))
  from public.customer_drip_enrollments enrollment_row
  join public.marketing_drip_campaigns campaign_row on campaign_row.id = enrollment_row.source_campaign_id
  where enrollment_row.id = any(new_ids)
  group by enrollment_row.organization_id, campaign_row.created_by, campaign_row.id, campaign_row.trigger_type;

  return jsonb_build_object(
    'enrolled', cardinality(new_ids), 'messages', queued, 'cancelled', cancelled
  );
end;
$function$;
revoke all on function public.run_event_drip_matches(integer) from public, anon, authenticated;
grant execute on function public.run_event_drip_matches(integer) to service_role;

CREATE OR REPLACE FUNCTION public.run_all_drip_auto_matches(target_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  campaign_id uuid;
  outcome jsonb;
  total_enrolled integer := 0;
  total_messages integer := 0;
  skipped integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  for campaign_id in
    select id from public.marketing_drip_campaigns
    where status = 'ACTIVE' and deleted_at is null and trigger_type = 'AUDIENCE'
    order by updated_at
  loop
    begin
      outcome := public.run_drip_auto_match(campaign_id, target_limit);
      total_enrolled := total_enrolled + (outcome ->> 'enrolled')::integer;
      total_messages := total_messages + (outcome ->> 'messages')::integer;
    exception when others then
      -- One campaign missing an approved template must not stop the others.
      skipped := skipped + 1;
    end;
  end loop;
  return jsonb_build_object(
    'enrolled', total_enrolled, 'messages', total_messages, 'skipped', skipped
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.run_drip_auto_match(target_campaign_id uuid, target_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  campaign_row public.marketing_drip_campaigns%rowtype;
  filter_input jsonb;
  enrolled integer := 0;
  queued integer := 0;
  enrolled_at timestamptz := now();
begin
  -- Runs from the scheduler, never from a browser.
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'INVALID_AUTO_MATCH_LIMIT';
  end if;

  select * into campaign_row from public.marketing_drip_campaigns
  where id = target_campaign_id and status = 'ACTIVE' and deleted_at is null
    and trigger_type = 'AUDIENCE';
  if not found then return jsonb_build_object('enrolled', 0, 'messages', 0); end if;
  filter_input := coalesce(campaign_row.audience_filter, '{}'::jsonb);

  -- Every step must already name an approved template, otherwise auto-match
  -- would mass-produce messages the dispatcher can only fail.
  if exists (
    select 1 from public.marketing_drip_steps step_row
    where step_row.campaign_id = campaign_row.id and step_row.active
      and (
        step_row.template_id is null
        or not exists (
          select 1 from public.templates template_row
          where template_row.id = step_row.template_id
            and template_row.organization_id = campaign_row.organization_id
            and template_row.deleted_at is null
            and upper(template_row.status) = 'APPROVED'
            and template_row.provider_template_id is not null
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'DRIP_CAMPAIGN_TEMPLATE_NOT_APPROVED';
  end if;

  if not exists (
    select 1 from public.marketing_drip_steps step_row
    where step_row.campaign_id = campaign_row.id and step_row.active
  ) then
    raise exception using errcode = '22023', message = 'DRIP_CAMPAIGN_HAS_NO_STEPS';
  end if;

  -- The matched audience is enrolled and its messages materialised in ONE
  -- statement. The enrolments are carried forward by RETURNING rather than
  -- re-found by timestamp: `now()` is the transaction clock, so a second pass in
  -- the same transaction would otherwise re-select the first pass's rows and
  -- collide on (enrollment_id, step_order).
  with matched as (
    select distinct on (customer_row.id)
      customer_row.id as customer_id, lead_row.id as lead_id, lead_row.branch_id
    from public.customers customer_row
    join public.leads lead_row
      on lead_row.customer_id = customer_row.id
     and lead_row.organization_id = customer_row.organization_id
     and lead_row.deleted_at is null
    where customer_row.organization_id = campaign_row.organization_id
      and customer_row.deleted_at is null
      and (campaign_row.branch_id is null or lead_row.branch_id = campaign_row.branch_id)
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
      -- Never enrol the same customer in the same campaign twice.
      and not exists (
        select 1 from public.customer_drip_enrollments enrollment_row
        where enrollment_row.organization_id = campaign_row.organization_id
          and enrollment_row.customer_id = customer_row.id
          and enrollment_row.source_campaign_id = campaign_row.id
      )
    order by customer_row.id, lead_row.updated_at desc, lead_row.id desc
    limit target_limit
  ), new_enrollments as (
    insert into public.customer_drip_enrollments (
      organization_id, branch_id, customer_id, lead_id, source_campaign_id,
      source_name, status, enrolled_by
    )
    select campaign_row.organization_id, matched.branch_id, matched.customer_id, matched.lead_id,
      campaign_row.id, campaign_row.name, 'ACTIVE', campaign_row.created_by
    from matched
    returning id, organization_id
  ), campaign_steps as (
    -- The running delay is a window sum over the steps, not a per-step loop.
    select step_source.step_order, step_source.channel, step_source.message_body,
      step_source.template_id, step_source.template_variables,
      sum(step_source.delay_hours) over (
        order by step_source.step_order
        rows between unbounded preceding and current row
      ) as cumulative_hours
    from public.marketing_drip_steps step_source
    where step_source.campaign_id = campaign_row.id and step_source.active
  ), queued_messages as (
    insert into public.customer_drip_messages (
      organization_id, enrollment_id, step_order, channel, message_body, scheduled_for,
      status, template_id, template_variables
    )
    select new_enrollments.organization_id, new_enrollments.id, campaign_steps.step_order,
      campaign_steps.channel, campaign_steps.message_body,
      enrolled_at + make_interval(hours => campaign_steps.cumulative_hours::integer),
      'QUEUED', campaign_steps.template_id, campaign_steps.template_variables
    from new_enrollments
    cross join campaign_steps
    returning enrollment_id
  )
  select count(distinct enrollment_id)::integer, count(*)::integer
  into enrolled, queued
  from queued_messages;

  enrolled := coalesce(enrolled, 0);
  queued := coalesce(queued, 0);
  if enrolled = 0 then return jsonb_build_object('enrolled', 0, 'messages', 0); end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    campaign_row.organization_id, campaign_row.created_by, 'drip_campaign.auto_matched',
    'marketing_drip_campaign', campaign_row.id::text,
    jsonb_build_object('enrolled', enrolled, 'messages', queued)
  );
  return jsonb_build_object('enrolled', enrolled, 'messages', queued);
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_due_drip_messages(target_worker_id text, target_batch_size integer DEFAULT 20)
 RETURNS TABLE(id uuid, organization_id uuid, channel text, message_body text, template_provider_id text, template_variables jsonb, recipient text, connected_account_id uuid, application_message_id uuid, lease_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  skipped_enrollment_ids uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160
    or target_batch_size not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'INVALID_DRIP_WORKER_CLAIM';
  end if;

  -- Re-checked at send time, not only at enrollment: a lead marked DORMANT, a
  -- customer who opted out, or an event campaign that was paused since.
  with due as (
    select message_row.id,
      case
        when enrollment_row.occurrence_key is not null
          and (campaign_row.id is null or campaign_row.status <> 'ACTIVE' or campaign_row.deleted_at is not null)
          then 'CAMPAIGN_PAUSED'
        when exists (
          select 1 from public.leads dormant_row
          where dormant_row.organization_id = enrollment_row.organization_id
            and dormant_row.deleted_at is null
            and dormant_row.temperature = 'DORMANT'
            and (
              dormant_row.id = enrollment_row.lead_id
              or (enrollment_row.customer_id is not null and dormant_row.customer_id = enrollment_row.customer_id)
            )
        ) then 'DORMANT'
        when enrollment_row.customer_id is not null and exists (
          select 1 from public.customer_marketing_opt_outs opt_out_row
          where opt_out_row.organization_id = enrollment_row.organization_id
            and opt_out_row.customer_id = enrollment_row.customer_id
            and opt_out_row.channel = message_row.channel
            and opt_out_row.revoked_at is null
        ) then 'OPTED_OUT'
      end as reason
    from public.customer_drip_messages message_row
    join public.customer_drip_enrollments enrollment_row on enrollment_row.id = message_row.enrollment_id
    left join public.marketing_drip_campaigns campaign_row on campaign_row.id = enrollment_row.source_campaign_id
    where message_row.status = 'QUEUED' and message_row.next_attempt_at <= now()
    order by message_row.next_attempt_at, message_row.id
    limit 500
  ), skipped as (
    update public.customer_drip_messages message_row
    set status = 'CANCELLED', skip_reason = due.reason,
      failure_reason = 'Skipped: ' || replace(lower(due.reason), '_', ' '),
      updated_at = now()
    from due
    where message_row.id = due.id and due.reason is not null and message_row.status = 'QUEUED'
    returning message_row.enrollment_id
  )
  select coalesce(array_agg(distinct skipped.enrollment_id), '{}'::uuid[])
  into skipped_enrollment_ids from skipped;

  if cardinality(skipped_enrollment_ids) > 0 then
    update public.customer_drip_enrollments enrollment_row
    set status = 'COMPLETED', completed_at = now(), updated_at = now()
    where enrollment_row.id = any(skipped_enrollment_ids)
      and enrollment_row.status = 'ACTIVE'
      and not exists (
        select 1 from public.customer_drip_messages pending_row
        where pending_row.enrollment_id = enrollment_row.id
          and pending_row.status in ('QUEUED', 'SENDING')
      );
  end if;

  return query
  with candidates as (
    select message_row.id
    from public.customer_drip_messages message_row
    left join public.customer_drip_enrollments priority_enrollment
      on priority_enrollment.id = message_row.enrollment_id
    left join public.leads priority_lead on priority_lead.id = priority_enrollment.lead_id
    where message_row.status = 'QUEUED' and message_row.next_attempt_at <= now()
    -- AGENTS.md 9.7: HOT first, then WARM, then COLD, then by due time.
    order by case priority_lead.temperature
        when 'HOT' then 0 when 'WARM' then 1 when 'COLD' then 2 else 3 end,
      message_row.next_attempt_at, message_row.id
    for update of message_row skip locked
    limit target_batch_size
  ), claimed as (
    update public.customer_drip_messages message_row
    set status = 'SENDING',
      attempts = message_row.attempts + 1,
      lease_token = target_worker_id || ':' || gen_random_uuid()::text,
      updated_at = now()
    from candidates
    where message_row.id = candidates.id
    returning message_row.*
  )
  select
    claimed.id,
    claimed.organization_id,
    claimed.channel,
    claimed.message_body,
    template_row.provider_template_id,
    claimed.template_variables,
    case claimed.channel
      when 'EMAIL' then coalesce(nullif(btrim(customer_row.primary_email), ''), nullif(btrim(lead_contact.email), ''))
      when 'WHATSAPP' then coalesce(nullif(btrim(customer_row.whatsapp_phone), ''),
        nullif(btrim(customer_row.primary_phone), ''), nullif(btrim(lead_contact.phone), ''))
      else coalesce(nullif(btrim(customer_row.primary_phone), ''), nullif(btrim(lead_contact.phone), ''))
    end,
    connection_row.id,
    -- Deterministic per message, so a retry after an unknown outcome reuses the
    -- provider's own idempotency key rather than sending a second copy.
    claimed.id,
    claimed.lease_token
  from claimed
  join public.customer_drip_enrollments enrollment_row
    on enrollment_row.id = claimed.enrollment_id
   and enrollment_row.organization_id = claimed.organization_id
  -- A new lead's thank-you can be enrolled before it is linked to a customer;
  -- it is sent to the lead's own phone or email.
  left join public.customers customer_row
    on customer_row.id = enrollment_row.customer_id
   and customer_row.organization_id = claimed.organization_id
   and customer_row.deleted_at is null
  left join public.leads lead_contact
    on lead_contact.id = enrollment_row.lead_id
   and lead_contact.organization_id = claimed.organization_id
  left join public.templates template_row
    on template_row.id = claimed.template_id
   and template_row.organization_id = claimed.organization_id
   and template_row.deleted_at is null
   and upper(template_row.status) = 'APPROVED'
  -- Only WhatsApp resolves a tenant connection. Brevo is a platform-level key in
  -- send-email and provider-outbox, not a per-tenant connected account, so
  -- looking one up for EMAIL would always miss and read as a misconfiguration.
  left join lateral (
    select account_row.id
    from public.connected_accounts account_row
    where (
        (claimed.channel = 'WHATSAPP' and account_row.provider_key = 'whatsapp_cloud')
        or (claimed.channel = 'SMS' and account_row.provider_key = 'msg91')
      )
      and account_row.organization_id = claimed.organization_id
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
      and (
        account_row.scope_mode = 'ALL_BRANCHES'
        or exists (
          select 1 from public.integration_branch_mappings mapping_row
          where mapping_row.connected_account_id = account_row.id
            and mapping_row.branch_id = enrollment_row.branch_id
            and mapping_row.deleted_at is null
        )
      )
    order by account_row.created_at
    limit 1
  ) connection_row on true
  where enrollment_row.status = 'ACTIVE';
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_drip_message(target_message_id uuid, target_lease_token text, target_provider_message_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare updated_rows integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.customer_drip_messages
  set status = 'SENT', sent_at = now(), updated_at = now(),
    provider_message_id = left(btrim(coalesce(target_provider_message_id, '')), 200),
    safe_error_code = null, failure_reason = null
  where id = target_message_id
    and lease_token = target_lease_token
    and status = 'SENDING';
  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then return false; end if;

  -- The send shows on the lead's timeline and in Customer 360.
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
  )
  select message_row.organization_id, enrollment_row.customer_id, enrollment_row.lead_id,
    'DRIP_MESSAGE_SENT', null,
    jsonb_build_object(
      'channel', message_row.channel,
      'campaign', enrollment_row.source_name,
      'campaign_id', enrollment_row.source_campaign_id,
      'enrollment_id', enrollment_row.id,
      'message_id', message_row.id,
      'step_order', message_row.step_order
    ),
    now()
  from public.customer_drip_messages message_row
  join public.customer_drip_enrollments enrollment_row on enrollment_row.id = message_row.enrollment_id
  where message_row.id = target_message_id;

  -- An enrollment with nothing left to send is finished; leaving it ACTIVE would
  -- keep it in the consultant's live list forever.
  update public.customer_drip_enrollments enrollment_row
  set status = 'COMPLETED', completed_at = now(), updated_at = now()
  where enrollment_row.id = (
      select message_row.enrollment_id from public.customer_drip_messages message_row
      where message_row.id = target_message_id
    )
    and enrollment_row.status = 'ACTIVE'
    and not exists (
      select 1 from public.customer_drip_messages pending_row
      where pending_row.enrollment_id = enrollment_row.id
        and pending_row.status in ('QUEUED', 'SENDING')
    );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_lead_journey(target_lead_id uuid, target_cursor_at timestamp with time zone DEFAULT NULL::timestamp with time zone, target_cursor_id uuid DEFAULT NULL::uuid, target_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  lead_row public.leads%rowtype;
  org uuid;
  call_access boolean;
  followup_access boolean;
  appointment_access boolean;
  test_drive_access boolean;
  quotation_access boolean;
  booking_access boolean;
  message_access boolean;
  events jsonb;
  page_size integer := least(greatest(coalesce(target_limit, 50), 1), 100);
  last_event jsonb;
  has_more boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if (target_cursor_at is null) <> (target_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_JOURNEY_CURSOR';
  end if;
  select * into lead_row from public.leads where id = target_lead_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  org := lead_row.organization_id;
  -- The telecaller who handed the lead to Sales keeps reading its timeline,
  -- as they already read its detail page.
  if not app_private.has_permission(org, 'lead.view')
    or not (
      app_private.can_access_lead(lead_row.id)
      or app_private.is_telecaller_handoff_viewer(org, lead_row.id, auth.uid())
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  call_access := app_private.has_permission(org, 'call.view');
  followup_access := app_private.has_permission(org, 'followup.view');
  appointment_access := app_private.has_permission(org, 'appointment.view');
  test_drive_access := app_private.has_permission(org, 'test_drive.view')
    or app_private.has_permission(org, 'test_drive.manage');
  quotation_access := app_private.has_permission(org, 'quotation.view')
    or app_private.has_permission(org, 'quotation.manage');
  booking_access := app_private.has_permission(org, 'booking.view')
    or app_private.has_permission(org, 'booking.manage');
  message_access := app_private.has_permission(org, 'message.view');

  with event as (
    -- Calls
    select call_row.id, coalesce(call_row.answered_at, call_row.started_at) as occurred_at,
      'CALL'::text as kind,
      concat_ws(' ', coalesce(caller.full_name, 'Someone'),
        case when call_row.direction = 'INBOUND' then 'received a call' else 'called' end) as title,
      concat_ws(' · ',
        initcap(replace(coalesce(call_row.outcome, call_row.status, 'UNKNOWN'), '_', ' ')),
        case when coalesce(call_row.duration_seconds, 0) > 0 then
          (call_row.duration_seconds / 60)::text || 'm ' || (call_row.duration_seconds % 60)::text || 's' end,
        case when call_row.call_source = 'PROVIDER' then 'IVR' else 'Personal phone' end) as detail,
      caller.full_name as actor_name,
      call_row.outcome as status,
      case when app_private.can_access_call(org, call_row.id) then jsonb_strip_nulls(jsonb_build_object(
        'notes', call_row.notes,
        'ai_summary', (
          select summary_row.summary from public.ai_call_summaries summary_row
          where summary_row.organization_id = org and summary_row.call_id = call_row.id
          order by summary_row.created_at desc, summary_row.id desc limit 1
        ),
        'call_id', call_row.id
      )) else '{}'::jsonb end as extra
    from public.calls call_row
    left join public.profiles caller on caller.id = call_row.assigned_user_id
    where call_access and call_row.organization_id = org and call_row.id = any(app_private.lead_call_ids(org, lead_row.id))

    union all
    -- Stage changes
    select stage_row.id, stage_row.created_at, 'STAGE',
      'Stage changed to ' || stage_row.to_status::text,
      concat_ws(' · ', case when stage_row.from_status is not null then 'from ' || stage_row.from_status::text end,
        nullif(btrim(stage_row.reason), '')),
      actor.full_name, stage_row.to_status::text, '{}'::jsonb
    from public.lead_stage_history stage_row
    left join public.profiles actor on actor.id = stage_row.changed_by
    where stage_row.organization_id = org and stage_row.lead_id = lead_row.id

    union all
    -- Temperature changes
    select temperature_row.id, temperature_row.created_at, 'TEMPERATURE',
      'Marked ' || temperature_row.to_temperature::text,
      case when temperature_row.from_temperature is not null
        then 'from ' || temperature_row.from_temperature::text end,
      actor.full_name, temperature_row.to_temperature::text, '{}'::jsonb
    from public.lead_temperature_history temperature_row
    left join public.profiles actor on actor.id = temperature_row.changed_by
    where temperature_row.organization_id = org and temperature_row.lead_id = lead_row.id

    union all
    -- Assignments
    select assignment_row.id, assignment_row.created_at, 'ASSIGNMENT',
      'Assigned to ' || coalesce(new_owner.full_name, 'a user'),
      concat_ws(' · ', initcap(replace(assignment_row.method::text, '_', ' ')),
        case when previous_owner.full_name is not null then 'from ' || previous_owner.full_name end,
        nullif(btrim(assignment_row.reason), '')),
      coalesce(assigner.full_name, 'CRM'), assignment_row.method::text, '{}'::jsonb
    from public.lead_assignment_history assignment_row
    left join public.profiles new_owner on new_owner.id = assignment_row.new_owner_id
    left join public.profiles previous_owner on previous_owner.id = assignment_row.previous_owner_id
    left join public.profiles assigner on assigner.id = assignment_row.assigned_by
    where assignment_row.organization_id = org and assignment_row.lead_id = lead_row.id

    union all
    -- Follow-ups: when planned, and when closed
    select followup_row.id, followup_row.created_at, 'FOLLOWUP',
      'Follow-up scheduled for ' || to_char(followup_row.due_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM'),
      concat_ws(' · ', followup_row.reason, initcap(coalesce(followup_row.priority, 'NORMAL')) || ' priority'),
      creator.full_name, 'SCHEDULED', '{}'::jsonb
    from public.followups followup_row
    left join public.profiles creator on creator.id = coalesce(followup_row.created_by, followup_row.assigned_user_id)
    where followup_access and followup_row.organization_id = org and followup_row.lead_id = lead_row.id

    union all
    select followup_row.id, coalesce(followup_row.completed_at, followup_row.cancelled_at), 'FOLLOWUP',
      case when followup_row.status = 'COMPLETED' then 'Follow-up completed' else 'Follow-up cancelled' end,
      concat_ws(' · ', followup_row.reason,
        nullif(btrim(coalesce(followup_row.completion_note, followup_row.cancellation_reason, '')), '')),
      owner.full_name, followup_row.status, '{}'::jsonb
    from public.followups followup_row
    left join public.profiles owner on owner.id = followup_row.assigned_user_id
    where followup_access and followup_row.organization_id = org and followup_row.lead_id = lead_row.id
      and followup_row.status in ('COMPLETED', 'CANCELLED')
      and coalesce(followup_row.completed_at, followup_row.cancelled_at) is not null

    union all
    -- Appointments
    select appointment_row.id, appointment_row.created_at, 'APPOINTMENT',
      appointment_row.appointment_type || ' scheduled for '
        || to_char(appointment_row.scheduled_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM'),
      nullif(btrim(coalesce(appointment_row.notes, '')), ''),
      creator.full_name, 'SCHEDULED', '{}'::jsonb
    from public.appointments appointment_row
    left join public.profiles creator on creator.id = coalesce(appointment_row.created_by, appointment_row.assigned_user_id)
    where appointment_access and appointment_row.organization_id = org and appointment_row.lead_id = lead_row.id

    union all
    select appointment_row.id,
      coalesce(appointment_row.completed_at, appointment_row.cancelled_at, appointment_row.scheduled_at), 'APPOINTMENT',
      appointment_row.appointment_type || case appointment_row.status
        when 'COMPLETED' then ' completed' when 'NO_SHOW' then ' — customer did not come' else ' cancelled' end,
      nullif(btrim(coalesce(appointment_row.cancellation_reason, '')), ''),
      owner.full_name, appointment_row.status, '{}'::jsonb
    from public.appointments appointment_row
    left join public.profiles owner on owner.id = appointment_row.assigned_user_id
    where appointment_access and appointment_row.organization_id = org and appointment_row.lead_id = lead_row.id
      and appointment_row.status in ('COMPLETED', 'NO_SHOW', 'CANCELLED')

    union all
    -- Test drives
    select drive_appointment.id, drive_appointment.created_at, 'TEST_DRIVE',
      'Test drive scheduled for '
        || to_char(drive_appointment.scheduled_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM'),
      nullif(drive_appointment.vehicle_registration, ''),
      creator.full_name, drive_appointment.status, '{}'::jsonb
    from public.test_drive_appointments drive_appointment
    left join public.profiles creator on creator.id = coalesce(drive_appointment.created_by, drive_appointment.assigned_user_id)
    where test_drive_access and drive_appointment.organization_id = org and drive_appointment.lead_id = lead_row.id

    union all
    select drive_row.id, coalesce(drive_row.completed_at, drive_row.cancelled_at), 'TEST_DRIVE',
      case when drive_row.status = 'COMPLETED' then 'Test drive completed' else 'Test drive cancelled' end,
      case when drive_row.status = 'COMPLETED' then concat_ws(' · ',
          round(coalesce(drive_row.distance_meters, 0) / 1000.0, 1)::text || ' km',
          (coalesce(drive_row.duration_seconds, 0) / 60)::text || ' min')
        else drive_row.cancellation_reason end,
      owner.full_name, drive_row.status, '{}'::jsonb
    from public.test_drives drive_row
    left join public.profiles owner on owner.id = drive_row.assigned_user_id
    where test_drive_access and drive_row.organization_id = org and drive_row.lead_id = lead_row.id
      and drive_row.status in ('COMPLETED', 'CANCELLED')
      and coalesce(drive_row.completed_at, drive_row.cancelled_at) is not null

    union all
    -- Quotations
    select quotation_row.id, quotation_row.created_at, 'QUOTATION',
      'Quotation ' || quotation_row.quotation_number || ' created',
      concat_ws(' · ', '₹' || to_char(quotation_row.total_amount, 'FM99,99,99,999'),
        'now ' || lower(replace(quotation_row.status, '_', ' ')),
        case when quotation_row.current_version > 1 then 'version ' || quotation_row.current_version end),
      owner.full_name, quotation_row.status, jsonb_build_object('quotation_id', quotation_row.id)
    from public.quotations quotation_row
    left join public.profiles owner on owner.id = quotation_row.assigned_user_id
    where quotation_access and quotation_row.organization_id = org and quotation_row.lead_id = lead_row.id
      and quotation_row.deleted_at is null

    union all
    -- Bookings
    select booking_row.id, booking_row.created_at, 'BOOKING',
      'Booking ' || booking_row.booking_number || ' confirmed',
      concat_ws(' · ', '₹' || to_char(booking_row.booking_amount, 'FM99,99,99,999') || ' paid',
        'now ' || lower(replace(booking_row.status, '_', ' ')),
        case when booking_row.expected_delivery_date is not null
          then 'delivery ' || to_char(booking_row.expected_delivery_date, 'DD Mon YYYY') end),
      owner.full_name, booking_row.status, jsonb_build_object('booking_id', booking_row.id)
    from public.bookings booking_row
    left join public.profiles owner on owner.id = booking_row.assigned_user_id
    where booking_access and booking_row.organization_id = org and booking_row.lead_id = lead_row.id
      and booking_row.deleted_at is null

    union all
    -- Conversations (the thread itself opens in lead detail)
    select conversation_row.id, conversation_row.created_at, 'MESSAGE',
      initcap(replace(replace(conversation_row.channel, '_BUSINESS', ''), '_', ' ')) || ' conversation started',
      (select count(*)::text || ' messages' from public.conversation_messages message_row
        where message_row.organization_id = org and message_row.conversation_id = conversation_row.id),
      owner.full_name, conversation_row.status, jsonb_build_object('conversation_id', conversation_row.id)
    from public.conversations conversation_row
    left join public.profiles owner on owner.id = conversation_row.assigned_user_id
    where message_access and conversation_row.organization_id = org and conversation_row.lead_id = lead_row.id

    union all
    -- Notes on the lead
    select note_row.id, note_row.created_at, 'NOTE', 'Note added', left(note_row.body, 600),
      author.full_name, null, '{}'::jsonb
    from public.notes note_row
    left join public.profiles author on author.id = note_row.created_by
    where note_row.organization_id = org and lower(note_row.resource_type) = 'lead'
      and note_row.resource_id = lead_row.id and note_row.deleted_at is null

    union all
    -- Activities that no structured source above already records
    select activity_row.id, activity_row.occurred_at, 'ACTIVITY',
      case activity_row.activity_type
        when 'SALES_CONTACTED' then 'Sales Consultant contacted the customer'
        when 'TELECALLER_CONTACTED' then 'Telecaller contacted the customer'
        when 'CUSTOMER_LINKED' then 'Linked to an existing customer'
        when 'CUSTOMER_CREATED_AND_LINKED' then 'Customer record created'
        when 'LEAD_REQUIREMENTS_UPDATED' then 'Requirements updated'
        when 'SALES_HANDOFF_CANCELLED' then
          'Transfer to ' || coalesce(handoff_consultant.full_name, 'Sales') || ' cancelled'
        when 'SALES_HANDOFF_REASSIGNED' then
          'Transfer to ' || coalesce(handoff_consultant.full_name, 'Sales')
            || ' cancelled, moved to ' || coalesce(next_consultant.full_name, 'another consultant')
        when 'LEAD_TAKEN_OVER' then 'Taken over on first contact'
        when 'DRIP_MESSAGE_SENT' then
          'Drip "' || coalesce(activity_row.metadata ->> 'campaign', 'campaign') || '" message sent'
        when 'CALL_LINKED' then 'Call on another enquiry linked here'
        when 'CALL_UNLINKED' then 'Linked call removed'
        else initcap(replace(activity_row.activity_type, '_', ' '))
      end,
      coalesce(
        case when activity_row.metadata ? 'channel'
          then 'via ' || initcap(replace(activity_row.metadata->>'channel', '_', ' ')) end,
        nullif(activity_row.metadata->>'summary', ''),
        nullif(btrim(activity_row.metadata->>'reason'), '')
      ),
      actor.full_name, activity_row.activity_type, '{}'::jsonb
    from public.activities activity_row
    left join public.profiles actor on actor.id = activity_row.actor_id
    left join public.profiles handoff_consultant
      on activity_row.activity_type in ('SALES_HANDOFF_CANCELLED', 'SALES_HANDOFF_REASSIGNED')
     and handoff_consultant.organization_id = org
     and handoff_consultant.id::text = activity_row.metadata->>'previous_sales_consultant_id'
    left join public.profiles next_consultant
      on activity_row.activity_type = 'SALES_HANDOFF_REASSIGNED'
     and next_consultant.organization_id = org
     and next_consultant.id::text = activity_row.metadata->>'new_sales_consultant_id'
    where activity_row.organization_id = org and activity_row.lead_id = lead_row.id
      and activity_row.activity_type not in (
        'LEAD_RECEIVED', 'FIRST_CONTACTED', 'LEAD_QUALIFIED', 'LEAD_TRANSFERRED_TO_SALES',
        'FOLLOWUP_SCHEDULED', 'FOLLOWUP_COMPLETED', 'APPOINTMENT_SCHEDULED', 'APPOINTMENT_UPDATED',
        'APPOINTMENT_COMPLETED', 'TEST_DRIVE_SCHEDULED', 'TEST_DRIVE_COMPLETED', 'QUOTATION_CREATED',
        'BOOKING_CREATED'
      )
      and activity_row.activity_type not like 'demo.%'
  ), page as (
    select * from event
    where occurred_at is not null
      and (target_cursor_at is null or (occurred_at, id) < (target_cursor_at, target_cursor_id))
    order by occurred_at desc, id desc
    limit page_size + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'occurred_at', page.occurred_at,
      'kind', page.kind,
      'title', page.title,
      'detail', nullif(page.detail, ''),
      'actor_name', page.actor_name,
      'status', page.status,
      'extra', page.extra
    ) order by page.occurred_at desc, page.id desc), '[]'::jsonb)
  into events
  from page;

  has_more := jsonb_array_length(events) > page_size;
  if has_more then
    events := events - page_size;
  end if;
  last_event := events -> (jsonb_array_length(events) - 1);

  return jsonb_build_object(
    'lead_id', lead_row.id,
    'events', events,
    'next_cursor', case when has_more then jsonb_build_object(
      'occurred_at', last_event->'occurred_at', 'id', last_event->'id') end
  );
end;
$function$;

commit;
