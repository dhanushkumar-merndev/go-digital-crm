-- =============================================================================
-- CLEANUP: removes everything 01-seed-org-leads.sql and
-- 02-seed-telecaller-focus-activity.sql created -- every run's leads, their
-- customers, and every call/follow-up/task/note/activity/conversation
-- attached to those leads. Nothing else is touched (real data is never
-- selected by any of these WHERE clauses).
--
--   npx supabase db query --linked -f scripts/sql/03-cleanup-seed-data.sql
-- =============================================================================

begin;

do $cleanup$
declare
  v_lead_ids uuid[];
  v_customer_ids uuid[];
  v_deleted bigint;
begin
  select coalesce(array_agg(id), array[]::uuid[]) into v_lead_ids
  from public.leads
  where campaign like 'SEED_DEMO_100K_%';

  select coalesce(array_agg(id), array[]::uuid[]) into v_customer_ids
  from public.customers
  where full_name like 'Seed Customer %';

  if cardinality(v_lead_ids) = 0 and cardinality(v_customer_ids) = 0 then
    raise notice 'Nothing to clean up -- no seeded leads or customers found.';
    return;
  end if;

  raise notice 'Removing % seeded leads and % seeded customers, plus everything attached to them.',
    cardinality(v_lead_ids), cardinality(v_customer_ids);

  delete from public.conversation_messages
  where conversation_id in (select id from public.conversations where lead_id = any(v_lead_ids));
  delete from public.conversations where lead_id = any(v_lead_ids);
  delete from public.activities where lead_id = any(v_lead_ids);
  delete from public.calls where lead_id = any(v_lead_ids);
  delete from public.followups where lead_id = any(v_lead_ids);
  delete from public.tasks where resource_type = 'LEAD' and resource_id = any(v_lead_ids);
  delete from public.notes where resource_type = 'customer' and resource_id = any(v_customer_ids);

  delete from public.leads where id = any(v_lead_ids);
  get diagnostics v_deleted = row_count;
  raise notice 'Deleted % leads.', v_deleted;

  delete from public.customers where id = any(v_customer_ids);
  get diagnostics v_deleted = row_count;
  raise notice 'Deleted % customers.', v_deleted;
end;
$cleanup$;

commit;
