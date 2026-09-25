-- The delivery checklist saved every tick as its own set_delivery_checklist_item
-- call, then refetched the case detail and the case list, and locked every box
-- until that round trip finished: about three requests and a wait per item.
-- The sheet now keeps ticks as a local draft and saves them here in one call.
--
-- Rules are the per-item RPC's, applied once to the whole batch: Delivery MANAGE
-- permission, case scope, the PLANNING / CHECKLIST_PENDING lock, per-item
-- optimistic versions (any stale item rejects the whole save), request-id
-- idempotency and one audit row. set_delivery_checklist_item is kept.

create or replace function public.save_delivery_checklist(
  target_delivery_id uuid,
  target_items jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  case_row public.delivery_cases%rowtype;
  item_input jsonb;
  item_id uuid;
  item_version bigint;
  item_completed boolean;
  updated_count integer := 0;
  row_count_value integer;
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_delivery_id is null or target_request_id is null
    or target_items is null or jsonb_typeof(target_items) <> 'array'
    or jsonb_array_length(target_items) not between 1 and 200
  then
    raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CHECKLIST_UPDATE';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.operational_case_permission(current_organization_id, 'DELIVERY', 'MANAGE')
  then
    raise exception using errcode = '42501', message = 'DELIVERY_MANAGE_PERMISSION_REQUIRED';
  end if;

  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'delivery_id', target_delivery_id, 'items', target_items
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.delivery_checklist.saved', target_request_id, fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;

  select * into case_row
  from public.delivery_cases source_row
  where source_row.id = target_delivery_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELIVERY_CASE_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
    case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id
  ) or not app_private.can_access_customer(case_row.organization_id, case_row.customer_id)
  then
    raise exception using errcode = '42501', message = 'OPERATIONAL_CASE_SCOPE_DENIED';
  end if;
  if case_row.status not in ('PLANNING', 'CHECKLIST_PENDING') then
    raise exception using errcode = '23514', message = 'DELIVERY_CHECKLIST_LOCKED';
  end if;

  for item_input in select value from jsonb_array_elements(target_items)
  loop
    begin
      item_id := (item_input->>'id')::uuid;
      item_version := (item_input->>'expected_version')::bigint;
      item_completed := (item_input->>'completed')::boolean;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CHECKLIST_UPDATE';
    end;
    if item_id is null or item_version is null or item_version < 1 or item_completed is null then
      raise exception using errcode = '22023', message = 'INVALID_DELIVERY_CHECKLIST_UPDATE';
    end if;

    update public.delivery_checklist_items set
      completed = item_completed,
      completed_by = case when item_completed then auth.uid() else null end,
      completed_at = case when item_completed then now() else null end,
      version = version + 1,
      updated_at = now()
    where id = item_id
      and delivery_id = case_row.id
      and organization_id = current_organization_id
      and version = item_version
      and completed is distinct from item_completed;
    get diagnostics row_count_value = row_count;

    if row_count_value = 0 then
      -- Either the item is not on this delivery, someone changed it since the
      -- sheet loaded, or it already has the requested value.
      if not exists (
        select 1 from public.delivery_checklist_items existing_row
        where existing_row.id = item_id
          and existing_row.delivery_id = case_row.id
          and existing_row.organization_id = current_organization_id
      ) then
        raise exception using errcode = 'P0002', message = 'DELIVERY_CHECKLIST_ITEM_NOT_FOUND';
      end if;
      if exists (
        select 1 from public.delivery_checklist_items existing_row
        where existing_row.id = item_id and existing_row.version <> item_version
      ) then
        raise exception using errcode = '40001', message = 'DELIVERY_CHECKLIST_VERSION_CONFLICT';
      end if;
    else
      updated_count := updated_count + row_count_value;
    end if;
  end loop;

  if updated_count > 0 and case_row.status = 'PLANNING' then
    update public.delivery_cases set status = 'CHECKLIST_PENDING',
      version = version + 1, updated_at = now()
    where id = case_row.id
    returning * into case_row;
  end if;

  result := jsonb_build_object(
    'delivery_id', case_row.id,
    'updated_items', updated_count,
    'completed_items', (
      select count(*) from public.delivery_checklist_items item_row
      where item_row.delivery_id = case_row.id and item_row.completed
    ),
    'total_items', (
      select count(*) from public.delivery_checklist_items item_row
      where item_row.delivery_id = case_row.id
    ),
    'case_version', case_row.version,
    'case_status', case_row.status,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.delivery_checklist.saved',
    'delivery_case', case_row.id::text, case_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result, 'items', target_items)
  );
  return result;
end;
$$;

revoke all on function public.save_delivery_checklist(uuid, jsonb, uuid) from public, anon;
grant execute on function public.save_delivery_checklist(uuid, jsonb, uuid)
  to authenticated, service_role;
