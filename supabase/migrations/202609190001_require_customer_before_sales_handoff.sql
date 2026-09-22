begin;

-- A Sales Consultant works the customer, not the enquiry: Customer 360, the
-- vehicle history and every earlier purchase hang off customers.id. Handing
-- over a lead whose customer_id is still null gives them a record with none of
-- that, and leaves the match/create decision -- which AGENTS.md 9.1 and 11
-- place *before* qualification -- to somebody who never spoke to the customer.
-- The form already hides the action; this closes the same gap for an API
-- caller.
do $migration$
declare
  current_definition text;
  updated_definition text;
  validation_anchor text := E'  if target_lead.lifecycle_status = ''Lost'' then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LOST_LEAD_CANNOT_TRANSFER'';\n'
    || E'  end if;\n';
  required_validation text := E'  if target_lead.customer_id is null then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LEAD_CUSTOMER_REQUIRED'';\n'
    || E'  end if;\n';
begin
  select pg_get_functiondef(
    'public.transfer_lead_to_sales(uuid,uuid,text)'::regprocedure
  ) into current_definition;

  if current_definition is null then
    raise exception 'TRANSFER_LEAD_TO_SALES_FUNCTION_NOT_FOUND';
  end if;

  -- Idempotent: re-running must not stack a second copy of the guard.
  if position('LEAD_CUSTOMER_REQUIRED' in current_definition) > 0 then
    return;
  end if;

  updated_definition := replace(
    current_definition,
    validation_anchor,
    validation_anchor || E'\n' || required_validation
  );
  if updated_definition = current_definition
    or position('LEAD_CUSTOMER_REQUIRED' in updated_definition) = 0
  then
    raise exception 'LEAD_CUSTOMER_REQUIRED_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

revoke all on function public.transfer_lead_to_sales(uuid, uuid, text) from public, anon;
grant execute on function public.transfer_lead_to_sales(uuid, uuid, text) to authenticated;

commit;
