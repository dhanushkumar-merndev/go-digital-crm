-- Enrolment still wrote free prose with no template, so every message the new
-- dispatcher claimed would fail with DRIP_TEMPLATE_NOT_APPROVED. The step now
-- carries the approved template it will be sent as, verified at enrolment; the
-- prose stays as the rendered copy the consultant reviewed.

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
  resolved_branch_id uuid;
  resolved_lead_id uuid;
  normalized_name text := btrim(coalesce(target_source_name, ''));
  normalized_steps jsonb := coalesce(target_steps, '[]'::jsonb);
  step_element jsonb;
  step_index integer := 0;
  running_offset_hours integer := 0;
  enrollment_id uuid := gen_random_uuid();
  enrolled_at timestamptz := now();
  step_template public.templates%rowtype;
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

  -- Existence only; nothing on the row is needed afterwards, so no local is
  -- bound to it.
  if not exists (
    select 1
    from public.customers customer_source
    where customer_source.id = target_customer_id
      and customer_source.organization_id = current_organization_id
      and customer_source.deleted_at is null
  ) then
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
      or nullif(btrim(coalesce(step_element ->> 'template_id', '')), '') is null
      or jsonb_typeof(coalesce(step_element -> 'template_variables', '{}'::jsonb)) <> 'object'
    then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_DRIP_STEP';
    end if;

    -- A step is scheduled hours to a year out, which is outside WhatsApp's 24h
    -- service window and past any free-form email body this system can send, so
    -- it may only be composed from a template the provider already approved.
    -- Checking at enrolment means the consultant is refused now rather than the
    -- customer silently never receiving the message.
    begin
      select * into step_template
      from public.templates template_row
      where template_row.id = (step_element ->> 'template_id')::uuid
        and template_row.organization_id = current_organization_id
        and template_row.deleted_at is null
        and upper(template_row.status) = 'APPROVED'
        and template_row.provider_template_id is not null;
    exception when others then
      raise exception using errcode = '22023', message = 'CUSTOMER_DRIP_TEMPLATE_NOT_APPROVED';
    end;
    if not found then
      raise exception using errcode = '22023', message = 'CUSTOMER_DRIP_TEMPLATE_NOT_APPROVED';
    end if;
    -- Meta registers a WhatsApp template under either channel name; an email
    -- template can never carry a WhatsApp send and vice versa.
    if not (
      (step_element ->> 'channel' = 'EMAIL' and upper(step_template.channel) = 'EMAIL')
      or (step_element ->> 'channel' = 'SMS' and upper(step_template.channel) = 'SMS')
      or (step_element ->> 'channel' = 'WHATSAPP'
        and upper(step_template.channel) in ('WHATSAPP', 'WHATSAPP_BUSINESS'))
    ) then
      raise exception using errcode = '22023', message = 'CUSTOMER_DRIP_TEMPLATE_CHANNEL_MISMATCH';
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
      organization_id, enrollment_id, step_order, channel, message_body, scheduled_for, status,
      template_id, template_variables
    ) values (
      current_organization_id, enrollment_id, step_index,
      step_element ->> 'channel',
      btrim(step_element ->> 'message_body'),
      enrolled_at + make_interval(hours => running_offset_hours),
      'QUEUED',
      step_template.id,
      coalesce(step_element -> 'template_variables', '{}'::jsonb)
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

-- A consultant has no template-management permission and should not gain one
-- just to pick a phrasing marketing already had approved, so the options are
-- read through this RPC rather than from the templates table directly.
create or replace function public.get_customer_drip_template_options()
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
        'id', template_row.id,
        'name', template_row.name,
        -- Normalised to the step's own vocabulary so the client never has to
        -- know that Meta templates are stored under two channel names.
        'channel', case
          when upper(template_row.channel) in ('WHATSAPP', 'WHATSAPP_BUSINESS') then 'WHATSAPP'
          else upper(template_row.channel) end,
        'body', template_row.content ->> 'body'
      ) order by template_row.name
    )
    from public.templates template_row
    where template_row.organization_id = current_organization_id
      and template_row.deleted_at is null
      and upper(template_row.status) = 'APPROVED'
      and template_row.provider_template_id is not null
      and upper(template_row.channel) in ('EMAIL', 'SMS', 'WHATSAPP', 'WHATSAPP_BUSINESS')
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_customer_drip_template_options() from public, anon;
grant execute on function public.get_customer_drip_template_options() to authenticated;
