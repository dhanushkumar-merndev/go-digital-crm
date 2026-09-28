begin;

-- The lead workspace derived five facts for every lead in the viewer's scope on
-- every request -- whether it has a test drive, quotation or live booking, and
-- when it was handed to Sales and last contacted by Sales -- through three
-- joins and two correlated subqueries per lead. That is ~40 ms for one Sales
-- Consultant's 1,066 leads and grows linearly with scope, so an org-wide
-- manager view at 100k leads would take seconds.
--
-- The facts are kept here, one row per lead that has any of them, maintained by
-- the writes that change them. A lead with no row has none of the facts.
-- They live beside `leads`, not on it: `leads` carries realtime-broadcast and
-- cache-version triggers, and quoting or booking must not bump the lead's
-- updated_at or fan out a lead change event.
create table app_private.lead_sales_facts (
  lead_id uuid primary key references public.leads (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  has_test_drive boolean not null default false,
  has_quotation boolean not null default false,
  has_booking boolean not null default false,
  sales_handoff_at timestamptz,
  sales_contacted_at timestamptz,
  refreshed_at timestamptz not null default clock_timestamp()
);
create index lead_sales_facts_org_idx on app_private.lead_sales_facts (organization_id, lead_id);
alter table app_private.lead_sales_facts enable row level security;
revoke all on table app_private.lead_sales_facts from public, anon, authenticated;

-- Recomputes the facts for the given leads with exactly the definitions the
-- workspace used inline, and deletes the row when no fact remains.
create function app_private.refresh_lead_sales_facts(target_lead_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_lead_ids is null or cardinality(target_lead_ids) = 0 then
    return;
  end if;
  with computed as (
    select
      lead_row.id as lead_id,
      lead_row.organization_id,
      exists (
        select 1 from public.test_drive_appointments drive_row
        where drive_row.organization_id = lead_row.organization_id
          and drive_row.lead_id = lead_row.id
      ) as has_test_drive,
      exists (
        select 1 from public.quotations quotation_row
        where quotation_row.organization_id = lead_row.organization_id
          and quotation_row.lead_id = lead_row.id
          and quotation_row.deleted_at is null
      ) as has_quotation,
      exists (
        select 1 from public.bookings booking_row
        where booking_row.organization_id = lead_row.organization_id
          and booking_row.lead_id = lead_row.id
          and booking_row.deleted_at is null
          and booking_row.status <> 'CANCELLED'
      ) as has_booking,
      (
        select max(handoff_history.created_at)
        from public.lead_stage_history handoff_history
        where handoff_history.organization_id = lead_row.organization_id
          and handoff_history.lead_id = lead_row.id
          and handoff_history.to_status = 'Transferred to Sales'
      ) as sales_handoff_at,
      (
        select max(activity_row.occurred_at)
        from public.activities activity_row
        where activity_row.organization_id = lead_row.organization_id
          and activity_row.lead_id = lead_row.id
          and activity_row.activity_type = 'SALES_CONTACTED'
      ) as sales_contacted_at
    from public.leads lead_row
    where lead_row.id = any(target_lead_ids)
  ), removed as (
    delete from app_private.lead_sales_facts fact_row
    using computed
    where fact_row.lead_id = computed.lead_id
      and not computed.has_test_drive
      and not computed.has_quotation
      and not computed.has_booking
      and computed.sales_handoff_at is null
      and computed.sales_contacted_at is null
  )
  insert into app_private.lead_sales_facts as fact_row (
    lead_id, organization_id, has_test_drive, has_quotation, has_booking,
    sales_handoff_at, sales_contacted_at
  )
  select
    lead_id, organization_id, has_test_drive, has_quotation, has_booking,
    sales_handoff_at, sales_contacted_at
  from computed
  where has_test_drive or has_quotation or has_booking
    or sales_handoff_at is not null or sales_contacted_at is not null
  on conflict (lead_id) do update set
    has_test_drive = excluded.has_test_drive,
    has_quotation = excluded.has_quotation,
    has_booking = excluded.has_booking,
    sales_handoff_at = excluded.sales_handoff_at,
    sales_contacted_at = excluded.sales_contacted_at,
    refreshed_at = clock_timestamp()
  where (
    fact_row.has_test_drive, fact_row.has_quotation, fact_row.has_booking,
    fact_row.sales_handoff_at, fact_row.sales_contacted_at
  ) is distinct from (
    excluded.has_test_drive, excluded.has_quotation, excluded.has_booking,
    excluded.sales_handoff_at, excluded.sales_contacted_at
  );
end;
$$;
revoke all on function app_private.refresh_lead_sales_facts(uuid[])
  from public, anon, authenticated;

-- One trigger function for every source table: refresh the old and new lead.
create function app_private.refresh_lead_sales_facts_from_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected uuid[] := array[]::uuid[];
begin
  if tg_op in ('UPDATE', 'DELETE') and old.lead_id is not null then
    affected := affected || old.lead_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.lead_id is not null
    and not (new.lead_id = any(affected))
  then
    affected := affected || new.lead_id;
  end if;
  perform app_private.refresh_lead_sales_facts(affected);
  return null;
end;
$$;
revoke all on function app_private.refresh_lead_sales_facts_from_row()
  from public, anon, authenticated;

create trigger lead_sales_facts_test_drive
  after insert or delete or update of lead_id on public.test_drive_appointments
  for each row execute function app_private.refresh_lead_sales_facts_from_row();
create trigger lead_sales_facts_quotation
  after insert or delete or update of lead_id, deleted_at on public.quotations
  for each row execute function app_private.refresh_lead_sales_facts_from_row();
create trigger lead_sales_facts_booking
  after insert or delete or update of lead_id, status, deleted_at on public.bookings
  for each row execute function app_private.refresh_lead_sales_facts_from_row();
create trigger lead_sales_facts_stage_insert
  after insert on public.lead_stage_history
  for each row when (new.to_status = 'Transferred to Sales')
  execute function app_private.refresh_lead_sales_facts_from_row();
create trigger lead_sales_facts_stage_change
  after update or delete on public.lead_stage_history
  for each row when (old.to_status = 'Transferred to Sales')
  execute function app_private.refresh_lead_sales_facts_from_row();
-- activities is the highest-volume source; the WHEN clause keeps every other
-- activity type from calling the function at all.
create trigger lead_sales_facts_activity_insert
  after insert on public.activities
  for each row when (new.activity_type = 'SALES_CONTACTED')
  execute function app_private.refresh_lead_sales_facts_from_row();
create trigger lead_sales_facts_activity_change
  after update or delete on public.activities
  for each row when (old.activity_type = 'SALES_CONTACTED')
  execute function app_private.refresh_lead_sales_facts_from_row();

-- Backfill every lead that has at least one fact, with set-based aggregates.
insert into app_private.lead_sales_facts (
  lead_id, organization_id, has_test_drive, has_quotation, has_booking,
  sales_handoff_at, sales_contacted_at
)
select
  lead_row.id,
  lead_row.organization_id,
  drive_row.lead_id is not null,
  quotation_row.lead_id is not null,
  booking_row.lead_id is not null,
  handoff_row.handoff_at,
  contact_row.contacted_at
from public.leads lead_row
left join (
  select distinct organization_id, lead_id from public.test_drive_appointments
  where lead_id is not null
) drive_row on drive_row.organization_id = lead_row.organization_id and drive_row.lead_id = lead_row.id
left join (
  select distinct organization_id, lead_id from public.quotations
  where lead_id is not null and deleted_at is null
) quotation_row on quotation_row.organization_id = lead_row.organization_id and quotation_row.lead_id = lead_row.id
left join (
  select distinct organization_id, lead_id from public.bookings
  where lead_id is not null and deleted_at is null and status <> 'CANCELLED'
) booking_row on booking_row.organization_id = lead_row.organization_id and booking_row.lead_id = lead_row.id
left join (
  select organization_id, lead_id, max(created_at) as handoff_at
  from public.lead_stage_history
  where to_status = 'Transferred to Sales'
  group by organization_id, lead_id
) handoff_row on handoff_row.organization_id = lead_row.organization_id and handoff_row.lead_id = lead_row.id
left join (
  select organization_id, lead_id, max(occurred_at) as contacted_at
  from public.activities
  where activity_type = 'SALES_CONTACTED' and lead_id is not null
  group by organization_id, lead_id
) contact_row on contact_row.organization_id = lead_row.organization_id and contact_row.lead_id = lead_row.id
where drive_row.lead_id is not null
  or quotation_row.lead_id is not null
  or booking_row.lead_id is not null
  or handoff_row.handoff_at is not null
  or contact_row.contacted_at is not null;

-- The backfill must agree with the per-lead definition for every lead.
do $verify$
declare
  mismatches bigint;
begin
  select count(*) into mismatches
  from public.leads lead_row
  left join app_private.lead_sales_facts fact_row on fact_row.lead_id = lead_row.id
  where (
    coalesce(fact_row.has_test_drive, false),
    coalesce(fact_row.has_quotation, false),
    coalesce(fact_row.has_booking, false),
    fact_row.sales_handoff_at,
    fact_row.sales_contacted_at
  ) is distinct from (
    exists (select 1 from public.test_drive_appointments d
      where d.organization_id = lead_row.organization_id and d.lead_id = lead_row.id),
    exists (select 1 from public.quotations q
      where q.organization_id = lead_row.organization_id and q.lead_id = lead_row.id
        and q.deleted_at is null),
    exists (select 1 from public.bookings b
      where b.organization_id = lead_row.organization_id and b.lead_id = lead_row.id
        and b.deleted_at is null and b.status <> 'CANCELLED'),
    (select max(h.created_at) from public.lead_stage_history h
      where h.organization_id = lead_row.organization_id and h.lead_id = lead_row.id
        and h.to_status = 'Transferred to Sales'),
    (select max(a.occurred_at) from public.activities a
      where a.organization_id = lead_row.organization_id and a.lead_id = lead_row.id
        and a.activity_type = 'SALES_CONTACTED')
  );
  if mismatches > 0 then
    raise exception 'LEAD_SALES_FACTS_BACKFILL_MISMATCH: %', mismatches;
  end if;
end;
$verify$;

commit;
