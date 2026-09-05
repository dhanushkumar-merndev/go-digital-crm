begin;

-- A connected provider call is a verified CRM fact, not an AI suggestion. Move
-- a New lead to Contacted atomically and preserve lifecycle history; all other
-- lifecycle/temperature fields remain untouched for human review.
create or replace function public.record_telecmi_connected_call(
  target_organization_id uuid,
  target_connection_id uuid,
  target_call_id uuid,
  target_provider_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  lead_row public.leads%rowtype;
  contacted_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_organization_id is null or target_connection_id is null
    or target_call_id is null or target_provider_event_id is null then
    raise exception using errcode = '22023', message = 'INVALID_TELECMI_CONNECTED_CALL';
  end if;
  select * into call_row
  from public.calls
  where id = target_call_id
    and organization_id = target_organization_id
    and connection_id = target_connection_id
    and call_source = 'PROVIDER'
    and status = 'COMPLETED'
    and outcome = 'CONNECTED'
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'TELECMI_CONNECTED_CALL_NOT_VERIFIED';
  end if;
  if call_row.lead_id is null then return false; end if;

  select * into lead_row
  from public.leads
  where id = call_row.lead_id
    and organization_id = call_row.organization_id
    and deleted_at is null
  for update;
  if not found then return false; end if;
  contacted_at := greatest(lead_row.created_at, call_row.started_at);
  if lead_row.lifecycle_status = 'New' then
    insert into public.lead_stage_history (
      organization_id, lead_id, from_status, to_status, changed_by, reason
    ) values (
      lead_row.organization_id, lead_row.id, lead_row.lifecycle_status, 'Contacted',
      call_row.assigned_user_id, 'Connected dealership call'
    );
    update public.leads set
      lifecycle_status = 'Contacted',
      first_contacted_at = coalesce(first_contacted_at, contacted_at),
      updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
    where id = lead_row.id and organization_id = lead_row.organization_id;
  elsif lead_row.first_contacted_at is null then
    update public.leads set
      first_contacted_at = contacted_at,
      updated_at = greatest(clock_timestamp(), lead_row.updated_at + interval '1 microsecond')
    where id = lead_row.id and organization_id = lead_row.organization_id;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    call_row.organization_id, call_row.assigned_user_id, 'call.provider_connected',
    'call', call_row.id::text, call_row.branch_id, target_provider_event_id,
    jsonb_build_object('lead_id', call_row.lead_id, 'provider_key', 'telecmi')
  ) on conflict do nothing;
  return true;
end;
$$;

create unique index if not exists audit_telecmi_connected_event_unique_idx
  on public.audit_logs (organization_id, request_id)
  where request_id is not null and action = 'call.provider_connected';

revoke all on function public.record_telecmi_connected_call(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_telecmi_connected_call(uuid, uuid, uuid, uuid)
  to service_role;

commit;
