begin;

-- Sales Consultants normally receive leads at Transferred to Sales. Scheduling
-- any customer appointment must progress that lifecycle to Appointment
-- Scheduled just as it already does for New, Contacted and Qualified leads.
do $migration$
declare
  signature regprocedure :=
    'public.create_appointment(uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_get_functiondef(signature) into definition;
  updated_definition := replace(
    definition,
    E'and lead_row.lifecycle_status in (''New'', ''Contacted'', ''Qualified'')',
    E'and lead_row.lifecycle_status in (''New'', ''Contacted'', ''Qualified'', ''Transferred to Sales'')'
  );

  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'APPOINTMENT_STAGE_TRANSITION_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
