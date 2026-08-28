begin;

-- `lead_stage` is a priority ladder: a lead that reached Booking displays as
-- Booking even though its quotation and test-drive records still exist. The
-- tab filters and counters were independent existence checks over the same
-- flags, so one lead was listed under Test Drive, Quotation and Booking at
-- once while every row rendered the single highest stage. A consultant opening
-- Quotation saw two rows both labelled Booking and could not tell which tab
-- owned the lead.
--
-- The filters and counters now follow the same ladder as the display, so each
-- lead appears under exactly the stage it shows. Nothing is hidden: a lead that
-- leaves Quotation for Booking is still reachable, in the tab that matches its
-- stage. The underlying quotation/test-drive records are untouched.
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
    E'        or (target_status = ''test-drive'' and lead_row.has_test_drive)\n',
    E'        or (target_status = ''test-drive'' and lead_row.has_test_drive and not lead_row.has_quotation and not lead_row.has_booking)\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''quotation'' and lead_row.has_quotation)\n',
    E'        or (target_status = ''quotation'' and lead_row.has_quotation and not lead_row.has_booking)\n'
  );

  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where has_test_drive)::bigint as test_drive,\n',
    E'        count(*) filter (where has_test_drive and not has_quotation and not has_booking)::bigint as test_drive,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where has_quotation)::bigint as quotation,\n',
    E'        count(*) filter (where has_quotation and not has_booking)::bigint as quotation,\n'
  );

  if updated_definition = definition
    or position('has_test_drive and not lead_row.has_quotation and not lead_row.has_booking' in updated_definition) = 0
    or position('has_quotation and not lead_row.has_booking' in updated_definition) = 0
    or position('where has_test_drive and not has_quotation and not has_booking' in updated_definition) = 0
    or position('where has_quotation and not has_booking' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'LEAD_STAGE_TAB_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
