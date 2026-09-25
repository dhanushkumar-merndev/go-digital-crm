begin;

-- A cancellation can happen after a drive has started. Keep its observed start
-- (and optional reached) anchors for audit/history, while ensuring it cannot
-- carry completion or route-summary evidence. The earlier lifecycle rule only
-- allowed empty, never-started drives to become CANCELLED, which contradicted
-- cancel_test_drive's explicit ACTIVE-state support.
alter table public.test_drives drop constraint if exists test_drives_lifecycle_check;
alter table public.test_drives
  add constraint test_drives_lifecycle_check
  check (
    version > 0
    and appointment_id is not null
    and (start_odometer is null or start_odometer between 0 and 2000000)
    and (end_odometer is null or end_odometer between 0 and 2000000)
    and (end_odometer is null or start_odometer is null or end_odometer >= start_odometer)
    and (distance_meters is null or distance_meters >= 0)
    and (duration_seconds is null or duration_seconds >= 0)
    and (
      (reached_at is null and reached_anchor is null)
      or (
        reached_at is not null
        and reached_anchor is not null
        and started_at is not null
        and reached_at >= started_at
        and (completed_at is null or reached_at <= completed_at)
      )
    )
    and (
      route_finalized_at is null
      or (
        status = 'COMPLETED'
        and completed_at is not null
        and route_finalized_at >= completed_at
      )
    )
    and (
      (
        status = 'READY'
        and started_at is null
        and completed_at is null
        and start_anchor is null
        and end_anchor is null
        and start_odometer is null
        and end_odometer is null
        and reached_at is null
        and reached_anchor is null
        and distance_meters is null
        and duration_seconds is null
        and cancelled_at is null
        and cancellation_reason is null
      )
      or (
        status = 'ACTIVE'
        and started_at is not null
        and start_anchor is not null
        and start_odometer is not null
        and completed_at is null
        and end_anchor is null
        and end_odometer is null
        and distance_meters is null
        and duration_seconds is null
        and cancelled_at is null
        and cancellation_reason is null
      )
      or (
        status = 'COMPLETED'
        and started_at is not null
        and completed_at is not null
        and completed_at >= started_at
        and start_anchor is not null
        and end_anchor is not null
        and start_odometer is not null
        and end_odometer is not null
        and distance_meters is not null
        and duration_seconds is not null
        and cancelled_at is null
        and cancellation_reason is null
      )
      or (
        status = 'CANCELLED'
        and completed_at is null
        and end_anchor is null
        and end_odometer is null
        and distance_meters is null
        and duration_seconds is null
        and cancelled_at is not null
        and char_length(btrim(cancellation_reason)) between 5 and 1000
        and (
          (
            started_at is null
            and start_anchor is null
            and start_odometer is null
            and reached_at is null
            and reached_anchor is null
          )
          or (
            started_at is not null
            and start_anchor is not null
            and start_odometer is not null
          )
        )
      )
    )
  ) not valid;

alter table public.test_drives validate constraint test_drives_lifecycle_check;

commit;
