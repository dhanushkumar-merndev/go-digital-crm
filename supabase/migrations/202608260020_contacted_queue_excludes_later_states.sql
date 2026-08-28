begin;

-- Contacted was the last queue still holding leads that had moved on. Booking a
-- follow-up now records contact (202608260019), so every follow-up lead also
-- satisfied `sales_contacted_at >= sales_handoff_at` and appeared under both
-- Contacted and Follow-up at once -- the double state the strict rules exist to
-- remove.
--
-- Contacted now means "reached, and nothing scheduled since": the rung directly
-- above Pending and directly below Follow-up. The full ladder each queue now
-- honours is Lost > Booking > Quotation > Test Drive > Appointment > Follow-up >
-- Contacted > Pending/New, so a lead appears under exactly one of them.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  row_guard constant text :=
    E'          and not lead_row.has_test_drive\n'
    || E'          and not lead_row.has_quotation\n'
    || E'          and not lead_row.has_booking\n'
    || E'          and lead_row.lifecycle_status <> ''Appointment Scheduled''\n'
    || E'          and lead_row.next_followup_at is null\n';
  agg_guard constant text :=
    E'          and not has_test_drive\n'
    || E'          and not has_quotation\n'
    || E'          and not has_booking\n'
    || E'          and lifecycle_status <> ''Appointment Scheduled''\n'
    || E'          and next_followup_at is null\n';
  row_anchor constant text :=
    E'          target_status = ''sales-contacted''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n';
  agg_anchor constant text :=
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n          and sales_contacted_at >= sales_handoff_at';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;
  updated_definition := replace(updated_definition, row_anchor, row_anchor || row_guard);
  updated_definition := replace(
    updated_definition,
    agg_anchor,
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n' || agg_guard || E'          and sales_contacted_at >= sales_handoff_at'
  );

  if updated_definition = definition
    or position(row_anchor || row_guard in updated_definition) = 0
    or position(agg_guard || E'          and sales_contacted_at >= sales_handoff_at' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'CONTACTED_QUEUE_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
