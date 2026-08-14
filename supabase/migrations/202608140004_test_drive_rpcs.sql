begin;

create or replace function public.record_test_drive_anchor(
  target_test_drive_id uuid, anchor_kind text, latitude double precision, longitude double precision, recorded_at timestamptz, odometer integer default null
) returns public.test_drives language plpgsql security definer set search_path = '' as $$
declare drive public.test_drives%rowtype; anchor jsonb;
begin
  if anchor_kind not in ('start','reached','end') then raise exception using errcode = '22023', message = 'INVALID_ANCHOR_KIND'; end if;
  if latitude not between -90 and 90 or longitude not between -180 and 180 then raise exception using errcode = '22023', message = 'INVALID_COORDINATES'; end if;
  select * into drive from public.test_drives where id = target_test_drive_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND'; end if;
  if not app_private.has_permission(drive.organization_id, 'test_drive.manage') or not app_private.can_access_record(drive.organization_id, drive.branch_id, drive.team_id, drive.assigned_user_id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  anchor := jsonb_build_object('latitude', latitude, 'longitude', longitude, 'recorded_at', recorded_at);
  if anchor_kind = 'start' then
    if drive.status not in ('READY','SCHEDULED') or odometer is null then raise exception using errcode = '23514', message = 'INVALID_START_TRANSITION'; end if;
    update public.test_drives set status = 'ACTIVE', started_at = recorded_at, start_anchor = anchor, start_odometer = odometer where id = target_test_drive_id returning * into drive;
  elsif anchor_kind = 'reached' then
    if drive.status <> 'ACTIVE' then raise exception using errcode = '23514', message = 'DRIVE_NOT_ACTIVE'; end if;
    update public.test_drives set reached_at = recorded_at, reached_anchor = anchor where id = target_test_drive_id returning * into drive;
  else
    if drive.status <> 'ACTIVE' or odometer is null or odometer < coalesce(drive.start_odometer, 0) then raise exception using errcode = '23514', message = 'INVALID_END_TRANSITION'; end if;
    update public.test_drives set status = 'COMPLETED', completed_at = recorded_at, end_anchor = anchor, end_odometer = odometer,
      duration_seconds = greatest(0, extract(epoch from recorded_at - drive.started_at)::integer), distance_meters = (odometer - drive.start_odometer) * 1000
    where id = target_test_drive_id returning * into drive;
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata)
    values (drive.organization_id, auth.uid(), 'test_drive.anchor.' || anchor_kind, 'test_drive', drive.id::text, drive.branch_id, jsonb_build_object('recorded_at', recorded_at));
  return drive;
end;
$$;
revoke all on function public.record_test_drive_anchor(uuid, text, double precision, double precision, timestamptz, integer) from public, anon;
grant execute on function public.record_test_drive_anchor(uuid, text, double precision, double precision, timestamptz, integer) to authenticated;

create or replace function public.finalize_test_drive_route(target_test_drive_id uuid, route_points jsonb, encoded_polyline text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare drive public.test_drives%rowtype; point jsonb; summary_id uuid; point_total integer;
begin
  select * into drive from public.test_drives where id = target_test_drive_id and status = 'COMPLETED' for update;
  if not found then raise exception using errcode = '23514', message = 'DRIVE_NOT_COMPLETED'; end if;
  if not app_private.has_permission(drive.organization_id, 'test_drive.manage') or not app_private.can_access_record(drive.organization_id, drive.branch_id, drive.team_id, drive.assigned_user_id) then raise exception using errcode = '42501', message = 'PERMISSION_DENIED'; end if;
  point_total := jsonb_array_length(route_points);
  if point_total > 2000 then raise exception using errcode = '22023', message = 'TOO_MANY_ROUTE_POINTS'; end if;
  for point in select value from jsonb_array_elements(route_points) loop
    insert into public.test_drive_route_points (organization_id, test_drive_id, sequence_no, latitude, longitude, recorded_at)
      values (drive.organization_id, drive.id, (point->>'sequenceNo')::integer, (point->>'latitude')::double precision, (point->>'longitude')::double precision, (point->>'recordedAt')::timestamptz)
      on conflict (test_drive_id, sequence_no) do nothing;
  end loop;
  insert into public.test_drive_route_summaries (organization_id, test_drive_id, encoded_polyline, distance_meters, duration_seconds, point_count)
    values (drive.organization_id, drive.id, encoded_polyline, coalesce(drive.distance_meters, 0), coalesce(drive.duration_seconds, 0), point_total)
    on conflict (test_drive_id) do update set encoded_polyline = excluded.encoded_polyline, distance_meters = excluded.distance_meters, duration_seconds = excluded.duration_seconds, point_count = excluded.point_count
    returning id into summary_id;
  return summary_id;
end;
$$;
revoke all on function public.finalize_test_drive_route(uuid, jsonb, text) from public, anon;
grant execute on function public.finalize_test_drive_route(uuid, jsonb, text) to authenticated;

commit;
