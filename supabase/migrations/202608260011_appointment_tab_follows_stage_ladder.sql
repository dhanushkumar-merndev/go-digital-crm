begin;

-- The Appointments tab filtered on `lifecycle_status = 'Appointment Scheduled'`
-- alone. That column does not advance when a test drive, quotation or booking
-- record is created, so a lead that had since booked still matched, while its
-- `lead_stage` rendered the higher rung. The tab listed rows labelled Booking.
--
-- Appointments now joins the same ladder as Test Drive, Quotation and Booking:
-- it lists a lead only while an appointment is genuinely its furthest point.
-- Follow-up is deliberately left alone -- it filters on `next_followup_at`,
-- which is a pending commitment rather than a funnel stage, and a booked or
-- lost lead can still legitimately owe someone a call.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''appointment-scheduled''\n          and lead_row.lifecycle_status = ''Appointment Scheduled'')\n',
    E'        or (target_status = ''appointment-scheduled''\n          and lead_row.lifecycle_status = ''Appointment Scheduled''\n          and not lead_row.has_test_drive\n          and not lead_row.has_quotation\n          and not lead_row.has_booking)\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (\n          where lifecycle_status = ''Appointment Scheduled''\n        )::bigint as appointment_scheduled_count,\n',
    E'        count(*) filter (\n          where lifecycle_status = ''Appointment Scheduled''\n            and not has_test_drive\n            and not has_quotation\n            and not has_booking\n        )::bigint as appointment_scheduled_count,\n'
  );

  if updated_definition = definition
    or position(E'lifecycle_status = ''Appointment Scheduled''\n          and not lead_row.has_test_drive' in updated_definition) = 0
    or position(E'where lifecycle_status = ''Appointment Scheduled''\n            and not has_test_drive' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'APPOINTMENT_TAB_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
