begin;

-- The Telecaller dashboard's "Needs a call now" queue names the customer and
-- says how overdue the follow-up is, but carries no phone number, so the only
-- thing a caller can do from it is navigate away to the follow-up list and find
-- the row again. Adding the number lets the card offer the two actions the
-- queue exists for -- call and WhatsApp -- without leaving the dashboard.
--
-- `attention_rows` already left-joins both the lead and the customer, so this
-- is one more projected column rather than new joins or a wider scan.
--
-- The projection appears exactly once. The count is asserted rather than
-- assumed: if a later migration duplicates this block per data scope, a blind
-- replace would patch one copy and leave the queue silently phoneless for the
-- others, which is the kind of thing nobody notices until a demo.

do $migration$
declare
  signature constant regprocedure :=
    'app_private.tenant_dashboard_live_items(uuid,text)'::regprocedure;
  definition text;
  updated_definition text;
  anchor constant text :=
    E'        candidate_row.lead_id\n      from attention_candidates candidate_row';
  replacement constant text :=
    E'        candidate_row.lead_id,\n'
    || E'        coalesce(customer_row.primary_phone, lead_row.phone) as phone\n'
    || E'      from attention_candidates candidate_row';
  anchor_count integer;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  -- Already applied: leave the installed body alone.
  if position('as phone' in definition) > 0 then
    return;
  end if;

  anchor_count :=
    (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if anchor_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'DASHBOARD_ATTENTION_PHONE_ANCHOR_COUNT_' || anchor_count::text;
  end if;

  updated_definition := replace(definition, anchor, replacement);

  if (length(updated_definition) - length(replace(updated_definition, 'as phone', '')))
     / length('as phone') <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'DASHBOARD_ATTENTION_PHONE_PATCH_FAILED';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
