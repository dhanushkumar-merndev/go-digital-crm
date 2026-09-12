begin;

-- A handoff reason explains why an enquiry is ready for Sales and is part of
-- the assignment history/audit record. Enforce it in the RPC as well as the
-- form so an API caller cannot create an unexplained transfer.
do $migration$
declare
  current_definition text;
  updated_definition text;
  validation_anchor text := E'  if char_length(coalesce(normalized_reason, '''')) > 500 then\n'
    || E'    raise exception using errcode = ''22023'', message = ''TRANSFER_REASON_TOO_LONG'';\n'
    || E'  end if;\n';
  required_validation text := E'  if normalized_reason is null then\n'
    || E'    raise exception using errcode = ''22023'', message = ''TRANSFER_REASON_REQUIRED'';\n'
    || E'  end if;\n';
begin
  select pg_get_functiondef(
    'public.transfer_lead_to_sales(uuid,uuid,text)'::regprocedure
  ) into current_definition;

  if current_definition is null then
    raise exception 'TRANSFER_LEAD_TO_SALES_FUNCTION_NOT_FOUND';
  end if;

  if position('TRANSFER_REASON_REQUIRED' in current_definition) > 0 then
    return;
  end if;

  updated_definition := replace(
    current_definition,
    validation_anchor,
    validation_anchor || E'\n' || required_validation
  );
  if updated_definition = current_definition
    or position('TRANSFER_REASON_REQUIRED' in updated_definition) = 0
  then
    raise exception 'TRANSFER_REASON_REQUIRED_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

revoke all on function public.transfer_lead_to_sales(uuid, uuid, text) from public, anon;
grant execute on function public.transfer_lead_to_sales(uuid, uuid, text) to authenticated;

commit;
