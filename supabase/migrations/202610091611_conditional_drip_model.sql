begin;

-- Conditional, multi-channel drip campaigns for Digital Marketing.
--
-- A campaign now starts from an event -- a new lead from chosen sources, a
-- birthday or wedding anniversary, a booking, a delivery or its anniversary --
-- instead of only the hourly audience match (trigger_type 'AUDIENCE', which is
-- unchanged). A step can send on several channels at once: each ticked channel
-- carries its own approved template and a map from the template's placeholders
-- to customer/lead fields, rendered once at enrollment.
--
-- An enrollment is keyed by occurrence (lead:<id>, birthday:<customer>:<year>,
-- ...) so a matching pass is idempotent. A new lead often has no customer yet,
-- and the thank-you must not wait for linking, so customer_id becomes optional
-- when a lead is named.
--
-- Customers can opt out of marketing per channel (customer_marketing_opt_outs).
-- Marketing templates are marked category MARKETING with their placeholders.

-- Campaign trigger --------------------------------------------------------------
alter table public.marketing_drip_campaigns
  add column if not exists trigger_type text not null default 'AUDIENCE',
  add column if not exists trigger_conditions jsonb not null default '{}'::jsonb,
  add column if not exists activated_at timestamptz;

alter table public.marketing_drip_campaigns
  drop constraint if exists marketing_drip_campaigns_trigger_type_check,
  add constraint marketing_drip_campaigns_trigger_type_check check (trigger_type in (
    'AUDIENCE', 'LEAD_CREATED', 'BIRTHDAY', 'ANNIVERSARY', 'BOOKING_CONFIRMED',
    'VEHICLE_DELIVERED', 'DELIVERY_ANNIVERSARY'
  )),
  drop constraint if exists marketing_drip_campaigns_trigger_conditions_object,
  add constraint marketing_drip_campaigns_trigger_conditions_object
    check (jsonb_typeof(trigger_conditions) = 'object');

update public.marketing_drip_campaigns
set activated_at = coalesce(starts_at, updated_at)
where status = 'ACTIVE' and activated_at is null;

create index if not exists marketing_drip_campaigns_event_idx
  on public.marketing_drip_campaigns (organization_id, trigger_type)
  where status = 'ACTIVE' and deleted_at is null and trigger_type <> 'AUDIENCE';

-- One row per channel a step sends on -------------------------------------------
create table if not exists public.marketing_drip_step_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  step_id uuid not null references public.marketing_drip_steps(id) on delete cascade,
  channel text not null,
  template_id uuid not null references public.templates(id),
  -- placeholder -> token, e.g. {"1": "customer_first_name", "2": "interested_model"}
  variable_map jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (step_id, channel),
  unique (organization_id, id),
  check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  check (jsonb_typeof(variable_map) = 'object')
);
create index if not exists marketing_drip_step_channels_template_idx
  on public.marketing_drip_step_channels (organization_id, template_id);

alter table public.marketing_drip_step_channels enable row level security;
revoke all on public.marketing_drip_step_channels from public, anon, authenticated;
grant select on public.marketing_drip_step_channels to authenticated;
drop policy if exists marketing_drip_step_channels_select on public.marketing_drip_step_channels;
create policy marketing_drip_step_channels_select on public.marketing_drip_step_channels
  for select to authenticated
  using (app_private.has_permission(organization_id, 'marketing.automation.view'));

-- Existing single-channel steps that already name a template.
insert into public.marketing_drip_step_channels (organization_id, step_id, channel, template_id, variable_map)
select step_row.organization_id, step_row.id, step_row.channel, step_row.template_id, '{}'::jsonb
from public.marketing_drip_steps step_row
where step_row.template_id is not null
on conflict (step_id, channel) do nothing;

-- Enrollment provenance ----------------------------------------------------------
alter table public.customer_drip_enrollments
  alter column customer_id drop not null,
  add column if not exists trigger_type text,
  add column if not exists trigger_resource_id uuid,
  add column if not exists occurrence_key text;

