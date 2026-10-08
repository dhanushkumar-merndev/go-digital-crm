-- =============================================================================
-- Demo volume and edge cases for the five demo dealerships.
--
-- Run through scripts/seed-demo-organizations.mjs, after the organizations,
-- their role accounts and their extra showrooms exist. NOT a migration.
--
--   npx supabase db query --linked -f scripts/sql/10-seed-demo-volume.sql
--
-- One transaction. Organizations that already carry seeded volume
-- (external_lead_id 'seed-vol-%') are skipped, so a re-run is a no-op.
--
-- Triggers are off for the bulk insert (session_replication_role = replica):
-- per-row realtime broadcasts and cache bumps would turn this into thousands
-- of round trips. Everything those triggers derive is rebuilt at the end:
-- app_private.lead_sales_facts and the dashboard cache versions.
--
-- Shape per organization:
--   Demo Motors     6,000 leads, 180 days, 4 showrooms (one idle), targets
--   Sapphire        3,000 leads, 180 days, 2 showrooms, Exchange module off
--   Pioneer           300 leads,  45 days, 1 showroom, no targets, no credits,
--                   Finance/Exchange/Marketing/AI modules off
--   Royal Kia       1,500 leads, 365 days, then SUSPENDED (data preserved)
--   Metro               0 leads, owner only, onboarding UNDER_REVIEW
--
-- Edge cases covered across the leads: every source and lifecycle stage,
-- unrated and DORMANT temperature, New Today / Pending / SLA risk work states,
-- unassigned leads, leads with no customer yet, repeat customers with several
-- leads and bookings, two customers sharing one phone, a lead whose phone
-- matches an existing customer but is not linked, Tamil/Hindi/very long/single
-- word names, missing email and model, soft-deleted leads, lost with and
-- without a reason, overdue/today/future follow-ups, unanswered-only call
-- history, zero-second and hour-long calls, cancelled/no-show appointments,
-- active and cancelled test drives, every quotation and booking status,
-- a one-rupee booking, cancelled bookings, rejected finance, stock older than
-- 90 days, in-transit/on-hold/soft-deleted stock, targets beaten and missed.
-- =============================================================================

begin;
set local statement_timeout = '20min';
set local session_replication_role = replica;
select setseed(0.2026);

-- --- Organizations to fill ---------------------------------------------------

create temp table seed_org on commit drop as
select
  organization_row.id as org_id,
  config.slug,
  config.org_index,
  config.lead_count,
  config.history_days,
  config.oem,
  config.code_letter
from public.organizations organization_row
join (values
  ('go-digital-demo-test', 1, 6000, 180, 'Tata', 'A'),
  ('sapphire-hyundai-test', 2, 3000, 180, 'Hyundai', 'B'),
  ('pioneer-tata-test', 3, 300, 45, 'Tata', 'C'),
  ('royal-kia-test', 4, 1500, 365, 'Kia', 'D')
) as config(slug, org_index, lead_count, history_days, oem, code_letter)
  on config.slug = organization_row.slug
where not exists (
  select 1 from public.leads lead_row
  where lead_row.organization_id = organization_row.id
    and lead_row.external_lead_id like 'seed-vol-%'
);

-- One user per role key and organization, for case owners and approvers.
create temp table seed_role_user on commit drop as
select distinct on (assignment.organization_id, role_row.role_key)
  assignment.organization_id as org_id,
  role_row.role_key,
  assignment.user_id
from public.user_role_assignments assignment
join public.roles role_row on role_row.id = assignment.role_id
join seed_org on seed_org.org_id = assignment.organization_id
where assignment.active
order by assignment.organization_id, role_row.role_key, assignment.created_at;

-- --- Vehicle catalog ---------------------------------------------------------

create temp table seed_catalog (
  oem text, model text, variant text, price numeric, fuel text, transmission text
) on commit drop;
insert into seed_catalog values
  ('Tata', 'Nexon', 'Smart+ Petrol MT', 899000, 'Petrol', 'Manual'),
  ('Tata', 'Nexon', 'Fearless+ Diesel AMT', 1459000, 'Diesel', 'Automatic'),
  ('Tata', 'Nexon EV', 'Empowered+ 45', 1749000, 'Electric', 'Automatic'),
  ('Tata', 'Harrier', 'Adventure+ AT', 2299000, 'Diesel', 'Automatic'),
  ('Tata', 'Safari', 'Accomplished+ 7S', 2599000, 'Diesel', 'Automatic'),
  ('Tata', 'Punch', 'Adventure Rhythm', 749000, 'Petrol', 'Manual'),
  ('Tata', 'Punch', 'iCNG Accomplished', 899000, 'CNG', 'Manual'),
  ('Tata', 'Tiago', 'XZ+ AMT', 749000, 'Petrol', 'Automatic'),
  ('Tata', 'Curvv', 'Creative S DCA', 1799000, 'Petrol', 'Automatic'),
  ('Hyundai', 'Creta', 'SX(O) Diesel AT', 2015000, 'Diesel', 'Automatic'),
  ('Hyundai', 'Creta', 'E Petrol MT', 1111000, 'Petrol', 'Manual'),
  ('Hyundai', 'Venue', 'S(O) Turbo DCT', 1265000, 'Petrol', 'Automatic'),
  ('Hyundai', 'Verna', 'SX(O) Turbo DCT', 1748000, 'Petrol', 'Automatic'),
  ('Hyundai', 'i20', 'Asta (O) IVT', 1113000, 'Petrol', 'Automatic'),
  ('Hyundai', 'Exter', 'SX CNG Duo', 900000, 'CNG', 'Manual'),
  ('Hyundai', 'Alcazar', 'Signature 7S Diesel', 2155000, 'Diesel', 'Automatic'),
  ('Hyundai', 'Ioniq 5', 'Long Range RWD', 4605000, 'Electric', 'Automatic'),
  ('Kia', 'Seltos', 'HTX+ Turbo DCT', 1905000, 'Petrol', 'Automatic'),
  ('Kia', 'Seltos', 'HTE Petrol MT', 1099000, 'Petrol', 'Manual'),
  ('Kia', 'Sonet', 'GTX+ Diesel AT', 1569000, 'Diesel', 'Automatic'),
  ('Kia', 'Carens', 'Luxury Plus 6S', 1999000, 'Diesel', 'Automatic'),
  ('Kia', 'EV6', 'GT Line AWD', 6595000, 'Electric', 'Automatic');

insert into public.vehicle_brands (organization_id, name, active)
select distinct seed_org.org_id, seed_org.oem, true
from seed_org
where not exists (
  select 1 from public.vehicle_brands brand_row
  where brand_row.organization_id = seed_org.org_id and brand_row.name = seed_org.oem
);

insert into public.vehicle_models (organization_id, brand_id, name, active)
select distinct seed_org.org_id, brand_row.id, catalog.model, true
from seed_org
join seed_catalog catalog on catalog.oem = seed_org.oem
join public.vehicle_brands brand_row
  on brand_row.organization_id = seed_org.org_id and brand_row.name = seed_org.oem
where not exists (
  select 1 from public.vehicle_models model_row
  where model_row.organization_id = seed_org.org_id
    and model_row.brand_id = brand_row.id
    and model_row.name = catalog.model
);

insert into public.vehicle_variants (
  organization_id, model_id, name, specifications, active,
  ex_showroom_price, insurance_amount, registration_amount
)
select
  seed_org.org_id, model_row.id, catalog.variant,
  jsonb_build_object(
    'fuel', catalog.fuel,
    'transmission', catalog.transmission,
    'battery_capacity', case when catalog.fuel = 'Electric' then '45 kWh' else 'NOT_AVAILABLE' end,
    'fast_charging', case when catalog.fuel = 'Electric' then '10-80% in 40 min' else 'NOT_AVAILABLE' end,
    'power', (80 + (catalog.price / 30000)::int)::text || ' kW',
    'range', case when catalog.fuel = 'Electric' then '480 km (MIDC)' else 'NOT_AVAILABLE' end,
    'torque', (170 + (catalog.price / 15000)::int)::text || ' Nm',
    'warranty', '3 years / 1,00,000 km'
  ),
  true,
  catalog.price,
  round(catalog.price * 0.035),
  round(catalog.price * 0.09)
from seed_org
join seed_catalog catalog on catalog.oem = seed_org.oem
join public.vehicle_brands brand_row
  on brand_row.organization_id = seed_org.org_id and brand_row.name = seed_org.oem
join public.vehicle_models model_row
  on model_row.organization_id = seed_org.org_id
 and model_row.brand_id = brand_row.id
 and model_row.name = catalog.model
where not exists (
  select 1 from public.vehicle_variants variant_row
  where variant_row.organization_id = seed_org.org_id
    and variant_row.model_id = model_row.id
    and variant_row.name = catalog.variant
);

insert into public.vehicle_colours (organization_id, name, active)
select seed_org.org_id, colour, true
from seed_org
cross join unnest(array[
  'Pristine White', 'Daytona Grey', 'Oberon Black', 'Flame Red', 'Ocean Blue',
  'Calgary White', 'Pure Grey', 'Imperial Blue'
]) as colour
on conflict (organization_id, name) do nothing;

create temp table seed_variant on commit drop as
select
  seed_org.org_id,
  variant_row.id as variant_id,
  model_row.id as model_id,
  model_row.name as model_name,
  variant_row.name as variant_name,
  catalog.price,
  row_number() over (partition by seed_org.org_id order by model_row.name, variant_row.name) as variant_index,
  count(*) over (partition by seed_org.org_id) as variant_count
from seed_org
join seed_catalog catalog on catalog.oem = seed_org.oem
join public.vehicle_models model_row
  on model_row.organization_id = seed_org.org_id and model_row.name = catalog.model
join public.vehicle_variants variant_row
  on variant_row.organization_id = seed_org.org_id
 and variant_row.model_id = model_row.id
 and variant_row.name = catalog.variant;
create index on seed_variant (org_id, variant_index);
analyze seed_variant;

