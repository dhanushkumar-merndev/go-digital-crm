-- marketing_drip_campaigns has carried an audience_filter since it was created
-- and nothing has ever read it: enrolment was only ever manual, one customer at
-- a time from Customer 360. This evaluates that filter and enrols matching
-- customers automatically.
--
-- The whole match is two set-based statements: one insert…select for the
-- enrolments and one insert…select for their messages. It is deliberately not a
-- loop over matched customers running a per-customer insert, because the cost
-- must track the rows that match, not the size of the audience.

create or replace function public.run_drip_auto_match(
  target_campaign_id uuid,
  target_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  where id = target_campaign_id and status = 'ACTIVE' and deleted_at is null;
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
$$;

-- Every active campaign in one scheduled pass.
create or replace function public.run_all_drip_auto_matches(target_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    where status = 'ACTIVE' and deleted_at is null
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
$$;

revoke all on function public.run_drip_auto_match(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.run_drip_auto_match(uuid, integer) to service_role;
revoke all on function public.run_all_drip_auto_matches(integer)
  from public, anon, authenticated;
grant execute on function public.run_all_drip_auto_matches(integer) to service_role;
