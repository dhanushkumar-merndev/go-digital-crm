begin;

-- Contact was recordable only from the Call and WhatsApp buttons, so a lead the
-- consultant engaged by booking a follow-up or an appointment stayed "not yet
-- contacted" forever. Scheduling a commitment with a customer IS contact, and
-- treating it as such is what lets a lead leave New/Pending by the same route a
-- call does, instead of needing a separate queue rule per activity type.
do $migration$
declare
  signature regprocedure :=
    'public.record_sales_lead_contact(uuid,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := replace(
    definition,
    E'  if normalized_channel not in (''CALL'', ''WHATSAPP'') then\n',
    E'  if normalized_channel not in (''CALL'', ''WHATSAPP'', ''FOLLOWUP'', ''APPOINTMENT'') then\n'
  );

  if updated_definition = definition
    or position('''FOLLOWUP'', ''APPOINTMENT''' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'CONTACT_CHANNEL_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
