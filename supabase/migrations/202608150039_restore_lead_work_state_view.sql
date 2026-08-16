begin;

-- 150038 made profile RLS part of every lead-list query. In the linked project
-- that policy can recurse through authority checks and exceed the statement
-- timeout. Restore the lean lead-only view before a dedicated scoped list RPC
-- is introduced.
create or replace view public.leads_with_work_state
with (security_invoker = true) as
select lead_row.*,
  case
    when lead_row.first_contacted_at is null
      and lead_row.sla_due_at is not null
      and now() > lead_row.sla_due_at then 'SLA_RISK'
    when lead_row.first_contacted_at is null
      and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
    when lead_row.first_contacted_at is null then 'NEW_TODAY'
    else null
  end as work_state,
  null::text as assigned_user_name
from public.leads lead_row;

grant select on public.leads_with_work_state to authenticated;

commit;
