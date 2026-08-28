begin;

-- 202608260013 kept Follow-up as a commitment view: every lead owing a call,
-- at any stage, minus Lost. That predates the strict single-state rule, and it
-- is the last queue that still overlaps -- a lead with a booking and an open
-- follow-up was counted under both, so the tabs summed to more than the total.
--
-- Follow-up now sits on the ladder like every other queue: it lists a lead only
-- while a pending follow-up is its furthest point. A booked lead that still owes
-- a call is reachable under Booking, which is the one state it is in.
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
    E'        or (target_status = ''follow-up'' and lead_row.next_followup_at is not null\n          and lead_row.lifecycle_status <> ''Lost'')\n',
    E'        or (target_status = ''follow-up'' and lead_row.next_followup_at is not null\n'
      || E'          and lead_row.lifecycle_status <> ''Lost''\n'
      || E'          and lead_row.lifecycle_status <> ''Appointment Scheduled''\n'
      || E'          and not lead_row.has_test_drive\n'
      || E'          and not lead_row.has_quotation\n'
      || E'          and not lead_row.has_booking)\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where next_followup_at is not null\n          and lifecycle_status <> ''Lost'')::bigint as follow_up,\n',
    E'        count(*) filter (where next_followup_at is not null\n'
      || E'          and lifecycle_status <> ''Lost''\n'
      || E'          and lifecycle_status <> ''Appointment Scheduled''\n'
      || E'          and not has_test_drive\n'
      || E'          and not has_quotation\n'
      || E'          and not has_booking)::bigint as follow_up,\n'
  );

  if updated_definition = definition
    or position(E'target_status = ''follow-up'' and lead_row.next_followup_at is not null\n          and lead_row.lifecycle_status <> ''Lost''\n          and lead_row.lifecycle_status <> ''Appointment Scheduled''' in updated_definition) = 0
    or position(E'and lifecycle_status <> ''Appointment Scheduled''\n          and not has_test_drive\n          and not has_quotation\n          and not has_booking)::bigint as follow_up' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_QUEUE_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
