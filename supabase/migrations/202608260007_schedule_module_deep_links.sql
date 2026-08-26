begin;

-- A dashboard test-drive item is keyed by its scheduled appointment, whereas
-- the Test Drives workspace lists the linked `test_drives` record. Teach the
-- workspace search to resolve either ID (and the lead ID) so a schedule card
-- can open the exact record without falling back to an ambiguous name search.
do $migration$
declare
  signature constant regprocedure :=
    'app_private.get_sales_consultant_test_drive_workspace_page(uuid,uuid,uuid[],boolean,boolean,text,text,text,date,date,integer,integer,text,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  updated_definition := replace(
    definition,
    E'        or drive_row.id = search_uuid\n        or position(normalized_search in lower(coalesce(stock_row.vin, ''''))) > 0',
    E'        or drive_row.id = search_uuid\n        or drive_row.appointment_id = search_uuid\n        or drive_row.lead_id = search_uuid\n        or position(normalized_search in lower(coalesce(stock_row.vin, ''''))) > 0'
  );

  if updated_definition = definition then
    raise exception using
      errcode = 'P0001',
      message = 'TEST_DRIVE_DEEP_LINK_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
