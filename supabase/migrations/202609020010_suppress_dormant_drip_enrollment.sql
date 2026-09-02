begin;

-- Enforced on the table rather than inside create_customer_drip_enrollment, so
-- the suppression holds for every writer -- the RPC today, a campaign dispatcher
-- or an import tomorrow -- instead of only the one code path that happens to
-- remember it. Refusing at enrollment also beats queueing messages that a later
-- send step would have to filter out or cancel.
create or replace function app_private.reject_dormant_drip_enrollment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  blocked boolean := false;
begin
  if new.lead_id is not null then
    select lead_row.temperature = 'DORMANT'
    into blocked
    from public.leads lead_row
    where lead_row.id = new.lead_id
      and lead_row.deleted_at is null;
  else
    -- No lead named on the enrollment: only refuse when the customer has leads
    -- and every one of them is dormant. A customer with no lead at all is not
    -- something this trigger has an opinion about.
    select count(*) > 0 and count(*) filter (where lead_row.temperature = 'DORMANT') = count(*)
    into blocked
    from public.leads lead_row
    where lead_row.organization_id = new.organization_id
      and lead_row.customer_id = new.customer_id
      and lead_row.deleted_at is null;
  end if;

  if coalesce(blocked, false) then
    raise exception using errcode = '22023', message = 'LEAD_IS_DORMANT';
  end if;

  return new;
end;
$$;

revoke all on function app_private.reject_dormant_drip_enrollment()
  from public, anon, authenticated;

drop trigger if exists reject_dormant_drip_enrollment
  on public.customer_drip_enrollments;

create trigger reject_dormant_drip_enrollment
before insert on public.customer_drip_enrollments
for each row
execute function app_private.reject_dormant_drip_enrollment();

commit;
