begin;

-- 202608260010 removed leads that reached a test drive, quotation or booking
-- from the New and Pending queues, but those three are record-existence flags.
-- Scheduling an appointment advances `lifecycle_status` instead, and nothing in
-- the queue predicate looked at it -- so a consultant who booked a showroom
-- visit watched the lead stay in "not worked yet" and appear in Appointments at
-- the same time. Booking an appointment also never sets `sales_contacted_at`,
-- which is written only by the Call and WhatsApp buttons, so the lead could not
-- age out of the queue by any route.
--
-- An appointment is work, so it leaves the queue on the same terms as the rest.
-- Both replacements are intentionally global: each target appears once for
-- `sales-new` and once for `sales-pending`, and the rule is identical for both.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  worked_row constant text :=
    E'          and not lead_row.has_test_drive\n          and not lead_row.has_quotation\n          and not lead_row.has_booking\n';
  worked_agg constant text :=
    E'          and not has_test_drive\n          and not has_quotation\n          and not has_booking\n';
  appointment_row constant text :=
    E'          and lead_row.lifecycle_status <> ''Appointment Scheduled''\n';
  appointment_agg constant text :=
    E'          and lifecycle_status <> ''Appointment Scheduled''\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;
  updated_definition := replace(updated_definition, worked_row, worked_row || appointment_row);
  updated_definition := replace(updated_definition, worked_agg, worked_agg || appointment_agg);

  if updated_definition = definition
    or position(worked_row || appointment_row in updated_definition) = 0
    or position(worked_agg || appointment_agg in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'APPOINTMENT_PENDING_QUEUE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
