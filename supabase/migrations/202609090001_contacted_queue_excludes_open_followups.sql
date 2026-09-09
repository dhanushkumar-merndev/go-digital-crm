begin;

-- 202608260020 put the Contacted queue on the ladder, but only for the
-- consultant's `sales-contacted` tab. The shared `contacted` tab -- the one a
-- Telecaller works, and the one the manager roles see -- kept its original
-- `lifecycle_status = 'Contacted'` test, so booking a follow-up (which records
-- contact since 202608260019) left the lead sitting under Contacted and
-- Follow-up at the same time, and the tab counters summed past All.
--
-- Contacted keeps the meaning the sales queue already gives it: "reached, and
-- nothing scheduled since". Equality on lifecycle_status already rules out
-- Lost, Appointment Scheduled and Transferred to Sales, so only the record
-- flags and the open follow-up need excluding here.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  row_anchor constant text :=
    E'        or (target_status = ''contacted'' and lead_row.lifecycle_status = ''Contacted'')\n';
  row_patched constant text :=
    E'        or (target_status = ''contacted'' and lead_row.lifecycle_status = ''Contacted''\n'
    || E'          and not lead_row.has_test_drive\n'
    || E'          and not lead_row.has_quotation\n'
    || E'          and not lead_row.has_booking\n'
    || E'          and lead_row.next_followup_at is null)\n';
  agg_anchor constant text :=
    E'        count(*) filter (where lifecycle_status = ''Contacted'')::bigint as contacted_count,\n';
  agg_patched constant text :=
    E'        count(*) filter (\n'
    || E'          where lifecycle_status = ''Contacted''\n'
    || E'          and not has_test_drive\n'
    || E'          and not has_quotation\n'
    || E'          and not has_booking\n'
    || E'          and next_followup_at is null\n'
    || E'        )::bigint as contacted_count,\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  if position(row_anchor in definition) = 0 or position(agg_anchor in definition) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'CONTACTED_FOLLOWUP_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  updated_definition := replace(definition, row_anchor, row_patched);
  updated_definition := replace(updated_definition, agg_anchor, agg_patched);

  if updated_definition = definition
    or position(row_patched in updated_definition) = 0
    or position(agg_patched in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'CONTACTED_FOLLOWUP_LADDER_PATCH_FAILED';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
