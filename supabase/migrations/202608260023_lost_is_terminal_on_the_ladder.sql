begin;

-- Lost is the terminal state and outranks everything, but the record-flag tabs
-- never excluded it: a lead marked Lost that still carries a booking, quotation
-- or test drive was counted under Lost AND under that tab. `lead_stage` had the
-- same inversion -- it tested `has_booking` before `lifecycle_status`, so a lost
-- lead rendered as "Booking".
--
-- With this the ladder is total and every rung is mutually exclusive:
--   Lost > Booking > Quotation > Test Drive > Appointment > Follow-up >
--   Contacted > Pending/New
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  -- Display: Lost decides the badge before any record flag does.
  updated_definition := replace(
    updated_definition,
    E'        case\n          when lead_row.has_booking then ''Booking''\n',
    E'        case\n          when lead_row.lifecycle_status = ''Lost'' then ''Lost''\n          when lead_row.has_booking then ''Booking''\n'
  );

  -- Filters: a lost lead leaves the three record-flag queues.
  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''test-drive'' and lead_row.has_test_drive and not lead_row.has_quotation and not lead_row.has_booking)\n',
    E'        or (target_status = ''test-drive'' and lead_row.has_test_drive and not lead_row.has_quotation and not lead_row.has_booking and lead_row.lifecycle_status <> ''Lost'')\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''quotation'' and lead_row.has_quotation and not lead_row.has_booking)\n',
    E'        or (target_status = ''quotation'' and lead_row.has_quotation and not lead_row.has_booking and lead_row.lifecycle_status <> ''Lost'')\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''booking'' and lead_row.has_booking)\n',
    E'        or (target_status = ''booking'' and lead_row.has_booking and lead_row.lifecycle_status <> ''Lost'')\n'
  );

  -- Counters follow the same three rules.
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where has_test_drive and not has_quotation and not has_booking)::bigint as test_drive,\n',
    E'        count(*) filter (where has_test_drive and not has_quotation and not has_booking and lifecycle_status <> ''Lost'')::bigint as test_drive,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where has_quotation and not has_booking)::bigint as quotation,\n',
    E'        count(*) filter (where has_quotation and not has_booking and lifecycle_status <> ''Lost'')::bigint as quotation,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where has_booking)::bigint as booking,\n',
    E'        count(*) filter (where has_booking and lifecycle_status <> ''Lost'')::bigint as booking,\n'
  );

  if updated_definition = definition
    or position(E'when lead_row.lifecycle_status = ''Lost'' then ''Lost''' in updated_definition) = 0
    or position(E'target_status = ''booking'' and lead_row.has_booking and lead_row.lifecycle_status <> ''Lost''' in updated_definition) = 0
    or position(E'where has_booking and lifecycle_status <> ''Lost'')::bigint as booking' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'LOST_TERMINAL_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