-- --- Teams and showrooms -----------------------------------------------------

-- Every staffed team has telecallers and consultants. Teams in the
-- organization's first (flagship) showroom get three times the lead share.
create temp table seed_team on commit drop as
select
  team_row.organization_id as org_id,
  team_row.id as team_id,
  team_row.branch_id,
  branch_row.code as branch_code,
  array_agg(member_row.user_id order by member_row.user_id)
    filter (where member_row.member_type = 'TELECALLER_BDC') as telecallers,
  array_agg(member_row.user_id order by member_row.user_id)
    filter (where member_row.member_type = 'SALES_CONSULTANT') as consultants,
  case when branch_row.created_at = min(branch_row.created_at) over (partition by team_row.organization_id)
    then 3 else 1 end as weight
from public.teams team_row
join seed_org on seed_org.org_id = team_row.organization_id
join public.branches branch_row on branch_row.id = team_row.branch_id
join public.team_members member_row
  on member_row.team_id = team_row.id and member_row.active
group by team_row.organization_id, team_row.id, team_row.branch_id, branch_row.code, branch_row.created_at
having count(*) filter (where member_row.member_type = 'TELECALLER_BDC') > 0
   and count(*) filter (where member_row.member_type = 'SALES_CONSULTANT') > 0;

create temp table seed_team_slot on commit drop as
select
  seed_team.*,
  row_number() over (partition by seed_team.org_id order by seed_team.team_id, slot) as slot_index,
  count(*) over (partition by seed_team.org_id) as slot_count
from seed_team
cross join lateral generate_series(1, seed_team.weight) as slot;
create index on seed_team_slot (org_id, slot_index);
analyze seed_team_slot;

create temp table seed_branch on commit drop as
select
  branch_row.organization_id as org_id,
  branch_row.id as branch_id,
  branch_row.code,
  row_number() over (partition by branch_row.organization_id order by branch_row.created_at) as branch_index,
  count(*) over (partition by branch_row.organization_id) as branch_count
from public.branches branch_row
join seed_org on seed_org.org_id = branch_row.organization_id
where branch_row.deleted_at is null;

-- --- Leads -------------------------------------------------------------------

create temp table seed_lead on commit drop as
with base as (
  select
    seed_org.*,
    series.i,
    random() as r_age, random() as r_stage, random() as r_temp, random() as r_src,
    random() as r_assign, random() as r_contact, random() as r_follow, random() as r_sales,
    random() as r_misc, random() as r_model, random() as r_team
  from seed_org
  cross join lateral generate_series(1, seed_org.lead_count) as series(i)
), timed as (
  select
    base.*,
    case
      when base.i % 50 = 0 then now() - (base.r_age * 20) * interval '1 hour'
      when base.i % 50 = 1 then now() - (30 + base.r_age * 40) * interval '1 hour'
      else now() - (power(base.r_age, 1.5) * base.history_days) * interval '1 day'
           - (base.r_misc * 8) * interval '1 hour'
    end as created_at
  from base
), staged as (
  select
    timed.*,
    case
      when timed.created_at > now() - interval '1 day'
        then case when timed.r_stage < 0.7 then 'New' else 'Contacted' end
      when timed.r_stage < 0.12 then 'New'
      when timed.r_stage < 0.30 then 'Contacted'
      when timed.r_stage < 0.38 then 'Appointment Scheduled'
      when timed.r_stage < 0.78 then 'Transferred to Sales'
      else 'Lost'
    end as lifecycle,
    slot.team_id,
    slot.branch_id,
    slot.branch_code,
    slot.telecallers[1 + (timed.i % cardinality(slot.telecallers))] as telecaller_id,
    slot.consultants[1 + ((timed.i / 3) % cardinality(slot.consultants))] as consultant_id
  from timed
  join seed_team_slot slot
    on slot.org_id = timed.org_id
   and slot.slot_index = 1 + floor(timed.r_team * slot.slot_count)::int
), keyed as (
  select
    staged.*,
    -- Repeat customer: a later enquiry from the same person as lead i-7.
    case when staged.i % 13 = 0 and staged.i > 20 then staged.i - 7 else staged.i end as customer_key,
    -- Different person on the same phone as lead i-1 (family number).
    case when staged.i % 97 = 0 and staged.i > 1 then staged.i - 1
         when staged.i % 13 = 0 and staged.i > 20 then staged.i - 7
         else staged.i end as phone_key
  from staged
)
select
  gen_random_uuid() as lead_id,
  keyed.*,
  (array['9', '8', '7', '6'])[1 + keyed.phone_key % 4]
    || lpad((keyed.org_index * 10000000 + keyed.phone_key * 37 % 9999991)::text, 9, '0') as phone10,
  case
    when keyed.customer_key % 211 = 0 then 'கார்த்திக் ராஜா'
    when keyed.customer_key % 223 = 0 then 'राहुल शर्मा'
    when keyed.customer_key % 229 = 0
      then 'Venkata Satya Sai Lakshmi Narasimha Subrahmanya Prasad Rao Chowdary Gogineni Bhavanarayana'
    when keyed.customer_key % 233 = 0 then 'Ravi'
    else (array['Ananya', 'Ravi', 'Mohammed', 'Priya', 'Karthik', 'Sneha', 'Arjun', 'Fatima',
                'Gurpreet', 'Joseph', 'Lakshmi', 'Venkatesh', 'Aditya', 'Meera', 'Rahul', 'Divya',
                'Imran', 'Sanjay', 'Pooja', 'Naveen', 'Harini', 'Deepak', 'Sunita', 'Vikram',
                'Neha', 'Abdul', 'Shalini', 'Manoj', 'Kavya', 'Suresh', 'Anil', 'Rekha'])
           [1 + keyed.customer_key % 32]
      || ' ' ||
         (array['Sharma', 'Reddy', 'Iyer', 'Khan', 'Singh', 'Nair', 'Patel', 'Gowda', 'D''Souza',
                'Fernandes', 'Menon', 'Rao', 'Das', 'Chatterjee', 'Pillai', 'Mehta', 'Kulkarni',
                'Joshi', 'Bhat', 'Agarwal', 'Shetty', 'Hegde', 'Verma', 'Thomas', 'Banerjee'])
           [1 + (keyed.customer_key * 7) % 25]
  end
  || case when keyed.phone_key <> keyed.customer_key and keyed.i % 97 = 0 then ' (spouse)' else '' end
    as customer_name,
  case
    when keyed.r_src < 0.22 then 'Facebook'
    when keyed.r_src < 0.32 then 'Instagram'
    when keyed.r_src < 0.46 then 'Google Ads'
    when keyed.r_src < 0.58 then 'Website'
    when keyed.r_src < 0.66 then 'WhatsApp Business'
    when keyed.r_src < 0.75 then 'CarWale'
    when keyed.r_src < 0.83 then 'CarDekho'
    when keyed.r_src < 0.87 then 'Justdial'
    when keyed.r_src < 0.89 then 'IndiaMART'
    when keyed.r_src < 0.98 then 'Manual'
    else 'Other'
  end as source,
  case
    when keyed.r_temp < 0.12 then null
    when keyed.r_temp < 0.17 then 'DORMANT'
    when keyed.r_temp < 0.47 then 'COLD'
    when keyed.r_temp < 0.77 then 'WARM'
    else 'HOT'
  end as temperature,
  (select variant.model_name from seed_variant variant
   where variant.org_id = keyed.org_id
     and variant.variant_index = 1 + floor(keyed.r_model * variant.variant_count)::int) as model_name
from keyed;
create index on seed_lead (org_id, customer_key);
analyze seed_lead;

alter table seed_lead add column assigned_user_id uuid;
alter table seed_lead add column first_contacted_at timestamptz;
alter table seed_lead add column next_followup_at timestamptz;
alter table seed_lead add column sales_stage int;
alter table seed_lead add column has_customer boolean;

update seed_lead set
  assigned_user_id = case
    when lifecycle = 'New' and r_assign < 0.15 then null
    when lifecycle = 'Transferred to Sales' then consultant_id
    when lifecycle = 'Lost' and r_assign < 0.4 then consultant_id
    else telecaller_id
  end,
  first_contacted_at = case
    when lifecycle = 'New' then null
    else least(created_at + (power(r_contact, 2.5) * 72) * interval '1 hour' + interval '3 minutes',
               now() - interval '5 minutes')
  end,
  -- 0 just transferred, 1 test drive, 2 quotation, 3 booking.
  sales_stage = case
    when lifecycle <> 'Transferred to Sales' then null
    when r_sales < 0.30 then 0
    when r_sales < 0.55 then 1
    when r_sales < 0.75 then 2
    else 3
  end,
  has_customer = lifecycle <> 'New' or r_misc < 0.4 or customer_key <> i,
  model_name = case when r_misc > 0.92 then null else model_name end;

update seed_lead set next_followup_at = case
  when lifecycle in ('Contacted', 'Appointment Scheduled', 'Transferred to Sales')
   and coalesce(sales_stage, 0) < 3 and r_follow < 0.55
    then date_trunc('hour', now() + ((r_follow - 0.2) * 12) * interval '1 day') + interval '30 minutes'
  else null
end;

analyze seed_lead;

-- Customers: one per distinct customer key with a linked lead.
create temp table seed_customer on commit drop as
select distinct on (lead_row.org_id, lead_row.customer_key)
  gen_random_uuid() as customer_id,
  lead_row.org_id,
  lead_row.customer_key,
  lead_row.customer_name,
  lead_row.phone10,
  lead_row.created_at,
  lead_row.telecaller_id
from seed_lead lead_row
where lead_row.has_customer
order by lead_row.org_id, lead_row.customer_key, lead_row.i;
create unique index on seed_customer (org_id, customer_key);
analyze seed_customer;

