begin;

-- Lost is a terminal lifecycle state. A lead can retain historical handoff,
-- follow-up, test-drive, quotation, or booking data, but it must not be shown
-- in active lead queues (in particular, a Sales Consultant's Pending queue).
-- The list RPC is extended by prior migrations, so patch its installed
-- definition instead of restoring an older copy and losing those extensions.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'        case\n          when lead_row.first_contacted_at is null\n',
    E'        case\n          when lead_row.lifecycle_status = ''Lost'' then null\n          when lead_row.first_contacted_at is null\n'
  );
  updated_definition := replace(
    updated_definition,
    E'          target_status = ''sales-new''\n          and actor_is_sales_consultant\n',
    E'          target_status = ''sales-new''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n'
  );
  updated_definition := replace(
    updated_definition,
    E'          target_status = ''sales-pending''\n          and actor_is_sales_consultant\n',
    E'          target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n'
  );
  updated_definition := replace(
    updated_definition,
    E'          target_status = ''sales-contacted''\n          and actor_is_sales_consultant\n',
    E'          target_status = ''sales-contacted''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''\n'
  );
  updated_definition := replace(
    updated_definition,
    E'where actor_is_sales_consultant\n          and sales_handoff_at >= ',
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n          and sales_handoff_at >= '
  );
  updated_definition := replace(
    updated_definition,
    E'where actor_is_sales_consultant\n          and sales_handoff_at < ',
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n          and sales_handoff_at < '
  );
  updated_definition := replace(
    updated_definition,
    E'where actor_is_sales_consultant\n          and sales_contacted_at >= sales_handoff_at',
    E'where actor_is_sales_consultant\n          and lifecycle_status <> ''Lost''\n          and sales_contacted_at >= sales_handoff_at'
  );

  if updated_definition = definition
    or position('when lead_row.lifecycle_status = ''Lost'' then null' in updated_definition) = 0
    or position(E'target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.lifecycle_status <> ''Lost''' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'LOST_LEAD_ACTIVE_VIEW_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
