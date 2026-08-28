begin;

-- 202608260008 established that Lost is terminal and must not appear in active
-- lead queues, but it only patched the New, Pending and Contacted queues. The
-- Follow-up tab filters on `next_followup_at is not null`, and nothing clears
-- that column when a lead is marked Lost, so a dead lead kept its scheduled
-- call and the tab listed it as "Follow-up -> Lost": a commitment to phone
-- someone who has already walked away.
--
-- Follow-up stays a commitment view rather than a funnel rung -- a booked lead
-- still owes a delivery-confirmation call and must remain listed. Only the
-- terminal state is removed, which is the same rule 202608260008 applied.
--
-- The stored `next_followup_at` is deliberately left in place: it is history,
-- and a reopened lead should not silently lose the date it was last working to.
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
    E'        or (target_status = ''follow-up'' and lead_row.next_followup_at is not null)\n',
    E'        or (target_status = ''follow-up'' and lead_row.next_followup_at is not null\n          and lead_row.lifecycle_status <> ''Lost'')\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where next_followup_at is not null)::bigint as follow_up,\n',
    E'        count(*) filter (where next_followup_at is not null\n          and lifecycle_status <> ''Lost'')::bigint as follow_up,\n'
  );

  if updated_definition = definition
    or position(E'target_status = ''follow-up'' and lead_row.next_followup_at is not null\n          and lead_row.lifecycle_status <> ''Lost''' in updated_definition) = 0
    or position(E'where next_followup_at is not null\n          and lifecycle_status <> ''Lost''' in updated_definition) = 0
  then
    raise exception using errcode = 'P0001', message = 'LOST_LEAD_FOLLOWUP_QUEUE_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
