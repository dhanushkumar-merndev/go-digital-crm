-- The PDI sheet saved every Pass/Fail click as its own update_pdi_item_result
-- call followed by a full inspection refetch: roughly two requests per point,
-- sixty for a thirty-point sheet. The sheet now keeps results as a local draft
-- and submits them here once, together with the certification when requested.
--
-- This also closes two gaps in the per-item RPCs: they did not require a
-- Delivery permission, and they let a certified (PASSED) inspection be edited.

create or replace function public.save_pdi_inspection(
  target_inspection_id uuid,
  target_items jsonb,
  target_notes text default null,
  target_complete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  inspection_rec public.pdi_inspections%rowtype;
  item_input jsonb;
  item_status text;
  item_notes text;
  updated_count integer;
  unresolved_defects integer;
  pending_items integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not app_private.has_permission(current_organization_id, 'delivery.manage') then
    raise exception using errcode = '42501', message = 'DELIVERY_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_items is null or jsonb_typeof(target_items) <> 'array'
    or jsonb_array_length(target_items) > 500
  then
    raise exception using errcode = '22023', message = 'INVALID_PDI_ITEMS';
  end if;

  -- Lock the inspection so a concurrent save cannot interleave item updates
  -- with this certification.
  select * into inspection_rec
  from public.pdi_inspections
  where id = target_inspection_id and organization_id = current_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PDI_INSPECTION_NOT_FOUND';
  end if;
  if inspection_rec.status = 'PASSED' then
    raise exception using errcode = '23514', message = 'PDI_ALREADY_CERTIFIED';
  end if;

  for item_input in select value from jsonb_array_elements(target_items)
  loop
    item_status := upper(btrim(coalesce(item_input->>'status', '')));
    item_notes := nullif(btrim(coalesce(item_input->>'notes', '')), '');
    if item_status not in ('PENDING', 'PASSED', 'FAILED', 'RECTIFIED', 'NOT_APPLICABLE') then
      raise exception using errcode = '22023', message = 'INVALID_PDI_STATUS';
    end if;
    if char_length(coalesce(item_notes, '')) > 2000 then
      raise exception using errcode = '22023', message = 'INVALID_PDI_NOTES';
    end if;

    update public.pdi_checklist_items set
      status = item_status,
      defect_notes = item_notes,
      inspected_at = now(),
      updated_at = now()
    where id = (item_input->>'id')::uuid
      and inspection_id = target_inspection_id
      and organization_id = current_organization_id
      and (status is distinct from item_status or defect_notes is distinct from item_notes);
    get diagnostics updated_count = row_count;
    if updated_count = 0 and not exists (
      select 1 from public.pdi_checklist_items
      where id = (item_input->>'id')::uuid
        and inspection_id = target_inspection_id
        and organization_id = current_organization_id
    ) then
      raise exception using errcode = 'P0002', message = 'PDI_ITEM_NOT_FOUND';
    end if;
  end loop;

  select count(*) filter (where status = 'FAILED')::integer,
         count(*) filter (where status = 'PENDING')::integer
    into unresolved_defects, pending_items
  from public.pdi_checklist_items
  where inspection_id = target_inspection_id and organization_id = current_organization_id;

  if target_complete then
    if pending_items > 0 then
      raise exception using errcode = '23514', message = 'PDI_CHECKLIST_INCOMPLETE';
    end if;
    if unresolved_defects > 0 then
      raise exception using errcode = '23514', message = 'PDI_UNRESOLVED_DEFECTS_REMAIN';
    end if;
    update public.pdi_inspections set
      status = 'PASSED',
      overall_notes = nullif(btrim(target_notes), ''),
      inspector_id = auth.uid(),
      completed_at = now(),
      updated_at = now()
    where id = target_inspection_id
    returning * into inspection_rec;

    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      current_organization_id, auth.uid(), 'pdi.completed', 'delivery',
      inspection_rec.delivery_id::text,
      jsonb_build_object('inspection_id', inspection_rec.id, 'status', 'PASSED')
    );
  else
    update public.pdi_inspections set
      status = case when unresolved_defects > 0 then 'DEFECTS_FOUND' else 'IN_PROGRESS' end,
      overall_notes = coalesce(nullif(btrim(target_notes), ''), overall_notes),
      updated_at = now()
    where id = target_inspection_id
    returning * into inspection_rec;
  end if;

  return jsonb_build_object(
    'id', inspection_rec.id,
    'delivery_id', inspection_rec.delivery_id,
    'status', inspection_rec.status,
    'completed_at', inspection_rec.completed_at,
    'pending_items', pending_items,
    'unresolved_defects', unresolved_defects
  );
end;
$$;

revoke all on function public.save_pdi_inspection(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.save_pdi_inspection(uuid, jsonb, text, boolean)
  to authenticated, service_role;