insert into public.customers (
  id, organization_id, full_name, primary_phone, normalized_phone, primary_email,
  created_by, created_at, updated_at
)
select
  customer_row.customer_id,
  customer_row.org_id,
  customer_row.customer_name,
  '+91 ' || customer_row.phone10,
  '91' || customer_row.phone10,
  case when customer_row.customer_key % 5 in (1, 2, 3)
    then lower(regexp_replace(split_part(customer_row.customer_name, ' ', 1), '[^A-Za-z]', '', 'g'))
         || '.' || customer_row.customer_key || '@example.com'
  end,
  customer_row.telecaller_id,
  customer_row.created_at,
  customer_row.created_at
from seed_customer customer_row;

insert into public.customer_contacts (organization_id, customer_id, type, value, normalized_value, is_primary)
select org_id, customer_id, 'PHONE', '+91 ' || phone10, '91' || phone10, true from seed_customer;

-- Previous vehicles for a quarter of customers (trade-in and repeat buyers).
insert into public.customer_vehicles (organization_id, customer_id, registration, normalized_registration, brand, model, variant, model_year)
select
  org_id, customer_id,
  'KA ' || lpad((customer_key % 60 + 1)::text, 2, '0') || ' MK ' || lpad((customer_key * 31 % 9999 + 1)::text, 4, '0'),
  'KA' || lpad((customer_key % 60 + 1)::text, 2, '0') || 'MK' || lpad((customer_key * 31 % 9999 + 1)::text, 4, '0'),
  (array['Maruti Suzuki', 'Hyundai', 'Honda', 'Toyota', 'Mahindra'])[1 + customer_key % 5],
  (array['Swift', 'i20', 'City', 'Innova', 'XUV300'])[1 + customer_key % 5],
  (array['VXI', 'Asta', 'ZX', 'GX', 'W8'])[1 + customer_key % 5],
  2012 + customer_key % 12
from seed_customer
where customer_key % 4 = 0;

insert into public.leads (
  id, organization_id, branch_id, team_id, customer_id, source, source_detail, campaign,
  external_lead_id, customer_name, phone, normalized_phone, email, interested_model,
  lifecycle_status, temperature, assigned_user_id, first_contacted_at, next_followup_at,
  sla_due_at, lost_reason, deleted_at, deletion_reason, created_at, updated_at
)
select
  lead_row.lead_id,
  lead_row.org_id,
  lead_row.branch_id,
  lead_row.team_id,
  case when lead_row.has_customer then customer_row.customer_id end,
  lead_row.source,
  case lead_row.source
    when 'CarWale' then 'CarWale new car enquiry'
    when 'CarDekho' then 'CarDekho dealer lead'
    when 'Manual' then (array['Walk-in', 'Phone enquiry', 'Referral'])[1 + lead_row.i % 3]
    when 'Other' then 'Unmapped partner feed'
    else null
  end,
  case lead_row.source
    when 'Facebook' then (array['Diwali Mega Offer', 'EV Launch Week', 'Year-End Clearance'])[1 + lead_row.i % 3]
    when 'Instagram' then (array['Reels - SUV Showcase', 'Diwali Mega Offer'])[1 + lead_row.i % 2]
    when 'Google Ads' then (array['Search - Brand', 'Search - Competitor', 'PMax - SUVs'])[1 + lead_row.i % 3]
    else null
  end,
  'seed-vol-' || lead_row.slug || '-' || lead_row.i,
  lead_row.customer_name,
  '+91 ' || lead_row.phone10,
  '+91' || lead_row.phone10,
  case
    when lead_row.i % 101 = 0 then upper(split_part(lead_row.customer_name, ' ', 1)) || '.K' || lead_row.i || '@EXAMPLE.COM'
    when lead_row.customer_key % 5 in (1, 2, 3)
      then lower(regexp_replace(split_part(lead_row.customer_name, ' ', 1), '[^A-Za-z]', '', 'g'))
           || '.' || lead_row.customer_key || '@example.com'
  end,
  lead_row.model_name,
  lead_row.lifecycle::public.lead_lifecycle,
  lead_row.temperature::public.lead_temperature,
  lead_row.assigned_user_id,
  lead_row.first_contacted_at,
  lead_row.next_followup_at,
  lead_row.created_at + interval '2 hours',
  case when lead_row.lifecycle = 'Lost' and lead_row.r_misc > 0.06 then
    (array['Price', 'Chose Competitor', 'Budget', 'Feature Missing', 'Finance Issue',
           'Delivery Delay', 'Stock Unavailable', 'No Response', 'Service Concern', 'Other'])
      [1 + floor(power(lead_row.r_misc, 1.4) * 10)::int % 10]
  end,
  case when lead_row.i % 199 = 0 then now() - interval '1 day' end,
  case when lead_row.i % 199 = 0 then 'Duplicate enquiry from the same campaign' end,
  lead_row.created_at,
  coalesce(lead_row.first_contacted_at, lead_row.created_at)
from seed_lead lead_row
left join seed_customer customer_row
  on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key;

-- --- Assignment and history --------------------------------------------------

insert into public.lead_assignments (organization_id, lead_id, branch_id, team_id, assigned_user_id, assignment_type, method, assigned_by, reason, active, created_at)
select org_id, lead_id, branch_id, team_id, telecaller_id, 'FRESH',
  (case when i % 5 = 0 then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end)::public.assignment_mode,
  null, 'Fresh lead routing', lifecycle not in ('Transferred to Sales') and assigned_user_id = telecaller_id,
  created_at + interval '1 minute'
from seed_lead where assigned_user_id is not null;

insert into public.lead_assignments (organization_id, lead_id, branch_id, team_id, assigned_user_id, assignment_type, method, assigned_by, reason, active, created_at)
select org_id, lead_id, branch_id, team_id, consultant_id, 'QUALIFIED',
  (case when i % 3 = 0 then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end)::public.assignment_mode,
  telecaller_id, 'Qualified and transferred to sales', true,
  first_contacted_at + interval '2 hours'
from seed_lead where assigned_user_id = consultant_id;

insert into public.lead_assignment_history (organization_id, lead_id, branch_id, team_id, previous_owner_id, new_owner_id, assigned_by, method, reason, created_at)
select org_id, lead_id, branch_id, team_id, null::uuid, telecaller_id, null::uuid, 'ROUND_ROBIN'::public.assignment_mode, 'Fresh lead routing', created_at + interval '1 minute'
from seed_lead where assigned_user_id is not null
union all
select org_id, lead_id, branch_id, team_id, telecaller_id, consultant_id, telecaller_id,
  (case when i % 3 = 0 then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end)::public.assignment_mode,
  'Qualified and transferred to sales', first_contacted_at + interval '2 hours'
from seed_lead where assigned_user_id = consultant_id;

insert into public.lead_stage_history (organization_id, lead_id, from_status, to_status, changed_by, reason, created_at)
select org_id, lead_id, 'New'::public.lead_lifecycle, 'Contacted'::public.lead_lifecycle, telecaller_id, null::text, first_contacted_at
from seed_lead where lifecycle <> 'New'
union all
select org_id, lead_id, 'Contacted', 'Appointment Scheduled', telecaller_id, null, first_contacted_at + interval '1 hour'
from seed_lead where lifecycle = 'Appointment Scheduled'
union all
select org_id, lead_id, 'Contacted', 'Qualified', telecaller_id, null, first_contacted_at + interval '2 hours'
from seed_lead where lifecycle = 'Transferred to Sales'
union all
select org_id, lead_id, 'Qualified', 'Transferred to Sales', telecaller_id, 'Qualified and transferred to sales',
  first_contacted_at + interval '2 hours'
from seed_lead where lifecycle = 'Transferred to Sales'
union all
select org_id, lead_id, 'Contacted', 'Lost', assigned_user_id, 'Marked lost', first_contacted_at + (r_follow * 10) * interval '1 day'
from seed_lead where lifecycle = 'Lost';

insert into public.lead_temperature_history (organization_id, lead_id, from_temperature, to_temperature, changed_by, created_at)
select org_id, lead_id, null, temperature::public.lead_temperature, coalesce(assigned_user_id, telecaller_id),
  coalesce(first_contacted_at, created_at)
from seed_lead where temperature is not null;

insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at)
select lead_row.org_id, customer_row.customer_id, lead_row.lead_id, 'LEAD_RECEIVED', null,
  jsonb_build_object('source', lead_row.source), lead_row.created_at
from seed_lead lead_row
left join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key and lead_row.has_customer
union all
select lead_row.org_id, customer_row.customer_id, lead_row.lead_id, 'FIRST_CONTACTED', lead_row.telecaller_id, '{}'::jsonb, lead_row.first_contacted_at
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
where lead_row.first_contacted_at is not null
union all
select lead_row.org_id, customer_row.customer_id, lead_row.lead_id, 'LEAD_TRANSFERRED_TO_SALES', lead_row.telecaller_id,
  jsonb_build_object('consultant_id', lead_row.consultant_id), lead_row.first_contacted_at + interval '2 hours'
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
where lead_row.lifecycle = 'Transferred to Sales'
union all
select lead_row.org_id, customer_row.customer_id, lead_row.lead_id, 'SALES_CONTACTED', lead_row.consultant_id, '{}'::jsonb,
  least(lead_row.first_contacted_at + (4 + lead_row.r_contact * 30) * interval '1 hour', now())
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
where lead_row.lifecycle = 'Transferred to Sales' and lead_row.r_contact < 0.85;

-- --- Calls -------------------------------------------------------------------

insert into public.calls (
  organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
  direction, call_source, provider_call_id, call_mode, started_at, answered_at, ended_at,
  duration_seconds, outcome, status, notes, finalized_at, created_at, updated_at
)
select
  call_row.org_id, call_row.branch_id, call_row.team_id, call_row.lead_id, call_row.customer_id,
  call_row.caller_id,
  case when call_row.r < 0.15 then 'INBOUND' else 'OUTBOUND' end,
  case when call_row.r2 < 0.6 then 'PERSONAL_MANUAL' else 'PROVIDER' end,
  case when call_row.r2 >= 0.6 then 'seed-call-' || call_row.lead_id || '-' || call_row.k end,
  'HUMAN',
  call_row.started_at,
  case when call_row.outcome = 'CONNECTED' then call_row.started_at + interval '8 seconds' end,
  call_row.started_at + make_interval(secs => call_row.duration + 8),
  call_row.duration,
  call_row.outcome,
  'COMPLETED',
  case when call_row.outcome = 'CONNECTED' and call_row.r < 0.4
    then (array['Interested in weekend test drive', 'Asked for on-road price', 'Wants EMI options',
                'Comparing with a competitor', 'Will visit showroom with family'])[1 + call_row.k % 5]
  end,
  call_row.started_at + make_interval(secs => call_row.duration + 30),
  call_row.started_at,
  call_row.started_at
