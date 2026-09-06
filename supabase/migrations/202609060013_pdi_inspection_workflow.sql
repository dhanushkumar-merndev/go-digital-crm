-- Pre-Delivery Inspection (PDI) Module: Checklist, Multi-Point Inspection, and Defect Tracking
create table if not exists public.pdi_inspections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  delivery_id uuid not null references public.delivery_cases(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  inspector_id uuid references public.profiles(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_PROGRESS', 'DEFECTS_FOUND', 'PASSED')),
  overall_notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, delivery_id)
);

create table if not exists public.pdi_checklist_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  inspection_id uuid not null references public.pdi_inspections(id) on delete cascade,
  category text not null check (category in ('EXTERIOR', 'INTERIOR', 'MECHANICAL', 'ELECTRICAL', 'WHEELS_TYRES')),
  item_name text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'PASSED', 'FAILED', 'RECTIFIED', 'NOT_APPLICABLE')),
  defect_notes text,
  photo_url text,
  inspected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pdi_inspections enable row level security;
alter table public.pdi_checklist_items enable row level security;

create policy pdi_inspections_tenant_isolation on public.pdi_inspections
  for all using (organization_id = app_private.current_tenant_organization())
  with check (organization_id = app_private.current_tenant_organization());

create policy pdi_items_tenant_isolation on public.pdi_checklist_items
  for all using (organization_id = app_private.current_tenant_organization())
  with check (organization_id = app_private.current_tenant_organization());

create index if not exists idx_pdi_inspections_delivery
  on public.pdi_inspections (organization_id, delivery_id, status);

create index if not exists idx_pdi_checklist_inspection
  on public.pdi_checklist_items (organization_id, inspection_id, category);

create or replace function public.get_or_create_pdi_inspection(target_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  delivery_row public.delivery_cases%rowtype;
  inspection_row public.pdi_inspections%rowtype;
  items jsonb;
  stats jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into delivery_row from public.delivery_cases
  where id = target_delivery_id and organization_id = current_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'DELIVERY_CASE_NOT_FOUND';
  end if;

  select * into inspection_row from public.pdi_inspections
  where delivery_id = target_delivery_id and organization_id = current_organization_id;

  if not found then
    insert into public.pdi_inspections (
      organization_id, delivery_id, booking_id, inspector_id, status
    ) values (
      current_organization_id, target_delivery_id, delivery_row.booking_id, auth.uid(), 'IN_PROGRESS'
    )
    returning * into inspection_row;

    -- Seed standard comprehensive multi-point dealership PDI checks
    insert into public.pdi_checklist_items (organization_id, inspection_id, category, item_name)
    values
      -- Exterior
      (current_organization_id, inspection_row.id, 'EXTERIOR', 'Body panel alignment & gap tolerances'),
      (current_organization_id, inspection_row.id, 'EXTERIOR', 'Paint finish & clear coat inspection'),
      (current_organization_id, inspection_row.id, 'EXTERIOR', 'Windshield, rear glass & door windows'),
      (current_organization_id, inspection_row.id, 'EXTERIOR', 'Headlamps, tail lights, indicators & hazard lights'),
      (current_organization_id, inspection_row.id, 'EXTERIOR', 'Door latches, bonnet & boot lid seals'),
      -- Interior
      (current_organization_id, inspection_row.id, 'INTERIOR', 'Dashboard, steering & console switches'),
      (current_organization_id, inspection_row.id, 'INTERIOR', 'Touchscreen infotainment & audio speakers'),
      (current_organization_id, inspection_row.id, 'INTERIOR', 'Seat adjustments, headrests & upholstery'),
      (current_organization_id, inspection_row.id, 'INTERIOR', 'Seat belts, pretensioners & child safety locks'),
      (current_organization_id, inspection_row.id, 'INTERIOR', 'AC & climate control cooling & blower modes'),
      -- Mechanical
      (current_organization_id, inspection_row.id, 'MECHANICAL', 'Engine oil level & dipstick check'),
      (current_organization_id, inspection_row.id, 'MECHANICAL', 'Coolant, brake fluid & washer reservoir levels'),
      (current_organization_id, inspection_row.id, 'MECHANICAL', 'Battery terminal tightness & health check'),
      (current_organization_id, inspection_row.id, 'MECHANICAL', 'Brake pedal feel & handbrake holding bite'),
      (current_organization_id, inspection_row.id, 'MECHANICAL', 'Engine idle sound & exhaust emission check'),
      -- Electrical
      (current_organization_id, inspection_row.id, 'ELECTRICAL', 'Dual horn & windshield wiper/washer blades'),
      (current_organization_id, inspection_row.id, 'ELECTRICAL', 'Reverse parking camera & ultrasonic sensors'),
      (current_organization_id, inspection_row.id, 'ELECTRICAL', 'All 4 power windows & ORVM power fold'),
      (current_organization_id, inspection_row.id, 'ELECTRICAL', 'Remote keyless entry fobs & push-start button'),
      -- Wheels & Tyres
      (current_organization_id, inspection_row.id, 'WHEELS_TYRES', 'All 4 tyre pressures & alloy rim condition'),
      (current_organization_id, inspection_row.id, 'WHEELS_TYRES', 'Spare wheel, jack, handle & hazard triangle toolkit');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'category', item.category,
    'item_name', item.item_name,
    'status', item.status,
    'defect_notes', item.defect_notes,
    'photo_url', item.photo_url,
    'inspected_at', item.inspected_at
  ) order by item.category, item.id), '[]'::jsonb)
  into items
  from public.pdi_checklist_items item
  where item.inspection_id = inspection_row.id and item.organization_id = current_organization_id;

  select jsonb_build_object(
    'total_items', count(*)::integer,
    'passed', count(*) filter (where status in ('PASSED', 'RECTIFIED', 'NOT_APPLICABLE'))::integer,
    'failed', count(*) filter (where status = 'FAILED')::integer,
    'pending', count(*) filter (where status = 'PENDING')::integer
  ) into stats
  from public.pdi_checklist_items
  where inspection_id = inspection_row.id and organization_id = current_organization_id;

  return jsonb_build_object(
    'inspection', jsonb_build_object(
      'id', inspection_row.id,
      'delivery_id', inspection_row.delivery_id,
      'booking_id', inspection_row.booking_id,
      'status', inspection_row.status,
      'inspector_id', inspection_row.inspector_id,
      'overall_notes', inspection_row.overall_notes,
      'completed_at', inspection_row.completed_at
    ),
    'items', items,
    'stats', stats
  );
