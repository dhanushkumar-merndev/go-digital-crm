begin;

-- Calls have no deleted_at column. Count a logged call using the existing
-- tenant, lead and time bounds; leave the customer soft-deletion check intact.
do $migration$
declare
  definition text := pg_get_functiondef('public.dispatch_crm_alerts(integer,timestamptz)'::regprocedure);
  old_predicate constant text := 'c.lead_id=l.id and c.deleted_at is null and c.started_at';
  new_predicate constant text := 'c.lead_id=l.id and c.started_at';
begin
  if (length(definition) - length(replace(definition, old_predicate, ''))) / length(old_predicate) <> 1 then
    raise exception 'CRM_ALERT_CALL_PREDICATE_ANCHOR_NOT_UNIQUE';
  end if;
  execute replace(definition, old_predicate, new_predicate);
end;
$migration$;

commit;
