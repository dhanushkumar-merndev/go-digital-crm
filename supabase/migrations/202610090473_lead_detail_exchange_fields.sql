begin;
-- Lead detail renders the same requirement cards as Customer 360, so it needs
-- the exchange vehicle and exchange case beside the requirements that
-- 202610090451 added. Both come from the shared helpers of 202610090471.
do $$
declare
  target regprocedure := 'public.get_lead_detail_workspace(uuid)';
  definition text := pg_get_functiondef(target);
  old_text text := $old$    'requirements', app_private.lead_requirements_json(lead_row.id)$old$;
  new_text text := $new$    'requirements', app_private.lead_requirements_json(lead_row.id),
    'exchange_vehicle', app_private.lead_exchange_vehicle_json(lead_row.id),
    'exchange_case', case when lead_row.customer_id is not null
      then app_private.customer_exchange_case_json(lead_row.organization_id, lead_row.customer_id) end$new$;
begin
  if (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text) <> 1 then
    raise exception 'PATCH_ANCHOR_MISSING for %', target;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;
commit;
