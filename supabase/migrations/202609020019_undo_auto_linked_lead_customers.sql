begin;

-- Data repair for the same regression 202609020018 fixed in code.
--
-- 202609020006 did not only change create_lead; it also backfilled, creating a
-- customer for every lead that had none and matching on phone digits.
-- 202609020013 restored the intended workflow for new leads -- a lead starts
-- with customer_id null and an authorized user resolves the match through
-- resolve_lead_customer -- but nothing undid the rows already written.
--
-- The visible symptom: those leads' customer names opened a Customer 360 for a
-- person nobody had ever confirmed existed, while a lead created after the
-- revert correctly had none.
--
-- Identified structurally rather than by timestamp: the backfill omitted
-- created_by, and it attached a customer to a lead that already existed, so the
-- customer is newer than every lead pointing at it. Customers created through
-- the product always carry their author.
--
-- The customers are soft-deleted, not removed. Every read in this schema
-- filters deleted_at, so they disappear from search and Customer 360 while the
-- rows stay recoverable if any of them turns out to have been real.
do $migration$
declare
  affected_customers uuid[];
  customer_count integer;
  lead_count integer;
begin
  select coalesce(array_agg(customer_row.id), '{}'::uuid[])
  into affected_customers
  from public.customers customer_row
  where customer_row.deleted_at is null
    and customer_row.created_by is null
    and exists (
      select 1
      from public.leads lead_row
      where lead_row.customer_id = customer_row.id
        and lead_row.deleted_at is null
    )
    -- Manufactured for leads that were already there.
    and not exists (
      select 1
      from public.leads lead_row
      where lead_row.customer_id = customer_row.id
        and lead_row.deleted_at is null
        and lead_row.created_at >= customer_row.created_at
    )
    -- Only ever referenced from leads. Anything else having attached itself
    -- since means the record is in use and must be left alone.
    and not exists (
      select 1 from public.customer_drip_enrollments row_ where row_.customer_id = customer_row.id
    )
    and not exists (
      select 1 from public.followups row_ where row_.customer_id = customer_row.id
    )
    and not exists (
      select 1 from public.appointments row_ where row_.customer_id = customer_row.id
    )
    and not exists (
      select 1 from public.calls row_ where row_.customer_id = customer_row.id
    );

  customer_count := coalesce(array_length(affected_customers, 1), 0);

  -- A backfill this narrow touched single figures. If the rule ever matches
  -- broadly it has stopped meaning what it was written to mean, and unlinking
  -- real customers is not something to discover afterwards.
  if customer_count > 25 then
    raise exception using
      errcode = 'P0001',
      message = 'AUTO_LINKED_CUSTOMER_CLEANUP_SCOPE_TOO_BROAD';
  end if;

  if customer_count = 0 then
    return;
  end if;

  update public.leads
  set customer_id = null,
      updated_at = greatest(now(), updated_at + interval '1 microsecond')
  where customer_id = any(affected_customers)
    and deleted_at is null;
  get diagnostics lead_count = row_count;

  update public.customers
  set deleted_at = now(),
      deletion_reason = 'Auto-created by the 202609020006 lead backfill; '
        || 'customer identity is resolved explicitly (202609020013).'
  where id = any(affected_customers);

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  )
  select
    customer_row.organization_id,
    null,
    'customer.auto_link_reverted',
    'customer',
    customer_row.id::text,
    jsonb_build_object(
      'migration', '202609020019',
      'customers_soft_deleted', customer_count,
      'leads_unlinked', lead_count
    )
  from public.customers customer_row
  where customer_row.id = any(affected_customers);
end;
$migration$;

commit;
