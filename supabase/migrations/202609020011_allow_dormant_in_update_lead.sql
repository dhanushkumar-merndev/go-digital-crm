begin;

-- Adding DORMANT to public.lead_temperature (202609020009) was not enough to be
-- able to set it: update_lead validates the patch against its own hardcoded
-- tuple before casting, so every attempt raised INVALID_LEAD_TEMPERATURE and the
-- dialog reported a rejected lifecycle transition. The enum and this list have
-- to move together -- see the closing note in AGENTS.md 9.7.
--
-- Only that tuple changes; the rest of the function is carried over untouched.

create or replace function public.update_lead(
  target_lead_id uuid,
  expected_updated_at timestamptz,
  lead_patch jsonb,
  change_reason text default null
)
returns public.leads language plpgsql security definer set search_path = '' as $$
declare
  current_lead public.leads%rowtype;
  updated_lead public.leads%rowtype;
  next_customer_name text;
  next_phone text;
  next_normalized_phone text;
  next_email text;
  next_interested_model text;
  next_lifecycle public.lead_lifecycle;
  next_temperature public.lead_temperature;
  next_first_contacted_at timestamptz;
  next_followup_timestamp timestamptz;
  next_lost_reason text;
  next_updated_at timestamptz;
  changed_fields jsonb;
