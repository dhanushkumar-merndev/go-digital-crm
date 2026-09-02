begin;

-- Phone and email are customer match signals, never an instruction to merge or
-- create a customer. 202609020006/007 briefly made create_lead reuse the first
-- matching phone or silently create a Customer 360. Restore the intended
-- workflow: create the enquiry with customer_id NULL, then let an authorized
-- user resolve the possible match through resolve_lead_customer with a reason.
do $migration$
declare
  signature regprocedure :=
    'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  -- Safe when an earlier deployment already restored the explicit workflow.
  if position('resolved_customer_id' in definition) = 0
    and position('lead_phone_digits' in definition) = 0
    and position('Customer identity is resolved explicitly after creation' in definition) > 0
  then
    return;
  end if;

  updated_definition := replace(
    updated_definition,
    E'  resolved_customer_id uuid;\n  lead_phone_digits text;\n',
    ''
  );

  updated_definition := regexp_replace(
    updated_definition,
    E'  -- A lead carried the customer''s name and number but never a customer_id,[\\s\\S]*?  perform set_config\\(''app\\.create_lead_rpc'', ''on'', true\\);',
    E'  -- Customer identity is resolved explicitly after creation. A matching\n'
      || E'  -- phone/email only produces candidates for resolve_lead_customer.\n'
      || E'  perform set_config(''app.create_lead_rpc'', ''on'', true);'
  );

  updated_definition := replace(
    updated_definition,
    E'    organization_id,\n    customer_id,\n    branch_id,\n',
    E'    organization_id,\n    branch_id,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'    target_organization_id,\n    resolved_customer_id,\n    resolved_branch_id,\n',
    E'    target_organization_id,\n    resolved_branch_id,\n'
  );

  if updated_definition = definition
    or position('resolved_customer_id' in updated_definition) > 0
    or position('lead_phone_digits' in updated_definition) > 0
    or position(E'organization_id,\n    customer_id,\n    branch_id' in updated_definition) > 0
    or position('Customer identity is resolved explicitly after creation' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'EXPLICIT_CUSTOMER_RESOLUTION_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
