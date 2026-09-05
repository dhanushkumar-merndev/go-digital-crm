-- =============================================================================
-- SEED: ~100,000 dummy leads + customers, spread across every active
-- Telecaller/BDC and Sales Consultant in the first organization found.
--
-- NOT a migration -- do not put this in supabase/migrations/. Run it once,
-- by hand, against the dev/staging project:
--
--   npx supabase db query --linked -f scripts/sql/01-seed-org-leads.sql
--
-- or paste it into the Supabase SQL editor for project yzplfphnpoksvcetwhad.
--
-- Everything below is ONE transaction. If anything fails, Postgres rolls the
-- whole thing back automatically -- nothing partial gets committed. This was
-- authored from the migration files (no live DB access to test against), so
-- if it errors, paste me the exact message and I'll fix it; nothing will have
-- been left half-applied.
--
-- Safe to re-run: it always inserts a *new* batch of 100,000 leads (each with
-- a unique external_lead_id), so running it twice gives you 200,000 seeded
-- leads, not a conflict. Use 03-cleanup-seed-data.sql to remove everything
-- this script (and 02-seed-telecaller-focus-activity.sql) created.
--
-- What this does NOT do: it does not touch the "focus" telecaller's calls,
-- follow-ups, tasks, notes, or messages -- that is 02-seed-telecaller-focus-
-- activity.sql, run separately after this one commits, so a bug there never
-- costs you re-running this 100k-row insert.
--
-- CAUTION before running the full 100k count against a SHARED demo tenant
-- (e.g. "Go Digital Demo Motors (Test Only)"): that org is a curated fixture
-- other seed scripts (pnpm seed:demo:sales-consultant-leads, etc.) and people
-- test against at a much smaller scale (~100 leads per role). Dumping 100k
-- rows into it will slow down every org-wide dashboard/report anyone else
-- runs there. For a real 100k+ load test, do it on an isolated Supabase
-- branch instead (`supabase branches create`), or lower v_lead_count for a
-- shared tenant.
-- =============================================================================

begin;

-- Mirrors the flags the real create_lead/assign_lead/link_customer RPCs set
-- with `set local` before writing to public.leads -- see
-- app_private.validate_lead_tenant_integrity() in
-- 202608150001_foundation_security_hardening.sql. Running as the CLI/SQL
-- editor's service role, auth.role() is never 'authenticated' so this guard
-- wouldn't fire anyway, but setting it is cheap insurance.
set local app.create_lead_rpc = 'on';
set local app.assign_lead_rpc = 'on';
set local app.link_customer_rpc = 'on';

-- A 100k-row insert firing the per-row realtime broadcast trigger (see
-- 202608150013_realtime_invalidation.sql) would (a) turn a fast bulk insert
-- into ~100k individual realtime.send() calls and (b) flood any browser tab
-- currently subscribed to this org's leads/customers topics. Disabling for
-- the duration of this transaction only -- re-enabled below before COMMIT,
-- and automatically restored by ROLLBACK if anything fails.
alter table public.leads disable trigger realtime_leads_invalidate;
alter table public.customers disable trigger realtime_customers_invalidate;

do $seed$
declare
  v_org_id uuid;
  v_org_name text;
  v_lead_count int := 100000;
  v_focus_leads int := 2500;
  v_focus_user_id uuid;
  v_focus_team_id uuid;
  v_focus_branch_id uuid;
  v_focus_name text;
  v_pool_size int;
  v_inserted_leads bigint;
  v_batch_tag text := 'SEED_DEMO_100K_' || to_char(now(), 'YYYYMMDDHH24MISS');