from (
  select
    lead_row.org_id, lead_row.branch_id, lead_row.team_id, lead_row.lead_id,
    customer_row.customer_id, attempt.k, random() as r, random() as r2,
    case when attempt.k <= 2 or lead_row.lifecycle <> 'Transferred to Sales'
      then lead_row.telecaller_id else lead_row.consultant_id end as caller_id,
    case
      when lead_row.first_contacted_at is null
        then lead_row.created_at + (attempt.k * 3) * interval '1 hour'
      when attempt.k = 1 then lead_row.first_contacted_at
      else least(lead_row.first_contacted_at + (attempt.k * (1 + random() * 3)) * interval '1 day',
                 now() - interval '10 minutes')
    end as started_at,
    case
      when lead_row.first_contacted_at is null then
        (array['NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'NO_ANSWER', 'FAILED'])[1 + (lead_row.i + attempt.k) % 5]
      when attempt.k = 1 then 'CONNECTED'
      else (array['CONNECTED', 'CONNECTED', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'CALLBACK_REQUIRED',
                  'SWITCHED_OFF', 'CONNECTED', 'WRONG_NUMBER', 'MISSED'])[1 + (lead_row.i * 3 + attempt.k) % 10]
    end as outcome,
    0 as duration_placeholder
  from seed_lead lead_row
  left join seed_customer customer_row
    on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key and lead_row.has_customer
  cross join lateral generate_series(
    1,
    case
      when lead_row.first_contacted_at is null then case when lead_row.r_contact < 0.3 then 1 + (lead_row.i % 3) else 0 end
      when lead_row.lifecycle = 'Transferred to Sales' then 2 + (lead_row.i % 4)
      else 1 + (lead_row.i % 3)
    end
  ) as attempt(k)
) as call_source_row
cross join lateral (
  select
    call_source_row.*,
    case
      when call_source_row.outcome <> 'CONNECTED' then 0
      when call_source_row.lead_id is not null and (hashtext(call_source_row.lead_id::text) % 151) = 0 then 3600
      when call_source_row.r < 0.03 then 0
      else 25 + floor(power(call_source_row.r, 1.8) * 900)::int
    end as duration
) as call_row
where call_row.started_at <= now();

-- --- Follow-ups and tasks ----------------------------------------------------

insert into public.followups (
  organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id, reason, due_at,
  status, priority, created_by, created_at, updated_at
)
select
  lead_row.org_id, lead_row.branch_id, lead_row.team_id, lead_row.lead_id, customer_row.customer_id,
  lead_row.assigned_user_id,
  (array['Customer Callback', 'Test Drive Confirmation', 'Quotation Discussion', 'Price Negotiation',
         'Stock Update', 'Exchange Update', 'Booking Confirmation', 'Document Reminder',
         'General Follow-up'])[1 + lead_row.i % 9],
  lead_row.next_followup_at,
  case when lead_row.next_followup_at < now() - interval '2 days' and lead_row.i % 4 = 0 then 'OVERDUE' else 'OPEN' end,
  (array['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT'])[1 + lead_row.i % 5],
  lead_row.assigned_user_id,
  coalesce(lead_row.first_contacted_at, lead_row.created_at),
  coalesce(lead_row.first_contacted_at, lead_row.created_at)
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
where lead_row.next_followup_at is not null and lead_row.assigned_user_id is not null;

-- Completed and cancelled follow-up history.
insert into public.followups (
  organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id, reason, due_at,
  status, completed_at, completion_note, outcome, cancelled_at, cancellation_reason, priority,
  created_by, created_at, updated_at
)
select
  lead_row.org_id, lead_row.branch_id, lead_row.team_id, lead_row.lead_id, customer_row.customer_id,
  lead_row.telecaller_id, 'Customer Callback',
  lead_row.first_contacted_at + interval '1 day',
  case when lead_row.i % 9 = 0 then 'CANCELLED' else 'COMPLETED' end,
  case when lead_row.i % 9 <> 0 then lead_row.first_contacted_at + interval '1 day 2 hours' end,
  case when lead_row.i % 9 <> 0 then 'Spoke to customer, details updated' end,
  case when lead_row.i % 9 <> 0 then
    case lead_row.lifecycle when 'Lost' then 'LOST' when 'Transferred to Sales' then 'TRANSFER_TO_SALES'
      when 'Appointment Scheduled' then 'APPOINTMENT' else 'FOLLOW_UP' end
  end,
  case when lead_row.i % 9 = 0 then lead_row.first_contacted_at + interval '20 hours' end,
  case when lead_row.i % 9 = 0 then 'Customer asked not to call this week' end,
  'NORMAL',
  lead_row.telecaller_id,
  lead_row.first_contacted_at,
  lead_row.first_contacted_at + interval '1 day 2 hours'
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
where lead_row.first_contacted_at is not null
  and lead_row.first_contacted_at < now() - interval '2 days'
  and lead_row.r_follow > 0.6;

insert into public.tasks (
  organization_id, branch_id, team_id, assigned_user_id, resource_type, resource_id, lead_id, customer_id,
  title, description, priority, status, due_at, completed_at, completion_note, created_by, created_at, updated_at
)
select
  lead_row.org_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id, 'lead', lead_row.lead_id,
  lead_row.lead_id, customer_row.customer_id,
  (array['Share brochure on WhatsApp', 'Collect KYC documents', 'Confirm finance eligibility',
         'Arrange exchange inspection', 'Send revised quotation'])[1 + lead_row.i % 5],
  case when lead_row.i % 2 = 0 then 'Customer prefers evening calls after 6 PM' end,
  (array['LOW', 'NORMAL', 'HIGH', 'URGENT'])[1 + lead_row.i % 4],
  task_state.status,
  now() + ((lead_row.r_follow - 0.4) * 6) * interval '1 day',
  case when task_state.status = 'COMPLETED' then now() - interval '3 hours' end,
  case when task_state.status = 'COMPLETED' then 'Done' end,
  lead_row.assigned_user_id,
  coalesce(lead_row.first_contacted_at, lead_row.created_at),
  coalesce(lead_row.first_contacted_at, lead_row.created_at)
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
cross join lateral (
  select (array['OPEN', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])[1 + lead_row.i % 5] as status
) as task_state
where lead_row.assigned_user_id is not null
  and lead_row.lifecycle in ('Contacted', 'Appointment Scheduled', 'Transferred to Sales')
  and lead_row.r_misc < 0.2;

-- --- Appointments ------------------------------------------------------------

insert into public.appointments (
  organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id, appointment_type,
  scheduled_at, status, attendance_status, notes, created_by, confirmed_at, arrived_at,
  completed_at, cancelled_at, cancellation_reason, created_at, updated_at
)
select
  appointment_row.org_id, appointment_row.branch_id, appointment_row.team_id, appointment_row.lead_id,
  appointment_row.customer_id, appointment_row.consultant_id, appointment_row.appointment_type,
  appointment_row.scheduled_at, appointment_row.status,
  case appointment_row.status when 'COMPLETED' then 'COMPLETED' when 'NO_SHOW' then 'NO_SHOW'
    when 'CONFIRMED' then 'NOT_ARRIVED' else null end,
  case when appointment_row.i % 6 = 0 then 'Customer coming with spouse; keep the white variant ready' end,
  appointment_row.telecaller_id,
  case when appointment_row.status in ('CONFIRMED', 'COMPLETED') then appointment_row.scheduled_at - interval '1 day' end,
  case when appointment_row.status = 'COMPLETED' then appointment_row.scheduled_at + interval '5 minutes' end,
  case when appointment_row.status = 'COMPLETED' then appointment_row.scheduled_at + interval '50 minutes' end,
  case when appointment_row.status = 'CANCELLED' then appointment_row.scheduled_at - interval '3 hours' end,
  case when appointment_row.status = 'CANCELLED' then 'Customer travelling, will reschedule' end,
  appointment_row.booked_on, appointment_row.booked_on
from (
  select
    lead_row.*, customer_row.customer_id,
    (array['Showroom Visit', 'Showroom Visit', 'Video Call', 'Consultant Call'])[1 + lead_row.i % 4] as appointment_type,
    case
      when lead_row.lifecycle = 'Appointment Scheduled'
        then date_trunc('hour', now() + ((lead_row.r_follow - 0.3) * 8) * interval '1 day') + interval '11 hours'
      else lead_row.first_contacted_at + interval '2 days'
    end as scheduled_at,
    lead_row.first_contacted_at + interval '1 hour' as booked_on
  from seed_lead lead_row
  join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
  where lead_row.lifecycle = 'Appointment Scheduled'
     or (lead_row.lifecycle = 'Transferred to Sales' and lead_row.r_misc < 0.5)
) as appointment_source
cross join lateral (
  select appointment_source.*,
    case
      when appointment_source.scheduled_at > now() then
        case when appointment_source.i % 3 = 0 then 'CONFIRMED' when appointment_source.i % 11 = 0 then 'RESCHEDULED' else 'SCHEDULED' end
      when appointment_source.lifecycle = 'Appointment Scheduled' then
        (array['NO_SHOW', 'CANCELLED', 'SCHEDULED'])[1 + appointment_source.i % 3]
      else case when appointment_source.i % 10 = 0 then 'NO_SHOW' else 'COMPLETED' end
    end as status
) as appointment_row;

-- --- Stock -------------------------------------------------------------------

create temp table seed_stock on commit drop as
select
  gen_random_uuid() as stock_id,
  seed_org.org_id,
  seed_org.code_letter,
  branch_row.branch_id,
  variant.variant_id,
  variant.model_name,
  unit.n,
  random() as r
from seed_org
cross join lateral generate_series(1, case seed_org.slug
  when 'go-digital-demo-test' then 120 when 'sapphire-hyundai-test' then 70
  when 'pioneer-tata-test' then 20 else 50 end) as unit(n)
join seed_branch branch_row
  on branch_row.org_id = seed_org.org_id and branch_row.branch_index = 1 + unit.n % branch_row.branch_count
join seed_variant variant
  on variant.org_id = seed_org.org_id and variant.variant_index = 1 + (unit.n * 7) % variant.variant_count;
create index on seed_stock (org_id, branch_id);
analyze seed_stock;

insert into public.stock_units (
  id, organization_id, branch_id, variant_id, vin, chassis_number, engine_number, color, status,
  received_at, created_by, deleted_at, deleted_by, deletion_reason, created_at, updated_at
)
select
  stock.stock_id, stock.org_id, stock.branch_id, stock.variant_id,
  'MA' || stock.code_letter || 'SD' || lpad(stock.n::text, 12, '0'),
  'CH' || stock.code_letter || lpad(stock.n::text, 10, '0'),
  'EN' || stock.code_letter || lpad(stock.n::text, 8, '0'),
  (array['Pristine White', 'Daytona Grey', 'Oberon Black', 'Flame Red', 'Ocean Blue'])[1 + stock.n % 5],
  stock_state.status,
  case when stock_state.status in ('INCOMING', 'IN_TRANSIT') then null
    else now() - (power(stock.r, 1.3) * 200) * interval '1 day' end,
  inventory.user_id,
  case when stock.n % 61 = 0 then now() - interval '2 days' end,
  case when stock.n % 61 = 0 then inventory.user_id end,
  case when stock.n % 61 = 0 then 'Entered twice by mistake' end,
  now() - (power(stock.r, 1.3) * 200 + 2) * interval '1 day',
  now()
from seed_stock stock
left join seed_role_user inventory on inventory.org_id = stock.org_id and inventory.role_key = 'inventory_manager'
cross join lateral (
  select case
    when stock.n % 13 = 0 then 'IN_TRANSIT'
    when stock.n % 11 = 0 then 'INCOMING'
    when stock.n % 17 = 0 then 'HOLD'
    when stock.n % 9 = 0 then 'RESERVED'
    else 'AVAILABLE'
  end as status
) as stock_state;

-- Demo fleet vehicle per showroom, used by test-drive appointments.
create temp table seed_fleet on commit drop as
select distinct on (stock.org_id, stock.branch_id)
  stock.org_id, stock.branch_id, stock.stock_id
from seed_stock stock
where stock.n % 13 <> 0 and stock.n % 11 <> 0 and stock.n % 61 <> 0
order by stock.org_id, stock.branch_id, stock.n;

-- --- Test drives -------------------------------------------------------------

create temp table seed_drive on commit drop as
select
  gen_random_uuid() as appointment_id,
  gen_random_uuid() as drive_id,
  lead_row.org_id, lead_row.branch_id, lead_row.team_id, lead_row.lead_id, lead_row.i,
  customer_row.customer_id, lead_row.consultant_id, fleet.stock_id,
  case
    when lead_row.sales_stage = 0 and lead_row.r_follow < 0.5 then 'SCHEDULED'
    when lead_row.sales_stage = 0 then 'CANCELLED'
    when lead_row.i % 97 = 3 then 'ACTIVE'
    else 'COMPLETED'
  end as status,
  case
    when lead_row.sales_stage = 0 and lead_row.r_follow < 0.5
      then date_trunc('hour', now() + (lead_row.r_follow * 6) * interval '1 day') + interval '10 hours'
    when lead_row.i % 97 = 3 then now() - interval '20 minutes'
    else least(lead_row.first_contacted_at + interval '3 days', now() - interval '2 hours')
  end as scheduled_at
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
join seed_fleet fleet on fleet.org_id = lead_row.org_id and fleet.branch_id = lead_row.branch_id
where lead_row.sales_stage is not null
  and (lead_row.sales_stage in (1, 2) or (lead_row.sales_stage = 3 and lead_row.r_misc < 0.7)
       or (lead_row.sales_stage = 0 and lead_row.r_sales < 0.12));

-- A drive in progress is unique per consultant and per vehicle
-- (test_drive_active_consultant_idx, test_drive_active_vehicle_idx): keep the
-- first one per consultant live, finish the rest, and give each live drive its
-- own vehicle.
update seed_drive drive
set status = 'COMPLETED', scheduled_at = now() - interval '3 hours'
where drive.status = 'ACTIVE'
  and (
    drive.appointment_id <> (
      select other.appointment_id from seed_drive other
      where other.status = 'ACTIVE' and other.consultant_id = drive.consultant_id
      order by other.i limit 1
    )
    or exists (
      select 1 from public.test_drive_appointments existing
      where existing.organization_id = drive.org_id
        and existing.assigned_user_id = drive.consultant_id
        and existing.status = 'ACTIVE'
    )
  );

with ranked_drive as (
  select appointment_id, org_id, branch_id,
    row_number() over (partition by org_id, branch_id order by i) as rank
  from seed_drive where status = 'ACTIVE'
), ranked_stock as (
  select stock_id, org_id, branch_id,
    row_number() over (partition by org_id, branch_id order by n desc) as rank
  from seed_stock
  where n % 13 <> 0 and n % 11 <> 0 and n % 61 <> 0
)
update seed_drive drive
set stock_id = ranked_stock.stock_id
from ranked_drive
join ranked_stock
  on ranked_stock.org_id = ranked_drive.org_id
 and ranked_stock.branch_id = ranked_drive.branch_id
 and ranked_stock.rank = ranked_drive.rank
where drive.appointment_id = ranked_drive.appointment_id;

insert into public.test_drive_appointments (
  id, organization_id, branch_id, team_id, customer_id, lead_id, assigned_user_id, stock_unit_id,
  scheduled_at, status, destination, start_location, vehicle_registration, expected_duration_minutes,
  created_by, cancelled_at, cancellation_reason, created_at, updated_at
)
select
  drive.appointment_id, drive.org_id, drive.branch_id, drive.team_id, drive.customer_id, drive.lead_id,
  drive.consultant_id, drive.stock_id, drive.scheduled_at, drive.status,
  jsonb_build_object('label', 'Customer home route', 'latitude', 12.9352, 'longitude', 77.6245),
  jsonb_build_object('label', 'Showroom'),
  'KA 01 TD ' || lpad((drive.i % 9000 + 1000)::text, 4, '0'),
  (array[30, 45, 60])[1 + drive.i % 3],
  drive.consultant_id,
  case when drive.status = 'CANCELLED' then drive.scheduled_at - interval '2 hours' end,
  case when drive.status = 'CANCELLED' then 'Customer postponed the purchase decision' end,
  drive.scheduled_at - interval '1 day',
  drive.scheduled_at
from seed_drive drive;

insert into public.test_drives (
  id, organization_id, branch_id, team_id, appointment_id, customer_id, lead_id, assigned_user_id,
  status, started_at, completed_at, start_anchor, end_anchor, start_odometer, end_odometer,
  distance_meters, duration_seconds, created_at, updated_at
)
select
  drive.drive_id, drive.org_id, drive.branch_id, drive.team_id, drive.appointment_id, drive.customer_id,
  drive.lead_id, drive.consultant_id, drive.status,
  drive.scheduled_at,
  case when drive.status = 'COMPLETED' then drive.scheduled_at + interval '38 minutes' end,
  jsonb_build_object('latitude', 12.9716, 'longitude', 77.5946, 'recorded_at', drive.scheduled_at),
  case when drive.status = 'COMPLETED'
    then jsonb_build_object('latitude', 12.9719, 'longitude', 77.5949, 'recorded_at', drive.scheduled_at + interval '38 minutes') end,
  1200 + drive.i % 4000,
  case when drive.status = 'COMPLETED' then 1200 + drive.i % 4000 + 8 + drive.i % 14 end,
  case when drive.status = 'COMPLETED' then (8 + drive.i % 14) * 1000 end,
  case when drive.status = 'COMPLETED' then 38 * 60 end,
  drive.scheduled_at - interval '1 day',
  drive.scheduled_at
from seed_drive drive
where drive.status in ('COMPLETED', 'ACTIVE');

insert into public.test_drive_feedback (
  organization_id, test_drive_id, vehicle_rating, consultant_rating, driving_experience_rating,
  comfort_rating, features_rating, performance_rating, price_perception_rating, overall_rating,
  competitor_compared, purchase_intent, comments, created_at
)
select
  drive.org_id, drive.drive_id,
  3 + drive.i % 3, 3 + (drive.i / 2) % 3, 3 + drive.i % 3, 2 + drive.i % 4, 3 + drive.i % 3,
  3 + (drive.i / 3) % 3, 1 + drive.i % 5, 3 + drive.i % 3,
  case when drive.i % 4 = 0 then (array['Mahindra XUV 3XO', 'Maruti Brezza', 'Kia Sonet', 'MG Windsor'])[1 + drive.i % 4] end,
  (array['HIGHLY_INTERESTED', 'INTERESTED', 'CONSIDERING', 'NOT_INTERESTED'])[1 + drive.i % 4],
  case when drive.i % 3 = 0 then 'Liked the ride quality; wants a better price on accessories' end,
  drive.scheduled_at + interval '45 minutes'
from seed_drive drive
where drive.status = 'COMPLETED' and drive.i % 5 <> 0;

-- --- Quotations and bookings -------------------------------------------------

create temp table seed_quote on commit drop as
select
  gen_random_uuid() as quotation_id,
  lead_row.org_id, lead_row.slug, lead_row.code_letter, lead_row.branch_id, lead_row.team_id,
  lead_row.lead_id, lead_row.i, lead_row.consultant_id, customer_row.customer_id, lead_row.sales_stage,
  variant.variant_id, variant.model_name, variant.variant_name, variant.price,
  least(lead_row.first_contacted_at + (4 + lead_row.r_contact * 12) * interval '1 day', now() - interval '1 hour') as quoted_at,
  (case when lead_row.i % 23 = 0 then round(variant.price * 0.08)
    else round(variant.price * (0.005 + lead_row.r_misc * 0.02)::numeric) end)::numeric as discount,
  row_number() over (partition by lead_row.org_id order by lead_row.i) as seq
from seed_lead lead_row
join seed_customer customer_row on customer_row.org_id = lead_row.org_id and customer_row.customer_key = lead_row.customer_key
join seed_variant variant
  on variant.org_id = lead_row.org_id
 and variant.variant_index = 1 + (lead_row.i * 5) % variant.variant_count
where lead_row.sales_stage >= 2;
create index on seed_quote (quotation_id);
analyze seed_quote;

alter table seed_quote add column status text;
alter table seed_quote add column approval_status text;
update seed_quote set
  status = case
    when sales_stage = 3 then 'CONVERTED'
    when i % 23 = 0 then 'PENDING_APPROVAL'
    else (array['DRAFT', 'SENT', 'SENT', 'SENT', 'REJECTED', 'EXPIRED', 'ACCEPTED'])[1 + i % 7]
  end;
update seed_quote set approval_status = case
  when status = 'PENDING_APPROVAL' then 'PENDING'
  when discount > price * 0.02 then 'APPROVED'
  else 'NOT_REQUIRED'
end;

insert into public.quotations (
  id, organization_id, branch_id, team_id, customer_id, lead_id, assigned_user_id, quotation_number,
  status, current_version, total_amount, approval_status, created_at, updated_at
)
select
  quotation_id, org_id, branch_id, team_id, customer_id, lead_id, consultant_id,
  'Q-' || code_letter || '-' || lpad(seq::text, 5, '0'),
  status, case when i % 4 = 0 then 2 else 1 end,
  round(price * 1.125) - discount + 25000,
  approval_status, quoted_at, quoted_at
from seed_quote;

insert into public.quotation_items (organization_id, quotation_id, item_type, description, quantity, unit_price, adjustment, created_at)
select org_id, quotation_id, 'VEHICLE', model_name || ' ' || variant_name || ' (ex-showroom)', 1, price, 0, quoted_at from seed_quote
union all
select org_id, quotation_id, 'INSURANCE', 'Comprehensive insurance, year 1', 1, round(price * 0.035), 0, quoted_at from seed_quote
union all
select org_id, quotation_id, 'OTHER', 'RTO / registration', 1, round(price * 0.09), 0, quoted_at from seed_quote
union all
select org_id, quotation_id, 'ACCESSORY', 'Accessories pack', 1, 25000, 0, quoted_at from seed_quote
union all
select org_id, quotation_id, 'DISCOUNT', 'Dealer discount', 1, 0, -discount, quoted_at from seed_quote;

insert into public.quotation_versions (organization_id, quotation_id, version, snapshot, created_by, created_at)
select org_id, quotation_id, 1,
  jsonb_build_object('model', model_name, 'variant', variant_name, 'ex_showroom', price, 'discount', discount),
  consultant_id, quoted_at
from seed_quote
union all
-- Revised quotations carry a second version with a deeper discount.
select org_id, quotation_id, 2,
  jsonb_build_object('model', model_name, 'variant', variant_name, 'ex_showroom', price, 'discount', discount),
  consultant_id, quoted_at + interval '1 day'
from seed_quote
where i % 4 = 0;

insert into public.approvals (
  organization_id, branch_id, resource_type, resource_id, approval_type, requested_change,
  requester_id, current_approver_id, authority_limit, status, created_at, decided_at
)
select
  quote.org_id, quote.branch_id, 'quotation', quote.quotation_id, 'QUOTATION_DISCOUNT',
  jsonb_build_object('quotation_version', 1, 'gross_amount', round(quote.price * 1.125) + 25000,
    'discount_amount', quote.discount,
    'total_amount', round(quote.price * 1.125) - quote.discount + 25000,
    'discount_percent', round(quote.discount / (quote.price * 1.125 + 25000) * 100, 2)),
  quote.consultant_id, manager.user_id, 50000,
  case when quote.status = 'PENDING_APPROVAL' then 'PENDING' else 'APPROVED' end,
  quote.quoted_at,
  case when quote.status <> 'PENDING_APPROVAL' then quote.quoted_at + interval '4 hours' end
from seed_quote quote
left join seed_role_user manager on manager.org_id = quote.org_id and manager.role_key = 'showroom_manager'
where quote.approval_status in ('PENDING', 'APPROVED');

create temp table seed_booking on commit drop as
select
  gen_random_uuid() as booking_id,
  quote.*,
  least(quote.quoted_at + (1 + quote.i % 5) * interval '1 day', now() - interval '30 minutes') as booked_at,
  quote.i % 10 < 6 as finance_required,
  quote.i % 5 = 0 as exchange_required,
  round(quote.price * 1.125) - quote.discount + 25000 as total_value
from seed_quote quote
where quote.sales_stage = 3;
create index on seed_booking (booking_id);
analyze seed_booking;

-- The quotation status came along with quote.*; a booking has its own.
alter table seed_booking drop column status;
alter table seed_booking add column status text;
update seed_booking set status = case
  when i % 13 = 0 then 'CANCELLED'
  when booked_at > now() - interval '4 days' then (array['CONFIRMED', 'AWAITING_ALLOCATION'])[1 + i % 2]
  when booked_at > now() - interval '12 days' then (array['AWAITING_ALLOCATION', 'ALLOCATED', 'CONFIRMED'])[1 + i % 3]
  when booked_at > now() - interval '25 days' then (array['ALLOCATED', 'READY_FOR_DELIVERY', 'DELIVERED'])[1 + i % 3]
  else case when i % 17 = 0 then 'READY_FOR_DELIVERY' else 'DELIVERED' end
end;

insert into public.bookings (
  id, organization_id, branch_id, team_id, customer_id, lead_id, quotation_id, assigned_user_id,
  booking_number, status, booking_amount, total_value, finance_required, exchange_required,
  expected_delivery_date, created_at, updated_at
)
select
  booking_id, org_id, branch_id, team_id, customer_id, lead_id, quotation_id, consultant_id,
  'BK-' || code_letter || '-' || lpad(seq::text, 5, '0'),
  status,
  case when i % 157 = 0 then 1 else (array[11000, 21000, 25000, 51000])[1 + i % 4] end,
  total_value, finance_required, exchange_required,
  (booked_at + (18 + i % 25) * interval '1 day')::date,
  booked_at, booked_at
from seed_booking;

-- A vehicle for every allocated, ready or delivered booking.
create temp table seed_booking_stock on commit drop as
select gen_random_uuid() as stock_id, booking.*,
  row_number() over (partition by booking.org_id order by booking.i) as unit_seq
from seed_booking booking
where booking.status in ('ALLOCATED', 'READY_FOR_DELIVERY', 'DELIVERED');
create index on seed_booking_stock (booking_id);
analyze seed_booking_stock;

insert into public.stock_units (
  id, organization_id, branch_id, variant_id, vin, chassis_number, engine_number, color, status,
  received_at, created_by, created_at, updated_at
)
select
  stock.stock_id, stock.org_id, stock.branch_id, stock.variant_id,
  'MA' || stock.code_letter || 'BK' || lpad(stock.unit_seq::text, 12, '0'),
  'CB' || stock.code_letter || lpad(stock.unit_seq::text, 10, '0'),
  'EB' || stock.code_letter || lpad(stock.unit_seq::text, 8, '0'),
  (array['Pristine White', 'Daytona Grey', 'Oberon Black'])[1 + stock.i % 3],
  case stock.status when 'ALLOCATED' then 'ALLOCATED' when 'READY_FOR_DELIVERY' then 'READY_FOR_DELIVERY' else 'DELIVERED' end,
  stock.booked_at - interval '20 days', inventory.user_id, stock.booked_at - interval '20 days', now()
from seed_booking_stock stock
left join seed_role_user inventory on inventory.org_id = stock.org_id and inventory.role_key = 'inventory_manager';

insert into public.stock_allocations (organization_id, branch_id, stock_unit_id, booking_id, allocation_method, status, allocated_by, allocated_at, updated_at)
select stock.org_id, stock.branch_id, stock.stock_id, stock.booking_id,
  case when stock.i % 2 = 0 then 'AUTO' else 'MANUAL' end, 'ALLOCATED', inventory.user_id,
  stock.booked_at + interval '3 days', stock.booked_at + interval '3 days'
from seed_booking_stock stock
left join seed_role_user inventory on inventory.org_id = stock.org_id and inventory.role_key = 'inventory_manager';

-- --- Operations cases --------------------------------------------------------

insert into public.finance_cases (
  organization_id, branch_id, booking_id, customer_id, assigned_user_id, status, lender,
  application_reference, approved_amount, disbursed_at, priority, due_at, notes, created_by, created_at, updated_at
)
select
  booking.org_id, booking.branch_id, booking.booking_id, booking.customer_id, finance.user_id,
  finance_state.status,
  (array['HDFC Bank', 'SBI', 'ICICI Bank', 'Axis Bank', 'Tata Capital', 'Bajaj Finance'])[1 + booking.i % 6],
  case when finance_state.status <> 'DOCUMENTS_PENDING' then 'APP-' || booking.i end,
  case when finance_state.status in ('APPROVED', 'DISBURSED') then round(booking.total_value * 0.8) end,
  case when finance_state.status = 'DISBURSED' then least(booking.booked_at + interval '9 days', now() - interval '1 day') end,
  (array['NORMAL', 'HIGH', 'NORMAL', 'URGENT'])[1 + booking.i % 4],
  booking.booked_at + interval '7 days',
  case when finance_state.status = 'REJECTED' then 'CIBIL score below lender cut-off; customer to try co-applicant' end,
  booking.consultant_id, booking.booked_at, booking.booked_at
from seed_booking booking
left join seed_role_user finance on finance.org_id = booking.org_id and finance.role_key = 'finance_manager'
cross join lateral (
  select case
    when booking.status = 'CANCELLED' then 'CANCELLED'
    when booking.i % 29 = 0 then 'REJECTED'
    when booking.status in ('DELIVERED', 'READY_FOR_DELIVERY') then 'DISBURSED'
    when booking.status = 'ALLOCATED' then (array['APPROVED', 'UNDER_REVIEW'])[1 + booking.i % 2]
    else (array['DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED'])[1 + booking.i % 2]
  end as status
) as finance_state
where booking.finance_required;

insert into public.insurance_cases (
  organization_id, branch_id, booking_id, customer_id, vehicle_id, assigned_user_id, status, insurer,
  policy_number, policy_start, policy_end, priority, due_at, created_by, created_at, updated_at
)
select
  booking.org_id, booking.branch_id, booking.booking_id, booking.customer_id, stock.stock_id, insurance.user_id,
  insurance_state.status,
  (array['ICICI Lombard', 'HDFC ERGO', 'Bajaj Allianz', 'Tata AIG', 'New India Assurance'])[1 + booking.i % 5],
  case when insurance_state.status = 'POLICY_ISSUED' then 'POL-' || booking.code_letter || '-' || booking.i end,
  case when insurance_state.status = 'POLICY_ISSUED' then (booking.booked_at + interval '15 days')::date end,
  case when insurance_state.status = 'POLICY_ISSUED' then (booking.booked_at + interval '15 days' + interval '1 year' - interval '1 day')::date end,
  'NORMAL', booking.booked_at + interval '10 days', booking.consultant_id, booking.booked_at, booking.booked_at
from seed_booking booking
left join seed_booking_stock stock on stock.booking_id = booking.booking_id
left join seed_role_user insurance on insurance.org_id = booking.org_id and insurance.role_key = 'insurance_manager'
cross join lateral (
  select case
    when booking.status = 'CANCELLED' then 'CANCELLED'
    when booking.status in ('DELIVERED', 'READY_FOR_DELIVERY') then 'POLICY_ISSUED'
    when booking.status = 'ALLOCATED' then (array['CUSTOMER_ACCEPTED', 'QUOTE_SHARED'])[1 + booking.i % 2]
    else 'QUOTE_PENDING'
  end as status
) as insurance_state;

insert into public.rto_cases (
  organization_id, branch_id, booking_id, customer_id, vehicle_id, assigned_user_id, status,
  registration_number, submitted_at, completed_at, priority, due_at, created_by, created_at, updated_at
)
select
  booking.org_id, booking.branch_id, booking.booking_id, booking.customer_id, stock.stock_id, rto.user_id,
  rto_state.status,
  case when rto_state.status = 'REGISTERED'
    then 'KA' || lpad((booking.i % 60 + 1)::text, 2, '0') || 'N' || chr(65 + booking.i % 26) || lpad((booking.i % 9000 + 1000)::text, 4, '0') end,
  case when rto_state.status in ('SUBMITTED', 'IN_PROCESS', 'REGISTERED')
    then least(booking.booked_at + interval '12 days', now() - interval '2 days') end,
  case when rto_state.status = 'REGISTERED' then least(booking.booked_at + interval '18 days', now() - interval '1 day') end,
  case when booking.i % 7 = 0 then 'HIGH' else 'NORMAL' end,
  booking.booked_at + interval '20 days', booking.consultant_id, booking.booked_at, booking.booked_at
from seed_booking booking
left join seed_booking_stock stock on stock.booking_id = booking.booking_id
left join seed_role_user rto on rto.org_id = booking.org_id and rto.role_key = 'rto_manager'
cross join lateral (
  select case
    when booking.status = 'CANCELLED' then 'CANCELLED'
    when booking.status = 'DELIVERED' then 'REGISTERED'
    when booking.status = 'READY_FOR_DELIVERY' then (array['REGISTERED', 'IN_PROCESS'])[1 + booking.i % 2]
    when booking.status = 'ALLOCATED' then (array['SUBMITTED', 'DOCUMENTS_PENDING'])[1 + booking.i % 2]
    else 'NEW'
  end as status
) as rto_state;

insert into public.delivery_cases (
  organization_id, branch_id, booking_id, customer_id, vehicle_id, assigned_user_id, status,
  scheduled_at, delivered_at, priority, due_at, notes, created_by, created_at, updated_at
)
select
  booking.org_id, booking.branch_id, booking.booking_id, booking.customer_id, stock.stock_id, delivery.user_id,
  delivery_state.status,
  case
    when delivery_state.status = 'DELIVERED' then least(booking.booked_at + interval '24 days', now() - interval '6 hours')
    when delivery_state.status = 'SCHEDULED' then greatest(booking.booked_at + interval '24 days', now() + interval '1 day')
  end,
  case when delivery_state.status = 'DELIVERED' then least(booking.booked_at + interval '24 days 3 hours', now() - interval '3 hours') end,
  case when booking.expected_delivery_date < current_date and delivery_state.status not in ('DELIVERED', 'CANCELLED') then 'URGENT' else 'NORMAL' end,
  booking.expected_delivery_date::timestamptz + interval '11 hours',
  case when booking.i % 11 = 0 then 'Customer wants delivery on an auspicious date' end,
  booking.consultant_id, booking.booked_at, booking.booked_at
from (
  select booking.*, booking.booked_at::date + (18 + booking.i % 25) as expected_delivery_date
  from seed_booking booking
) as booking
left join seed_booking_stock stock on stock.booking_id = booking.booking_id
left join seed_role_user delivery on delivery.org_id = booking.org_id and delivery.role_key = 'delivery_manager'
cross join lateral (
  select case
    when booking.status = 'CANCELLED' then 'CANCELLED'
    when booking.status = 'DELIVERED' then 'DELIVERED'
    when booking.status = 'READY_FOR_DELIVERY' then (array['READY', 'SCHEDULED'])[1 + booking.i % 2]
    when booking.status = 'ALLOCATED' then 'CHECKLIST_PENDING'
    else 'PLANNING'
  end as status
) as delivery_state;

insert into public.exchange_cases (
  organization_id, branch_id, booking_id, customer_id, assigned_user_id, status, estimated_value,
  accepted_value, customer_expected_value, fuel_type, ownership, odometer_km, priority, due_at, notes,
  created_by, created_at, updated_at
)
select
  booking.org_id, booking.branch_id, booking.booking_id, booking.customer_id, exchange.user_id,
  exchange_state.status,
  case when exchange_state.status in ('EVALUATED', 'OFFERED', 'ACCEPTED', 'REJECTED') then 280000 + (booking.i % 40) * 10000 end,
  case when exchange_state.status = 'ACCEPTED' then 270000 + (booking.i % 40) * 10000 end,
  350000 + (booking.i % 40) * 10000,
  (array['Petrol', 'Diesel', 'CNG'])[1 + booking.i % 3],
  (array['First', 'Second', 'Third'])[1 + booking.i % 3],
  case when booking.i % 37 = 0 then 312000 else 20000 + (booking.i * 977) % 120000 end,
  'NORMAL', booking.booked_at + interval '5 days',
  case when exchange_state.status = 'REJECTED' then 'Customer expected far above market value' end,
  booking.consultant_id, booking.booked_at, booking.booked_at
from seed_booking booking
left join seed_role_user exchange on exchange.org_id = booking.org_id and exchange.role_key = 'exchange_manager'
cross join lateral (
  select case
    when booking.status = 'CANCELLED' then 'CANCELLED'
    when booking.status in ('DELIVERED', 'READY_FOR_DELIVERY') then (array['ACCEPTED', 'ACCEPTED', 'REJECTED'])[1 + booking.i % 3]
    else (array['REQUESTED', 'INSPECTION_SCHEDULED', 'EVALUATED', 'OFFERED'])[1 + booking.i % 4]
  end as status
) as exchange_state
where booking.exchange_required;

-- --- After delivery: feedback, customer care, complaints, escalations --------

insert into public.feedback_requests (
  organization_id, branch_id, customer_id, booking_id, channel, status, sent_at, completed_at,
  rating, comments, created_at, updated_at
)
select
  booking.org_id, booking.branch_id, booking.customer_id, booking.booking_id, 'WHATSAPP',
  case when booking.i % 4 = 0 then 'SENT' else 'COMPLETED' end,
  booking.booked_at + interval '26 days',
  case when booking.i % 4 <> 0 then booking.booked_at + interval '27 days' end,
  case when booking.i % 4 <> 0 then (array[5, 5, 4, 4, 3, 2, 1])[1 + booking.i % 7] end,
  case when booking.i % 4 <> 0 and booking.i % 7 in (5, 6) then 'Delivery was delayed and nobody called me back' end,
  booking.booked_at + interval '26 days', booking.booked_at + interval '27 days'
from seed_booking booking
where booking.status = 'DELIVERED' and booking.booked_at + interval '26 days' < now();

create temp table seed_care on commit drop as
select
  gen_random_uuid() as case_id, booking.*,
  row_number() over (partition by booking.org_id order by booking.i) as case_seq,
  least(booking.booked_at + interval '27 days', now() - interval '1 day') as opened_at
from seed_booking booking
where booking.status = 'DELIVERED' and booking.i % 3 = 0;

insert into public.customer_care_cases (
  id, organization_id, branch_id, customer_id, booking_id, case_number, case_type, priority, status,
  assigned_user_id, subject, description, resolution, sla_due_at, first_contacted_at, resolved_at,
  closed_at, created_by, created_at, updated_at
)
select
  care.case_id, care.org_id, care.branch_id, care.customer_id, care.booking_id,
  'CC-' || care.code_letter || '-' || lpad(care.case_seq::text, 5, '0'),
  case_state.case_type,
  case when case_state.case_type = 'COMPLAINT' then 'HIGH' else 'NORMAL' end,
  case_state.status,
  relationship.user_id,
  case case_state.case_type when 'COMPLAINT' then 'Delivery delay complaint' when 'DOCUMENTATION_QUERY' then 'RC copy not received'
    else 'Post-delivery follow-up' end,
  case case_state.case_type when 'COMPLAINT' then 'Customer unhappy that delivery slipped by a week.'
    when 'DOCUMENTATION_QUERY' then 'Customer asking when the RC smart card will arrive.'
    else 'Seven-day post-delivery courtesy call.' end,
  case when case_state.status in ('RESOLVED', 'CLOSED') then 'Spoke to the customer and closed the loop.' end,
  care.opened_at + interval '2 days',
  case when case_state.status <> 'NEW' then care.opened_at + interval '3 hours' end,
  case when case_state.status in ('RESOLVED', 'CLOSED') then care.opened_at + interval '1 day' end,
  case when case_state.status = 'CLOSED' then care.opened_at + interval '2 days' end,
  coalesce(relationship.user_id, care.consultant_id),
  care.opened_at, care.opened_at
from seed_care care
left join seed_role_user relationship on relationship.org_id = care.org_id and relationship.role_key = 'customer_relationship_manager'
cross join lateral (
  select
    (array['DELIVERY_FOLLOWUP', 'DELIVERY_FOLLOWUP', 'COMPLAINT', 'DOCUMENTATION_QUERY', 'FEEDBACK'])[1 + care.i % 5] as case_type,
    (array['NEW', 'ASSIGNED', 'IN_PROGRESS', 'CUSTOMER_CONTACTED', 'RESOLVED', 'CLOSED'])[1 + care.i % 6] as status
) as case_state;

insert into public.complaints (organization_id, branch_id, customer_id, booking_id, assigned_user_id, category, description, priority, status, resolution, customer_case_id, created_at, updated_at)
select care.org_id, care.branch_id, care.customer_id, care.booking_id, relationship.user_id, 'Delivery delay',
  'Delivery slipped past the promised date.', 'HIGH',
  case when care.i % 2 = 0 then 'OPEN' else 'RESOLVED' end,
  case when care.i % 2 <> 0 then 'Goodwill accessory voucher issued.' end,
  care.case_id, care.opened_at, care.opened_at
from seed_care care
left join seed_role_user relationship on relationship.org_id = care.org_id and relationship.role_key = 'customer_relationship_manager'
where care.i % 5 = 2;

insert into public.escalations (organization_id, branch_id, resource_type, resource_id, assigned_user_id, reason, severity, status, resolved_at, customer_case_id, created_at, updated_at)
select care.org_id, care.branch_id, 'customer_care_case', care.case_id, manager.user_id,
  'Customer threatened a public review', 'HIGH',
  case when care.i % 4 = 2 then 'OPEN' else 'RESOLVED' end,
  case when care.i % 4 <> 2 then care.opened_at + interval '1 day' end,
  care.case_id, care.opened_at + interval '2 hours', care.opened_at + interval '2 hours'
from seed_care care
left join seed_role_user manager on manager.org_id = care.org_id and manager.role_key = 'showroom_manager'
where care.i % 5 = 2;

-- --- Notes -------------------------------------------------------------------

insert into public.notes (organization_id, resource_type, resource_id, body, created_by, created_at)
select lead_row.org_id, 'lead', lead_row.lead_id,
  (array['Prefers a call after 6 PM.', 'Wife is the decision maker; include her on the test drive.',
         'Has a competitor quote ₹40k lower — needs manager attention.',
         'Budget firm at ₹12 L on-road.', 'Wants delivery before Diwali.'])[1 + lead_row.i % 5],
  coalesce(lead_row.assigned_user_id, lead_row.telecaller_id),
  coalesce(lead_row.first_contacted_at, lead_row.created_at) + interval '10 minutes'
from seed_lead lead_row
where lead_row.i % 6 = 0;

-- --- Targets -----------------------------------------------------------------

-- Monthly model unit targets for the current and previous month. Demo's
-- flagship is set to beat its target, Whitefield to miss it, Mysuru and the
-- idle Hubballi showroom have none. Pioneer has no targets at all.
insert into public.branch_model_targets (organization_id, branch_id, model_id, month, target_units)
select branch_row.org_id, branch_row.branch_id, model_row.model_id, month_row.month,
  case
    when branch_row.code = 'BLR-01' then 2
    when branch_row.code = 'BLR-02' then 6
    else 3 + (abs(hashtext(model_row.model_id::text)) % 4)
  end
from seed_branch branch_row
join seed_org on seed_org.org_id = branch_row.org_id
join (select distinct org_id, model_id from seed_variant) model_row on model_row.org_id = branch_row.org_id
cross join (values
  (date_trunc('month', timezone('Asia/Kolkata', now()))::date),
  ((date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date)
) as month_row(month)
where seed_org.slug <> 'pioneer-tata-test'
  and branch_row.code not in ('MYS-01', 'HBL-01')
on conflict (organization_id, branch_id, month, model_id) do nothing;

-- GM target workspace metrics for the current month.
insert into public.targets (organization_id, branch_id, metric, period_start, period_end, target_value, assigned_by)
select branch_row.org_id, branch_row.branch_id, metric_row.metric,
  date_trunc('month', timezone('Asia/Kolkata', now()))::date,
  (date_trunc('month', timezone('Asia/Kolkata', now())) + interval '1 month' - interval '1 day')::date,
  metric_row.value * case when branch_row.branch_index = 1 then 2 else 1 end,
  gm.user_id
from seed_branch branch_row
join seed_org on seed_org.org_id = branch_row.org_id
left join seed_role_user gm on gm.org_id = branch_row.org_id and gm.role_key = 'gm_sales'
cross join (values ('BOOKINGS', 30), ('TEST_DRIVES', 80), ('SALES_VALUE', 45000000)) as metric_row(metric, value)
where seed_org.slug <> 'pioneer-tata-test' and branch_row.code <> 'HBL-01';

-- --- Credits -----------------------------------------------------------------

-- Demo is comfortably funded, Sapphire is nearly exhausted, Pioneer has none.
insert into public.credit_ledger (organization_id, ledger_kind, transaction_type, amount, feature, user_id, source, reference_id, reason, created_by, created_at)
select seed_org.org_id, 'AI'::public.credit_ledger_kind, 'ALLOCATION'::public.credit_transaction_type,
  allocation.amount::bigint, null::text, null::uuid, 'PLATFORM', 'seed-allocation-' || seed_org.slug,
  'Monthly package', null::uuid, now() - interval '20 days'
from seed_org
join (values ('go-digital-demo-test', 50000), ('sapphire-hyundai-test', 5000), ('royal-kia-test', 20000)) as allocation(slug, amount)
  on allocation.slug = seed_org.slug
union all
select seed_org.org_id, 'AI', 'CONSUMPTION', -usage.amount, usage.feature, null, 'FEATURE',
  'seed-usage-' || seed_org.slug || '-' || usage.n, 'Feature usage', null, now() - (usage.n % 20) * interval '1 day'
from seed_org
cross join lateral (
  select n, (array['TRANSCRIPTION', 'AI_SUMMARY', 'FIELD_EXTRACTION', 'BUSINESS_SUMMARY'])[1 + n % 4] as feature,
    case seed_org.slug when 'sapphire-hyundai-test' then 115 else 40 + n % 60 end as amount
  from generate_series(1, case seed_org.slug when 'go-digital-demo-test' then 120 when 'sapphire-hyundai-test' then 42 when 'royal-kia-test' then 60 else 0 end) as n
) as usage;

insert into public.credit_balances (organization_id, ledger_kind, balance, updated_at)
select ledger.organization_id, ledger.ledger_kind, sum(ledger.amount), now()
from public.credit_ledger ledger
join seed_org on seed_org.org_id = ledger.organization_id
group by ledger.organization_id, ledger.ledger_kind
on conflict (organization_id, ledger_kind) do update set balance = excluded.balance, updated_at = excluded.updated_at;

-- --- Module entitlements and tenant states -----------------------------------

update public.organization_module_entitlements entitlement
set enabled = false
from public.modules module_row, public.organizations organization_row
where module_row.id = entitlement.module_id
  and organization_row.id = entitlement.organization_id
  and (
    (organization_row.slug = 'pioneer-tata-test' and module_row.module_key in ('finance', 'exchange', 'marketing', 'ai'))
    or (organization_row.slug = 'sapphire-hyundai-test' and module_row.module_key = 'exchange')
  );

insert into public.tenant_status_history (organization_id, from_status, to_status, changed_by, reason, created_at)
select organization_row.id, 'ACTIVE', 'SUSPENDED', super_admin.id,
  'Subscription payment overdue by 45 days', now() - interval '3 days'
from public.organizations organization_row
cross join (select id from public.profiles where email = 'super-admin@demo.go-digital.invalid') as super_admin
where organization_row.slug = 'royal-kia-test' and organization_row.status = 'ACTIVE';
update public.organizations set status = 'SUSPENDED' where slug = 'royal-kia-test' and status = 'ACTIVE';

-- --- Derived state the disabled triggers would have maintained ---------------

set local session_replication_role = origin;

select app_private.refresh_lead_sales_facts(array_agg(lead_row.lead_id))
from seed_lead lead_row;

select app_private.bump_workspace_cache_version(seed_org.org_id, resource.key)
from seed_org
cross join (values ('tenant-dashboard'), ('inventory-dashboard')) as resource(key);
select app_private.bump_workspace_cache_version(null, 'platform-dashboard');

select json_build_object(
  'organizations', (select json_agg(slug) from seed_org),
  'leads', (select count(*) from seed_lead),
  'customers', (select count(*) from seed_customer),
  'stock_units', (select count(*) from seed_stock) + (select count(*) from seed_booking_stock),
  'test_drives', (select count(*) from seed_drive),
  'quotations', (select count(*) from seed_quote),
  'bookings', (select count(*) from seed_booking)
) as seeded;

commit;
