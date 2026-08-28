begin;

-- Last overlap on the ladder. Follow-up outranks New and Pending, but the two
-- intake queues only excluded contact, later lifecycles and the record flags --
-- never an open follow-up. A lead scheduled for a call but with no recorded
-- contact (every lead seeded before 202608260019 taught follow-ups to record
-- one) was therefore counted under Pending and Follow-up at the same time.
--
-- The anchors are deliberately written out per queue rather than replacing the
-- shared guard block: the Contacted queue from 202608260020 ends with the same
-- four lines and already carries the follow-up exclusion, so a blanket replace
-- would append it there a second time.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  guard_row constant text :=
    E'          and not lead_row.has_test_drive\n          and not lead_row.has_quotation\n          and not lead_row.has_booking\n          and lead_row.lifecycle_status <> ''Appointment Scheduled''\n';
  guard_agg constant text :=
    E'          and not has_test_drive\n          and not has_quotation\n          and not has_booking\n          and lifecycle_status <> ''Appointment Scheduled''\n';
  followup_row constant text := E'          and lead_row.next_followup_at is null\n';
  followup_agg constant text := E'          and next_followup_at is null\n';
  new_head constant text :=
    E'          target_status = ''sales-new''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n';
  pending_head constant text :=
    E'          target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition, new_head || guard_row, new_head || guard_row || followup_row);
  updated_definition := replace(
    updated_definition, pending_head || guard_row, pending_head || guard_row || followup_row);
  updated_definition := replace(
    updated_definition,
    guard_agg || E'          and sales_handoff_at >= ',
    guard_agg || followup_agg || E'          and sales_handoff_at >= ');
  updated_definition := replace(
    updated_definition,
    guard_agg || E'          and sales_handoff_at < ',
    guard_agg || followup_agg || E'          and sales_handoff_at < ');

  if updated_definition = definition
    or position(new_head || guard_row || followup_row in updated_definition) = 0
    or position(pending_head || guard_row || followup_row in updated_definition) = 0
    or position(followup_agg || E'          and sales_handoff_at >= ' in updated_definition) = 0
    or position(followup_agg || E'          and sales_handoff_at < ' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'PENDING_FOLLOWUP_LADDER_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