begin
  select id, name into v_org_id, v_org_name
  from public.organizations
  where deleted_at is null
  order by created_at
  limit 1;

  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'No organization found -- create one first.';
  end if;

  -- One row per active Telecaller/BDC or Sales Consultant, tied to the
  -- specific team (and that team's branch) they actually belong to --
  -- app_private.validate_lead_tenant_integrity() requires assigned_user_id to
  -- be an active member of exactly lead.team_id, and lead.team_id to belong
  -- to lead.branch_id. A user on >1 team only gets their first team here so
  -- the round-robin below stays 1 row per person.
  create temporary table seed_pool on commit drop as
  select
    row_number() over (order by dedup_member.user_id) as pool_index,
    dedup_member.user_id,
    dedup_member.team_id,
    team_row.branch_id,
    dedup_member.member_type
  from (
    select distinct on (member_row.user_id)
      member_row.user_id, member_row.team_id, member_row.member_type
    from public.team_members member_row
    join public.teams team_row
      on team_row.id = member_row.team_id
     and team_row.organization_id = member_row.organization_id
    join public.profiles profile_row
      on profile_row.id = member_row.user_id
     and profile_row.organization_id = member_row.organization_id
    where member_row.organization_id = v_org_id
      and member_row.active
      and team_row.active
      and profile_row.active
      and member_row.member_type in ('TELECALLER_BDC', 'SALES_CONSULTANT')
    order by member_row.user_id, member_row.team_id
  ) dedup_member
  join public.teams team_row on team_row.id = dedup_member.team_id;

  select count(*) into v_pool_size from seed_pool;
  if v_pool_size = 0 then
    raise exception using errcode = 'P0001', message =
      'No active Telecaller/BDC or Sales Consultant team members in this organization -- add at least one (Client Admin > Teams) before seeding.';
  end if;

  select user_id, team_id, branch_id, full_name
  into v_focus_user_id, v_focus_team_id, v_focus_branch_id, v_focus_name
  from seed_pool
  join public.profiles on profiles.id = seed_pool.user_id
  where seed_pool.member_type = 'TELECALLER_BDC'
  order by seed_pool.pool_index
  limit 1;

  if v_focus_user_id is null then
    v_focus_leads := 0;
    raise notice 'No Telecaller/BDC found in this organization -- skipping the focused slice. Run 02-seed-telecaller-focus-activity.sql only after adding one.';
  end if;

  raise notice 'Seeding into organization % (%). Pool size: %. Focus telecaller: % (%). Batch tag: %',
    v_org_id, v_org_name, v_pool_size, coalesce(v_focus_name, '(none)'), v_focus_user_id, v_batch_tag;

  -- One statement: create the customers, then the leads that reference them,
  -- deriving the lead's sequence number back out of the customer's own
  -- full_name (not out of RETURNING's row order, which Postgres does not
  -- contractually guarantee matches the source SELECT's order).
  with numbers as (
    select generate_series(1, v_lead_count) as i
  ), new_customers as (
    insert into public.customers (
      organization_id, full_name, primary_phone, normalized_phone, primary_email, created_by
    )
    select
      v_org_id,
      'Seed Customer ' || i::text,
      '9' || lpad((100000000 + i)::text, 9, '0'),
      '9' || lpad((100000000 + i)::text, 9, '0'),
      'seed.customer.' || i::text || '@example.test',
      coalesce(v_focus_user_id, (select user_id from seed_pool where pool_index = 1))
    from numbers
    returning id, full_name
  ), tagged_customers as (
    select
      id as customer_id,
      (split_part(full_name, ' ', 3))::int as i
    from new_customers
  ), assignment as (
    select
      tc.i,
      tc.customer_id,
      case when v_focus_leads > 0 and tc.i <= v_focus_leads
        then v_focus_user_id
        else pool.user_id
      end as assigned_user_id,
      case when v_focus_leads > 0 and tc.i <= v_focus_leads
        then v_focus_team_id
        else pool.team_id
      end as team_id,
      case when v_focus_leads > 0 and tc.i <= v_focus_leads
        then v_focus_branch_id
        else pool.branch_id
      end as branch_id,
      case when v_focus_leads > 0 and tc.i <= v_focus_leads
        then v_batch_tag || '_FOCUS'
        else v_batch_tag
      end as campaign_tag
    from tagged_customers tc
    left join seed_pool pool
      on pool.pool_index = 1 + mod(tc.i - greatest(v_focus_leads, 0) - 1, v_pool_size)
     and (v_focus_leads = 0 or tc.i > v_focus_leads)
  ), phone_digits as (
    select
      assignment.*,
      '9' || lpad((100000000 + assignment.i)::text, 9, '0') as phone_value
    from assignment
  )
  insert into public.leads (
    organization_id, branch_id, team_id, customer_id,
    source, source_detail, campaign, external_lead_id,
    customer_name, phone, normalized_phone, email, interested_model,
    lifecycle_status, temperature, assigned_user_id,
    first_contacted_at, sla_due_at, created_at, updated_at
  )
  select
    v_org_id,
    pd.branch_id,
    pd.team_id,
    pd.customer_id,
    (array[
      'Facebook','Instagram','Google Ads','Website','WhatsApp Business',
      'CarWale','CarDekho','Justdial','IndiaMART','Manual','Other'
    ])[1 + ((pd.i * 31 + 7) % 11)],
    'Seeded demo data',
    pd.campaign_tag,
    'SEED-100K-' || pd.i::text,
    'Seed Customer ' || pd.i::text,
    pd.phone_value,
    pd.phone_value,
    'seed.customer.' || pd.i::text || '@example.test',
    (array[
      'Swift','Baleno','Fronx','Grand Vitara','Ertiga','WagonR',
      'Nexon','Punch','Tiago','Harrier','Creta','Venue','i20','Verna',
      'XUV700','Scorpio-N','Seltos','Sonet','Innova Crysta','Fortuner'
    ])[1 + ((pd.i * 17 + 3) % 20)],
    (array['New','Contacted','Qualified','Appointment Scheduled','Transferred to Sales','Lost'])[
      1 + (case (pd.i % 20)
        when 0 then 0 when 1 then 0 when 2 then 0 when 3 then 0 when 4 then 0 when 5 then 0 -- 30% New
        when 6 then 1 when 7 then 1 when 8 then 1 when 9 then 1 when 10 then 1 when 11 then 1 -- 30% Contacted
        when 12 then 2 when 13 then 2 when 14 then 2 -- 15% Qualified
        when 15 then 3 when 16 then 3 -- 10% Appointment Scheduled
        when 17 then 4 -- 5% Transferred to Sales
        else 5 end) -- 10% Lost
    ]::public.lead_lifecycle,
    (array['COLD','WARM','HOT'])[1 + (pd.i % 3)]::public.lead_temperature,
    pd.assigned_user_id,
    case when pd.i % 20 in (0,1,2,3,4,5) then null -- New leads: not yet contacted
      else now() - (random() * 25 + 1) * interval '1 day' end,
    (now() - (random() * 30) * interval '1 day') + interval '24 hours',
    now() - (random() * 30) * interval '1 day',
    now() - (random() * 30) * interval '1 day'
  from phone_digits pd;

  get diagnostics v_inserted_leads = row_count;
  raise notice 'Inserted % leads (and % customers). Focus telecaller % got % of them, tagged %.',
    v_inserted_leads, v_inserted_leads, coalesce(v_focus_name, '(none)'), v_focus_leads, v_batch_tag || '_FOCUS';
end;
$seed$;

alter table public.leads enable trigger realtime_leads_invalidate;
alter table public.customers enable trigger realtime_customers_invalidate;

commit;
