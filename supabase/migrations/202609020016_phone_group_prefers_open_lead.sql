begin;

-- 202609020001 made the newest enquiry represent its phone group. "Newest" on
-- its own promotes a lead that is finished: a group holding a New enquiry and a
-- later Transferred to Sales one showed the transferred lead as the group row,
-- so the list advertised work that had already left the queue and hid the lead
-- still waiting for a call. Lost did the same.
--
-- The group is now represented by a lead that is still being worked, and only
-- falls back to a finished one when every lead in the group is finished.
-- "Finished" is relative to who is looking: Transferred to Sales is the end of
-- the Telecaller's job and the start of the Sales Consultant's, so it is only
-- demoted for the roles it is terminal for.
--
-- Newest-first still breaks ties inside a rank, so the group row stays the most
-- recent enquiry among the ones that actually need attention.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  -- The ranking reads lifecycle_status, which filtered_lead_ids did not carry.
  updated_definition := replace(
    updated_definition,
    E'        lead_row.customer_name,\n'
      || E'        lead_row.normalized_phone\n'
      || E'      from staged_leads lead_row\n',
    E'        lead_row.customer_name,\n'
      || E'        lead_row.normalized_phone,\n'
      || E'        lead_row.lifecycle_status\n'
      || E'      from staged_leads lead_row\n'
  );

  updated_definition := replace(
    updated_definition,
    E'        lead_row.customer_name,\n'
      || E'        lead_row.normalized_phone\n'
      || E'      from filtered_lead_ids lead_row\n'
      || E'      order by\n'
      || E'        coalesce(nullif(lead_row.normalized_phone, ''''), lead_row.id::text),\n'
      || E'        lead_row.created_at desc,\n'
      || E'        lead_row.id desc\n',
    E'        lead_row.customer_name,\n'
      || E'        lead_row.normalized_phone,\n'
      || E'        lead_row.lifecycle_status\n'
      || E'      from filtered_lead_ids lead_row\n'
      || E'      order by\n'
      || E'        coalesce(nullif(lead_row.normalized_phone, ''''), lead_row.id::text),\n'
      || E'        case\n'
      || E'          when lead_row.lifecycle_status = ''Lost'' then 2\n'
      || E'          when lead_row.lifecycle_status = ''Transferred to Sales''\n'
      || E'            and not actor_is_sales_consultant then 1\n'
      || E'          else 0\n'
      || E'        end,\n'
      || E'        lead_row.created_at desc,\n'
      || E'        lead_row.id desc\n'
  );

  if updated_definition = definition
    or position(
      E'        lead_row.normalized_phone,\n        lead_row.lifecycle_status\n'
        || E'      from staged_leads lead_row' in updated_definition
    ) = 0
    or position(
      E'when lead_row.lifecycle_status = ''Transferred to Sales''\n'
        || E'            and not actor_is_sales_consultant then 1' in updated_definition
    ) = 0
    -- The unranked order must be gone, or the patch landed somewhere harmless
    -- and the group row would still be picked by recency alone.
    or position(
      E'      from filtered_lead_ids lead_row\n      order by\n'
        || E'        coalesce(nullif(lead_row.normalized_phone, ''''), lead_row.id::text),\n'
        || E'        lead_row.created_at desc' in updated_definition
    ) > 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'PHONE_GROUP_OPEN_LEAD_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
