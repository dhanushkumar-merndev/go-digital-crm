begin;

-- New and Pending are the "handed to me, not yet worked" queues. Membership was
-- decided only by `sales_contacted_at`, which is written by exactly one RPC
-- (`record_sales_lead_contact`) reachable from exactly two buttons: call and
-- WhatsApp. Every other form of progress -- an appointment, a test drive, a
-- quotation, a signed booking -- left that column null, so a lead with a
-- confirmed booking sat in the "haven't called them yet" queue indefinitely.
--
-- Progress is now treated as engagement for queue membership only. A lead that
-- reached a test drive, quotation or booking leaves New and Pending and stays
-- reachable under the stage tab that matches its `lead_stage`.
--
-- This deliberately does NOT backfill `sales_contacted_at`; the Contacted tab
-- still means "a consultant recorded a contact", and stays honest about what it
-- measures rather than inferring a phone call that may never have happened.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  worked_row constant text :=
    E'          and not lead_row.has_test_drive\n          and not lead_row.has_quotation\n          and not lead_row.has_booking\n';
  worked_agg constant text :=
    E'          and not has_test_drive\n          and not has_quotation\n          and not has_booking\n';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'          target_status = ''sales-new''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n',
    E'          target_status = ''sales-new''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n' || worked_row
  );
  updated_definition := replace(
    updated_definition,
    E'          target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n',
    E'          target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n' || worked_row
  );

  updated_definition := replace(
    updated_definition,
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n          and sales_handoff_at >= ',
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n' || worked_agg || E'          and sales_handoff_at >= '
  );
  updated_definition := replace(
    updated_definition,
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n          and sales_handoff_at < ',
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n' || worked_agg || E'          and sales_handoff_at < '
  );

  if updated_definition = definition
    or position(E'target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n' || worked_row in updated_definition) = 0
    or position(E'target_status = ''sales-new''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n' || worked_row in updated_definition) = 0
    or position(worked_agg || E'          and sales_handoff_at >= ' in updated_definition) = 0
    or position(worked_agg || E'          and sales_handoff_at < ' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'PROGRESSED_LEAD_QUEUE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