end;
$$;

create or replace function public.update_pdi_item_result(
  target_item_id uuid,
  target_status text,
  target_notes text default null,
  target_photo_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  status_val text := upper(trim(target_status));
  updated_item public.pdi_checklist_items%rowtype;
  inspection_rec public.pdi_inspections%rowtype;
  unresolved_defects integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if status_val not in ('PENDING', 'PASSED', 'FAILED', 'RECTIFIED', 'NOT_APPLICABLE') then
    raise exception using errcode = '22023', message = 'INVALID_PDI_STATUS';
  end if;

  update public.pdi_checklist_items set
    status = status_val,
    defect_notes = nullif(trim(target_notes), ''),
    photo_url = nullif(trim(target_photo_url), ''),
    inspected_at = now(),
    updated_at = now()
  where id = target_item_id and organization_id = current_organization_id
  returning * into updated_item;

  if not found then
    raise exception using errcode = 'P0002', message = 'PDI_ITEM_NOT_FOUND';
  end if;

  select count(*)::integer into unresolved_defects
  from public.pdi_checklist_items
  where inspection_id = updated_item.inspection_id and organization_id = current_organization_id
    and status = 'FAILED';

  update public.pdi_inspections set
    status = case when unresolved_defects > 0 then 'DEFECTS_FOUND' else 'IN_PROGRESS' end,
    updated_at = now()
  where id = updated_item.inspection_id and organization_id = current_organization_id
  returning * into inspection_rec;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', updated_item.id,
      'status', updated_item.status,
      'defect_notes', updated_item.defect_notes,
      'inspected_at', updated_item.inspected_at
    ),
    'inspection_status', inspection_rec.status
  );
end;
$$;

create or replace function public.complete_pdi_inspection(
  target_inspection_id uuid,
  target_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  unresolved_defects integer;
  pending_items integer;
  inspection_rec public.pdi_inspections%rowtype;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select count(*) filter (where status = 'FAILED')::integer,
         count(*) filter (where status = 'PENDING')::integer
  into unresolved_defects, pending_items
  from public.pdi_checklist_items
  where inspection_id = target_inspection_id and organization_id = current_organization_id;

  if pending_items > 0 then
    raise exception using errcode = '23514', message = 'PDI_CHECKLIST_INCOMPLETE';
  end if;

  if unresolved_defects > 0 then
    raise exception using errcode = '23514', message = 'PDI_UNRESOLVED_DEFECTS_REMAIN';
  end if;

  update public.pdi_inspections set
    status = 'PASSED',
    overall_notes = nullif(trim(target_notes), ''),
    inspector_id = auth.uid(),
    completed_at = now(),
    updated_at = now()
  where id = target_inspection_id and organization_id = current_organization_id
  returning * into inspection_rec;

  if not found then
    raise exception using errcode = 'P0002', message = 'PDI_INSPECTION_NOT_FOUND';
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'pdi.completed', 'delivery', inspection_rec.delivery_id::text,
    jsonb_build_object('inspection_id', inspection_rec.id, 'status', 'PASSED')
  );

  return jsonb_build_object(
    'id', inspection_rec.id,
    'delivery_id', inspection_rec.delivery_id,
    'status', inspection_rec.status,
    'completed_at', inspection_rec.completed_at
  );
end;
$$;

grant execute on function public.get_or_create_pdi_inspection(uuid) to authenticated;
grant execute on function public.update_pdi_item_result(uuid, text, text, text) to authenticated;
grant execute on function public.complete_pdi_inspection(uuid, text) to authenticated;
