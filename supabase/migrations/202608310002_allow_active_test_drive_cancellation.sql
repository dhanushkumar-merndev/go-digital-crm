begin;

-- A consultant may have only one ACTIVE test drive. Previously an interrupted
-- drive could not be cancelled, and after the 24-hour completion window it
-- could not be completed either. That left the consultant permanently unable
-- to start the next valid appointment. Cancellation remains explicit,
-- reasoned, versioned, replay-safe and audited; this only widens the allowed
-- source state from READY to READY or ACTIVE.
create or replace function public.cancel_test_drive(
  target_test_drive_id uuid,
  expected_version bigint,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  drive_row public.test_drives%rowtype;
  previous_status text;
  normalized_reason text := btrim(coalesce(target_reason, ''));
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_test_drive_id is null or expected_version is null or expected_version < 1
    or target_request_id is null or char_length(normalized_reason) not between 5 and 1000
  then raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_CANCELLATION'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;
  fingerprint := app_private.test_drive_request_fingerprint(jsonb_build_object(
    'test_drive_id', target_test_drive_id, 'expected_version', expected_version, 'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_test_drive_request(
    current_organization_id, 'test_drive.cancelled', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into drive_row from public.test_drives source_row
  where source_row.id = target_test_drive_id
    and source_row.organization_id = current_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TEST_DRIVE_NOT_FOUND'; end if;
  if not app_private.can_access_test_drive(drive_row.organization_id, drive_row.id) then
    raise exception using errcode = '42501', message = 'TEST_DRIVE_SCOPE_DENIED';
  end if;
  if drive_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TEST_DRIVE_VERSION_CONFLICT';
  end if;
  if drive_row.status not in ('READY', 'ACTIVE') then
    raise exception using errcode = '23514', message = 'TEST_DRIVE_CANCELLATION_NOT_ALLOWED';
  end if;
  previous_status := drive_row.status;
  update public.test_drives set status = 'CANCELLED', cancelled_at = now(),
    cancellation_reason = normalized_reason, version = version + 1, updated_at = now()
  where id = drive_row.id returning * into drive_row;
  update public.test_drive_appointments set status = 'CANCELLED', cancelled_at = drive_row.cancelled_at,
    cancellation_reason = normalized_reason, version = version + 1, updated_at = now()
  where id = drive_row.appointment_id and organization_id = drive_row.organization_id;
  if previous_status = 'ACTIVE' then
    update public.live_tracking_sessions set ended_at = coalesce(ended_at, drive_row.cancelled_at)
    where organization_id = drive_row.organization_id
      and test_drive_id = drive_row.id and ended_at is null;
  end if;
  result := jsonb_build_object('id', drive_row.id, 'version', drive_row.version,
    'status', drive_row.status, 'replayed', false);
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  values (drive_row.organization_id, drive_row.customer_id, drive_row.lead_id,
    'TEST_DRIVE_CANCELLED', auth.uid(), jsonb_build_object(
      'test_drive_id', drive_row.id, 'reason', normalized_reason, 'previous_status', previous_status
    ));
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    drive_row.organization_id, auth.uid(), 'test_drive.cancelled', 'test_drive', drive_row.id::text,
    drive_row.branch_id, target_request_id,
    jsonb_build_object(
      'fingerprint', fingerprint, 'result', result, 'reason', normalized_reason,
      'previous_status', previous_status
    )
  );
  return result;
end;
$$;

commit;
