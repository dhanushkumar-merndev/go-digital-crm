begin;

-- The booking function already has a PL/pgSQL lead_row variable. Its Lost-lead
-- guard must use a distinct SQL alias, including on already migrated tenants.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.create_booking_from_quotation(uuid,bigint,numeric,boolean,boolean,date,uuid)'::regprocedure
  );
  old_guard constant text := $old$    select 1 from public.leads lead_row
    where lead_row.organization_id = quotation_row.organization_id
      and lead_row.id = quotation_row.lead_id
      and lead_row.lifecycle_status = 'Lost'$old$;
  new_guard constant text := $new$    select 1 from public.leads booking_lead
    where booking_lead.organization_id = quotation_row.organization_id
      and booking_lead.id = quotation_row.lead_id
      and booking_lead.lifecycle_status = 'Lost'$new$;
begin
  if (length(definition) - length(replace(definition, old_guard, ''))) / length(old_guard) <> 1 then
    raise exception 'BOOKING_LOST_GUARD_ANCHOR_NOT_UNIQUE';
  end if;
  execute replace(definition, old_guard, new_guard);
end;
$migration$;

commit;
