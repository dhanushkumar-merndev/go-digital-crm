begin;

-- Keep the list page bounded while eliminating its dependent profile-directory
-- request. The security-invoker view still applies both lead and profile RLS;
-- a name is simply null when the caller cannot read that profile.
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
  profile_row.full_name as assigned_user_name
from public.leads lead_row
left join public.profiles profile_row
  on profile_row.organization_id = lead_row.organization_id
 and profile_row.id = lead_row.assigned_user_id
 and profile_row.active
 and profile_row.deleted_at is null;

grant select on public.leads_with_work_state to authenticated;

commit;