alter table public.customer_drip_enrollments
  drop constraint if exists customer_drip_enrollments_customer_or_lead,
  add constraint customer_drip_enrollments_customer_or_lead
    check (customer_id is not null or lead_id is not null),
  drop constraint if exists customer_drip_enrollments_occurrence_key_check,
  add constraint customer_drip_enrollments_occurrence_key_check
    check (occurrence_key is null or char_length(occurrence_key) between 3 and 200);

create unique index if not exists customer_drip_enrollments_occurrence_idx
  on public.customer_drip_enrollments (organization_id, source_campaign_id, occurrence_key)
  where occurrence_key is not null;
create index if not exists customer_drip_enrollments_lead_idx
  on public.customer_drip_enrollments (organization_id, lead_id)
  where lead_id is not null;

-- One message row per step and channel -----------------------------------------
alter table public.customer_drip_messages
  drop constraint if exists customer_drip_messages_enrollment_id_step_order_key,
  drop constraint if exists customer_drip_messages_step_order_check,
  add constraint customer_drip_messages_step_order_check check (step_order between 1 and 24),
  add column if not exists skip_reason text;

alter table public.customer_drip_messages
  drop constraint if exists customer_drip_messages_enrollment_step_channel_key,
  add constraint customer_drip_messages_enrollment_step_channel_key
    unique (enrollment_id, step_order, channel),
  drop constraint if exists customer_drip_messages_skip_reason_check,
  add constraint customer_drip_messages_skip_reason_check check (
    skip_reason is null or skip_reason in ('CAMPAIGN_PAUSED', 'DORMANT', 'OPTED_OUT', 'NO_RECIPIENT')
  );

-- Marketing opt-outs -------------------------------------------------------------
create table if not exists public.customer_marketing_opt_outs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  customer_id uuid not null references public.customers(id),
  channel text not null,
  reason text,
  source text not null default 'MANUAL',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id),
  unique (organization_id, id),
  check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  check (source in ('MANUAL', 'STOP_REPLY')),
  check (reason is null or char_length(btrim(reason)) between 1 and 500)
);
create unique index if not exists customer_marketing_opt_outs_active_idx
  on public.customer_marketing_opt_outs (organization_id, customer_id, channel)
  where revoked_at is null;

alter table public.customer_marketing_opt_outs enable row level security;
-- Read and written only through security-definer RPCs.
revoke all on public.customer_marketing_opt_outs from public, anon, authenticated;

-- Marketing templates ------------------------------------------------------------
alter table public.templates
  add column if not exists category text not null default 'TRANSACTIONAL',
  add column if not exists placeholders jsonb not null default '[]'::jsonb;

alter table public.templates
  drop constraint if exists templates_category_check,
  add constraint templates_category_check check (category in ('MARKETING', 'TRANSACTIONAL')),
  drop constraint if exists templates_placeholders_array,
  add constraint templates_placeholders_array check (jsonb_typeof(placeholders) = 'array');

-- {{1}}, {{VAR1}}, {{FIRSTNAME}} ... in order of first appearance.
create or replace function app_private.template_placeholders(target_body text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(found.placeholder order by found.first_at), '[]'::jsonb)
  from (
    select match_row.parts[1] as placeholder, min(match_row.position) as first_at
    from regexp_matches(coalesce(target_body, ''), '\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}', 'g')
      with ordinality as match_row(parts, position)
    group by match_row.parts[1]
  ) found;
$$;
revoke all on function app_private.template_placeholders(text) from public, anon;
grant execute on function app_private.template_placeholders(text) to authenticated;

update public.templates
set placeholders = app_private.template_placeholders(content ->> 'body')
where deleted_at is null
  and jsonb_typeof(content -> 'body') = 'string'
  and placeholders = '[]'::jsonb;

commit;
