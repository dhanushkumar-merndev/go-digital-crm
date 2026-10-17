begin;

-- Inbound calls on the TeleCMI number (owner decisions, 2026-10-14):
--
-- 1. Smart routing. A caller whose number already has a lead rings that lead's
--    own telecaller directly; everyone else falls through to the configured
--    inbound action (the TeleCMI IVR with its greeting and menu). The call-flow
--    Edge Function asks get_telecmi_inbound_route, which matches the caller to a
--    lead with the same rule the inbound call log uses, so the person who rang
--    and the person who owns the logged call never disagree.
-- 2. Missed-call callback. An inbound call that ends unanswered opens one HIGH
--    "Customer Callback" follow-up for the call's owner. Further missed calls
--    from the same number refresh that follow-up instead of stacking new ones.
--    Any later TeleCMI call that reaches the number -- the callback itself, or
--    the customer ringing again and being answered -- completes it.
--
-- A follow-up's lead/customer is immutable (validate_work_tenant_integrity), so
-- a callback for an unknown caller stays lead-less; it carries the number in
-- callback_phone, the follow-up lists show it, and it still auto-completes once
-- a lead created for that number is called back.
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

-- Follow-up columns ----------------------------------------------------------------
alter table public.followups
  add column if not exists source_call_id uuid references public.calls(id),
  add column if not exists callback_phone text;

alter table public.followups drop constraint if exists followups_callback_phone_format;
alter table public.followups
  add constraint followups_callback_phone_format
  check (callback_phone is null or callback_phone ~ '^\+[0-9]{6,15}$');

-- One open callback per number. OVERDUE is only ever a display state today, but
-- it is a valid stored status, so it counts as open too.
create unique index if not exists followups_open_callback_phone_uidx
  on public.followups (organization_id, callback_phone)
  where callback_phone is not null and status in ('OPEN', 'OVERDUE');