begin
  if expected_updated_at is null then
    raise exception using errcode = '22023', message = 'EXPECTED_UPDATED_AT_REQUIRED';
  end if;
  if lead_patch is null or jsonb_typeof(lead_patch) <> 'object' or lead_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'INVALID_LEAD_PATCH';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(lead_patch) as patch_key(key)
    where patch_key.key not in (
      'customer_name',
      'phone',
      'email',
      'interested_model',
      'lifecycle_status',
      'temperature',
      'first_contacted_at',
      'next_followup_at',
      'lost_reason'
    )
  ) then
    raise exception using errcode = '22023', message = 'LEAD_PATCH_FIELD_FORBIDDEN';
  end if;
  if char_length(coalesce(change_reason, '')) > 500 then
    raise exception using errcode = '22023', message = 'CHANGE_REASON_TOO_LONG';
  end if;

  select * into current_lead
  from public.leads
  where id = target_lead_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_lead.organization_id, 'lead.update')
    or not app_private.can_access_record(
      current_lead.organization_id,
      current_lead.branch_id,
      current_lead.team_id,
      current_lead.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if current_lead.updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'LEAD_VERSION_CONFLICT';
  end if;

  next_customer_name := current_lead.customer_name;
  next_phone := current_lead.phone;
  next_normalized_phone := current_lead.normalized_phone;
  next_email := current_lead.email;
  next_interested_model := current_lead.interested_model;
  next_lifecycle := current_lead.lifecycle_status;
  next_temperature := current_lead.temperature;
  next_first_contacted_at := current_lead.first_contacted_at;
  next_followup_timestamp := current_lead.next_followup_at;
  next_lost_reason := current_lead.lost_reason;

  if lead_patch ? 'customer_name' then
    if jsonb_typeof(lead_patch -> 'customer_name') <> 'string'
      or char_length(btrim(lead_patch ->> 'customer_name')) not between 2 and 160
    then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_NAME';
    end if;
    next_customer_name := btrim(lead_patch ->> 'customer_name');
  end if;
  if lead_patch ? 'phone' then
    if jsonb_typeof(lead_patch -> 'phone') <> 'string'
      or char_length(lead_patch ->> 'phone') > 24
    then
      raise exception using errcode = '22023', message = 'INVALID_PHONE';
    end if;
    next_phone := btrim(lead_patch ->> 'phone');
    next_normalized_phone := regexp_replace(next_phone, '[^0-9+]', '', 'g');
    if next_normalized_phone !~ '^[+]?[0-9]{7,15}$' then
      raise exception using errcode = '22023', message = 'INVALID_PHONE';
    end if;
  end if;
  if lead_patch ? 'email' then
    if jsonb_typeof(lead_patch -> 'email') = 'null' then
      next_email := null;
    elsif jsonb_typeof(lead_patch -> 'email') <> 'string'
      or char_length(lead_patch ->> 'email') > 320
      or btrim(lead_patch ->> 'email') !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    then
      raise exception using errcode = '22023', message = 'INVALID_EMAIL';
    else
      next_email := lower(btrim(lead_patch ->> 'email'));
    end if;
  end if;
  if lead_patch ? 'interested_model' then
    if jsonb_typeof(lead_patch -> 'interested_model') = 'null' then
      next_interested_model := null;
    elsif jsonb_typeof(lead_patch -> 'interested_model') <> 'string'
      or char_length(btrim(lead_patch ->> 'interested_model')) > 160
    then
      raise exception using errcode = '22023', message = 'INVALID_INTERESTED_MODEL';
    else
      next_interested_model := nullif(btrim(lead_patch ->> 'interested_model'), '');
    end if;
  end if;
  if lead_patch ? 'lifecycle_status' then
    if jsonb_typeof(lead_patch -> 'lifecycle_status') <> 'string'
      or (lead_patch ->> 'lifecycle_status') not in (
        'New', 'Contacted', 'Qualified', 'Appointment Scheduled',
        'Transferred to Sales', 'Lost'
      )
    then
      raise exception using errcode = '22023', message = 'INVALID_LIFECYCLE_STATUS';
    end if;
    next_lifecycle := (lead_patch ->> 'lifecycle_status')::public.lead_lifecycle;
  end if;
  if lead_patch ? 'temperature' then
    if jsonb_typeof(lead_patch -> 'temperature') = 'null' then
      if current_lead.temperature is not null then
        raise exception using errcode = '22023', message = 'TEMPERATURE_CLEAR_FORBIDDEN';
      end if;
      next_temperature := null;
    elsif jsonb_typeof(lead_patch -> 'temperature') <> 'string'
      or (lead_patch ->> 'temperature') not in ('COLD', 'WARM', 'HOT', 'DORMANT')
    then
      raise exception using errcode = '22023', message = 'INVALID_LEAD_TEMPERATURE';
    else
      next_temperature := (lead_patch ->> 'temperature')::public.lead_temperature;
    end if;
  end if;
  if lead_patch ? 'first_contacted_at' then
    if jsonb_typeof(lead_patch -> 'first_contacted_at') = 'null' then
      if current_lead.first_contacted_at is not null then
        raise exception using errcode = '22023', message = 'FIRST_CONTACT_IMMUTABLE';
      end if;
      next_first_contacted_at := null;
    elsif jsonb_typeof(lead_patch -> 'first_contacted_at') <> 'string' then
      raise exception using errcode = '22023', message = 'INVALID_FIRST_CONTACTED_AT';
    else
      begin
        next_first_contacted_at := (lead_patch ->> 'first_contacted_at')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'INVALID_FIRST_CONTACTED_AT';
      end;
      if current_lead.first_contacted_at is not null
        and next_first_contacted_at is distinct from current_lead.first_contacted_at
      then
        raise exception using errcode = '22023', message = 'FIRST_CONTACT_IMMUTABLE';
      end if;
    end if;
  end if;
  if lead_patch ? 'next_followup_at' then
    if jsonb_typeof(lead_patch -> 'next_followup_at') = 'null' then
      next_followup_timestamp := null;
    elsif jsonb_typeof(lead_patch -> 'next_followup_at') <> 'string' then
      raise exception using errcode = '22023', message = 'INVALID_NEXT_FOLLOWUP_AT';
    else
      begin
        next_followup_timestamp := (lead_patch ->> 'next_followup_at')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'INVALID_NEXT_FOLLOWUP_AT';
      end;
    end if;
  end if;
  if lead_patch ? 'lost_reason' then
    if jsonb_typeof(lead_patch -> 'lost_reason') = 'null' then
      next_lost_reason := null;
    elsif jsonb_typeof(lead_patch -> 'lost_reason') <> 'string'
      or char_length(btrim(lead_patch ->> 'lost_reason')) > 500
    then
      raise exception using errcode = '22023', message = 'INVALID_LOST_REASON';
    else
      next_lost_reason := nullif(btrim(lead_patch ->> 'lost_reason'), '');
    end if;
  end if;

  if next_lifecycle is distinct from current_lead.lifecycle_status
    or next_temperature is distinct from current_lead.temperature
  then
    if nullif(btrim(change_reason), '') is null then
      raise exception using errcode = '22023', message = 'CHANGE_REASON_REQUIRED';
    end if;
  end if;
  if next_lifecycle = 'Lost' and next_lost_reason is null then
    raise exception using errcode = '22023', message = 'LOST_REASON_REQUIRED';
  elsif next_lifecycle <> 'Lost' then
    next_lost_reason := null;
  end if;
  if next_first_contacted_at is null
    and next_lifecycle in (
      'Contacted', 'Qualified', 'Appointment Scheduled', 'Transferred to Sales'
    )
  then
    next_first_contacted_at := clock_timestamp();
  end if;
  if next_first_contacted_at is not null and (
    next_first_contacted_at < current_lead.created_at
    or next_first_contacted_at > now() + interval '5 minutes'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_FIRST_CONTACTED_AT';
  end if;
  if next_lifecycle = 'New' and next_first_contacted_at is not null then
    raise exception using errcode = '23514', message = 'NEW_LEAD_CANNOT_BE_CONTACTED';
  end if;

  next_updated_at := greatest(
    clock_timestamp(),
    current_lead.updated_at + interval '1 microsecond'
  );
  update public.leads lead_row
  set customer_name = next_customer_name,
    phone = next_phone,
    normalized_phone = next_normalized_phone,
    email = next_email,
    interested_model = next_interested_model,
    lifecycle_status = next_lifecycle,
    temperature = next_temperature,
    first_contacted_at = next_first_contacted_at,
    next_followup_at = next_followup_timestamp,
    lost_reason = next_lost_reason,
    updated_at = next_updated_at
  where lead_row.id = target_lead_id
  returning lead_row.* into updated_lead;

  if next_lifecycle is distinct from current_lead.lifecycle_status then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      current_lead.organization_id,
      current_lead.id,
      current_lead.lifecycle_status,
      next_lifecycle,
      auth.uid(),
      btrim(change_reason)
    );
  end if;
  if next_temperature is distinct from current_lead.temperature then
    insert into public.lead_temperature_history (
      organization_id, lead_id, from_temperature, to_temperature, changed_by
    ) values (
      current_lead.organization_id,
      current_lead.id,
      current_lead.temperature,
      next_temperature,
      auth.uid()
    );
  end if;
  select coalesce(jsonb_agg(patch_key.key order by patch_key.key), '[]'::jsonb)
    into changed_fields
  from jsonb_object_keys(lead_patch) as patch_key(key);
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_lead.organization_id,
    auth.uid(),
    'lead.updated',
    'lead',
    current_lead.id::text,
    current_lead.branch_id,
    jsonb_build_object(
      'changed_fields', changed_fields,
      'reason', nullif(btrim(change_reason), ''),
      'previous_updated_at', current_lead.updated_at,
      'updated_at', next_updated_at
    )
  );
  return updated_lead;
end;
$$;

revoke all on function public.update_lead(uuid, timestamptz, jsonb, text) from public, anon;
grant execute on function public.update_lead(uuid, timestamptz, jsonb, text) to authenticated;

commit;