-- Caller -> lead match, shared by routing and the inbound call log ------------------
create or replace function app_private.telecmi_inbound_lead_match(
  target_organization_id uuid,
  target_lead_phone text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  matched_lead_id uuid;
begin
  if target_organization_id is null or nullif(btrim(coalesce(target_lead_phone, '')), '') is null then
    return null;
  end if;
  -- Latest enquiry first, a Lost one only when nothing else matches.
  select id into matched_lead_id
  from public.leads
  where organization_id = target_organization_id
    and normalized_phone = target_lead_phone
    and deleted_at is null
  order by (lifecycle_status::text = 'Lost'), created_at desc, id
  limit 1;
  return matched_lead_id;
end;
$$;

revoke all on function app_private.telecmi_inbound_lead_match(uuid, text)
  from public, anon, authenticated;

-- Routing lookup for provider-call-flow-telecmi --------------------------------------
create or replace function public.get_telecmi_inbound_route(
  target_connection_id uuid,
  target_caller_phone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  connection_row public.connected_accounts%rowtype;
  caller_digits text;
  matched_lead_id uuid;
  owner_id uuid;
  owner_phone text;
  agent_entry jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;

  select * into connection_row from public.connected_accounts
  where id = target_connection_id and provider_key = 'telecmi'
    and status = 'CONNECTED' and deleted_at is null;
  if not found then
    return null;
  end if;

  caller_digits := nullif(app_private.telecmi_mapping_phone(target_caller_phone), '');
  if caller_digits is null or caller_digits !~ '^[0-9]{6,15}$' then
    return null;
  end if;

  matched_lead_id := app_private.telecmi_inbound_lead_match(
    connection_row.organization_id, '+' || caller_digits
  );
  if matched_lead_id is null then
    return null;
  end if;

  select lead_row.assigned_user_id, profile_row.normalized_phone
    into owner_id, owner_phone
  from public.leads lead_row
  join public.profiles profile_row
    on profile_row.id = lead_row.assigned_user_id
   and profile_row.organization_id = lead_row.organization_id
   and profile_row.active and profile_row.deleted_at is null
  where lead_row.id = matched_lead_id;
  if owner_id is null or nullif(btrim(coalesce(owner_phone, '')), '') is null then
    return null;
  end if;

  -- The owner rings only when they are a mapped TeleCMI agent on this number.
  select agent into agent_entry
  from jsonb_array_elements(case
    when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
      then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end) agent
  where nullif(btrim(agent ->> 'user_id'), '') is not null
    and nullif(btrim(agent ->> 'phone'), '') is not null
    and app_private.telecmi_mapping_phone(agent ->> 'phone')
      = app_private.telecmi_mapping_phone(owner_phone)
  limit 1;
  if agent_entry is null then
    return null;
  end if;

  return jsonb_build_object(
    'lead_id', matched_lead_id,
    'agent_id', btrim(agent_entry ->> 'user_id'),
    'phone', btrim(agent_entry ->> 'phone')
  );
end;
$$;

revoke all on function public.get_telecmi_inbound_route(uuid, text) from public, anon, authenticated;
grant execute on function public.get_telecmi_inbound_route(uuid, text) to service_role;

-- Callback follow-up: open or refresh -------------------------------------------------
create or replace function app_private.open_missed_call_callback(target_call_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  sla_minutes integer;
  due timestamptz;
  followup_id uuid;
  created boolean;
begin
  select * into call_row from public.calls where id = target_call_id;
  if not found or call_row.direction <> 'INBOUND'
    or call_row.normalized_caller_phone is null
    or call_row.normalized_caller_phone !~ '^\+[0-9]{6,15}$' then
    return null;
  end if;

  select lead_sla_minutes into sla_minutes
  from public.connected_accounts where id = call_row.connection_id;
  -- A missed call is a callback within the hour, even when the lead SLA is a day.
  due := now() + make_interval(mins => least(greatest(coalesce(sla_minutes, 30), 5), 60));

  insert into public.followups (
    organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
    reason, due_at, status, priority, source_call_id, callback_phone
  ) values (
    call_row.organization_id, call_row.branch_id, call_row.team_id, call_row.lead_id,
    call_row.customer_id, call_row.assigned_user_id, 'Customer Callback', due, 'OPEN',
    'HIGH', call_row.id, call_row.normalized_caller_phone
  )
  on conflict (organization_id, callback_phone)
    where callback_phone is not null and status in ('OPEN', 'OVERDUE')
  do update set
    source_call_id = excluded.source_call_id,
    priority = 'HIGH',
    due_at = least(public.followups.due_at, excluded.due_at),
    version = public.followups.version + 1,
    updated_at = now()
  returning id, (xmax = 0) into followup_id, created;

  insert into public.audit_logs (
    organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    call_row.organization_id, call_row.branch_id, null,
    case when created then 'followup.callback_created_from_missed_call'
      else 'followup.callback_refreshed_by_missed_call' end,
    'followup', followup_id,
    jsonb_build_object('call_id', call_row.id, 'lead_id', call_row.lead_id)
  );
  return followup_id;
end;
$$;

revoke all on function app_private.open_missed_call_callback(uuid) from public, anon, authenticated;

-- Callback follow-up: complete once the number is reached ----------------------------
create or replace function app_private.complete_callback_followups(
  target_organization_id uuid,
  target_phone text,
  target_call_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  open_row record;
  completed_count integer := 0;
begin
  if target_organization_id is null or target_phone is null
    or target_phone !~ '^\+[0-9]{6,15}$' then
    return 0;
  end if;
  for open_row in
    select id, branch_id from public.followups
    where organization_id = target_organization_id
      and callback_phone = target_phone
      and status in ('OPEN', 'OVERDUE')
  loop
    -- The update re-runs the work-assignee check; a callback whose owner can
    -- no longer receive work is left open rather than failing the call event.
    begin
      update public.followups set
        status = 'COMPLETED',
        completed_at = now(),
        completion_note = 'Called back',
        version = version + 1,
        updated_at = now()
      where id = open_row.id and status in ('OPEN', 'OVERDUE');
      if found then
        completed_count := completed_count + 1;
        insert into public.audit_logs (
          organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
        ) values (
          target_organization_id, open_row.branch_id, null,
          'followup.callback_completed_by_call', 'followup', open_row.id,
          jsonb_build_object('call_id', target_call_id)
        );
      end if;
    exception when others then
      insert into public.audit_logs (
        organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
      ) values (
        target_organization_id, open_row.branch_id, null,
        'followup.callback_completion_skipped', 'followup', open_row.id,
        jsonb_build_object('call_id', target_call_id, 'error', left(sqlerrm, 200))
      );
    end;
  end loop;
  return completed_count;
end;
$$;

revoke all on function app_private.complete_callback_followups(uuid, text, uuid)
  from public, anon, authenticated;

-- Text patches -------------------------------------------------------------------------
do $patch$
declare
  body text;
  anchor text;
  function_name text;
begin
  -- Inbound call log: shared lead match, then callback open/complete.
  body := pg_get_functiondef(
    'public.apply_telecmi_inbound_call_event(uuid,uuid,timestamptz,jsonb)'::regprocedure
  );
  anchor := '      select * into lead_match from public.leads
      where organization_id = target_organization_id
        and normalized_phone = caller_lead_phone
        and deleted_at is null
      order by (lifecycle_status::text = ''Lost''), created_at desc, id
      limit 1;';
  if position(anchor in body) = 0 then raise exception 'INBOUND_LEAD_MATCH_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '      select * into lead_match from public.leads
      where id = app_private.telecmi_inbound_lead_match(target_organization_id, caller_lead_phone);');

  anchor := '  return jsonb_build_object(
    ''call_id'', call_row.id,
    ''branch_id'', call_row.branch_id,
    ''lead_id'', call_row.lead_id,
    ''status'', call_row.status,';
  if position(anchor in body) = 0 then raise exception 'INBOUND_RETURN_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '  -- A settled missed call opens (or refreshes) the callback follow-up; an
  -- answered one closes it. Neither may stop the call itself being logged.
  if changed and call_row.status = ''FAILED'' and call_row.outcome = ''NO_ANSWER'' then
    begin
      perform app_private.open_missed_call_callback(call_row.id);
    exception when others then
      insert into public.audit_logs (
        organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
      ) values (
        target_organization_id, call_row.branch_id, null, ''followup.callback_skipped'',
        ''call'', call_row.id, jsonb_build_object(''error'', left(sqlerrm, 200))
      );
    end;
  elsif changed and call_row.outcome = ''CONNECTED'' then
    perform app_private.complete_callback_followups(
      target_organization_id, call_row.normalized_caller_phone, call_row.id
    );
  end if;

' || anchor);
  execute body;

  -- Outbound click-to-call: reaching the number completes its callback.
  body := pg_get_functiondef(
    'public.apply_telecmi_call_event(uuid,uuid,uuid,timestamptz,jsonb)'::regprocedure
  );
  anchor := '  if became_connected and call_row.lead_id is not null then
    perform public.record_telecmi_connected_call(
      target_organization_id, target_connection_id, call_row.id, target_provider_event_id
    );
  end if;';
  if position(anchor in body) = 0 then raise exception 'OUTBOUND_CONNECTED_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || '

  if became_connected and call_row.lead_id is not null then
    perform app_private.complete_callback_followups(
      target_organization_id,
      (select normalized_phone from public.leads where id = call_row.lead_id),
      call_row.id
    );
  end if;');
  execute body;

  -- Follow-up lists: a lead-less callback shows its number and "Missed call".
  foreach function_name in array array[
    'public.get_followup_workspace_page_legacy(text,text,text,uuid,uuid,uuid,integer,integer,text,text)',
    'public.get_followup_workspace_filtered_page(text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date,text)',
    'app_private.get_scoped_followup_workspace_filtered_page',
    'app_private.get_telecaller_followup_workspace_filtered_page',
    'app_private.get_sales_consultant_followup_workspace_filtered_page',
    'app_private.get_sales_consultant_followup_workspace_page'
  ] loop
    if position('(' in function_name) > 0 then
      body := pg_get_functiondef(function_name::regprocedure);
    else
      select pg_get_functiondef(p.oid) into body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname || '.' || p.proname = function_name;
      if body is null then raise exception 'FOLLOWUP_PAGE_FUNCTION_MISSING %', function_name; end if;
    end if;
    anchor := 'coalesce(customer_row.full_name, lead_row.customer_name, ''Unlinked customer'')';
    if position(anchor in body) = 0 then
      raise exception 'FOLLOWUP_NAME_ANCHOR_MISSING %', function_name;
    end if;
    body := replace(body, anchor, 'coalesce(customer_row.full_name, lead_row.customer_name,
          case when (select callback_row.callback_phone from public.followups callback_row
                     where callback_row.id = followup_row.id) is not null
            then ''Missed call'' end,
          ''Unlinked customer'')');
    anchor := 'coalesce(customer_row.primary_phone, lead_row.phone)';
    if position(anchor in body) = 0 then
      raise exception 'FOLLOWUP_PHONE_ANCHOR_MISSING %', function_name;
    end if;
    body := replace(body, anchor, 'coalesce(customer_row.primary_phone, lead_row.phone,
          (select callback_row.callback_phone from public.followups callback_row
           where callback_row.id = followup_row.id))');
    execute body;
  end loop;
end;
$patch$;

commit;
