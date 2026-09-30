begin;

-- Campaign spend, per campaign per day. A provider sync writes PROVIDER_SYNC rows
-- when the connected ads account exposes spend; until then the marketing
-- manager records spend by hand. Cost metrics are derived only from these rows,
-- never estimated from the budget.
create table public.marketing_campaign_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  campaign_id uuid not null,
  metric_date date not null,
  spend_amount numeric(14,2) not null,
  impressions bigint,
  clicks bigint,
  data_source text not null default 'MANUAL',
  recorded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaign_metric_campaign_org_fk foreign key (organization_id, campaign_id)
    references public.marketing_campaigns (organization_id, id),
  constraint marketing_campaign_metric_recorder_org_fk foreign key (organization_id, recorded_by)
    references public.profiles (organization_id, id),
  constraint marketing_campaign_metric_day_unique unique (organization_id, campaign_id, metric_date),
  check (spend_amount >= 0),
  check (impressions is null or impressions >= 0),
  check (clicks is null or clicks >= 0),
  check (clicks is null or impressions is null or clicks <= impressions),
  check (data_source in ('MANUAL', 'PROVIDER_SYNC'))
);

alter table public.marketing_campaign_daily_metrics enable row level security;
alter table public.marketing_campaign_daily_metrics force row level security;
create policy marketing_campaign_daily_metrics_read on public.marketing_campaign_daily_metrics
for select to authenticated using (
  app_private.has_permission(organization_id, 'marketing.view')
  and exists (
    select 1 from public.marketing_campaigns campaign_row
    where campaign_row.organization_id = marketing_campaign_daily_metrics.organization_id
      and campaign_row.id = marketing_campaign_daily_metrics.campaign_id
      and campaign_row.deleted_at is null
      and ((campaign_row.branch_id is null and app_private.has_organization_wide_scope(campaign_row.organization_id))
        or (campaign_row.branch_id is not null and app_private.can_access_branch(campaign_row.organization_id, campaign_row.branch_id)))
  ));
revoke insert, update, delete, truncate on public.marketing_campaign_daily_metrics from anon, authenticated;

-- Metrics reference campaigns, so they are purged first (campaigns are 786).
insert into app_private.retention_table_allowlist (table_name, disposition, delete_order) values
  ('marketing_campaign_daily_metrics', 'DELETE', 779)
on conflict (table_name) do update set disposition = excluded.disposition, delete_order = excluded.delete_order;

drop trigger if exists realtime_marketing_campaign_metrics_invalidate on public.marketing_campaign_daily_metrics;
create trigger realtime_marketing_campaign_metrics_invalidate
after insert or update on public.marketing_campaign_daily_metrics
for each row execute function app_private.broadcast_tenant_invalidation('marketing');

-- Leads are attributed to a campaign by the campaign text the source sent,
-- matched case-insensitively on the campaign name or its external ID.
create index if not exists leads_org_campaign_key_idx
  on public.leads (organization_id, (lower(btrim(campaign))))
  where deleted_at is null and campaign is not null;

-- Lead-source providers whose ad form columns a marketing manager may map.
-- Credentials and connection settings stay with integration.manage.
create or replace function app_private.marketing_mappable_lead_providers()
returns text[] language sql immutable set search_path = '' as $$
  select array['meta', 'google_ads', 'indiamart', 'carwale', 'cardekho', 'justdial']::text[]
$$;

-- Lead, booking and spend totals for every campaign the caller can see. Lead
-- counts honour lead scope; spend is null (not zero) when nothing is recorded,
-- so callers can tell "no spend data" from "spent nothing".
create or replace function app_private.marketing_campaign_stats(target_organization_id uuid)
returns table (
  stat_campaign_id uuid,
  stat_leads bigint,
  stat_qualified bigint,
  stat_bookings bigint,
  stat_spend numeric,
  stat_impressions bigint,
  stat_clicks bigint,
  stat_spend_days bigint,
  stat_last_metric_date date,
  stat_has_provider_metrics boolean
)
language sql stable security definer set search_path = '' as $$
  with campaigns as materialized (
    select campaign_row.id, campaign_row.branch_id,
      lower(btrim(campaign_row.name)) as name_key,
      lower(btrim(campaign_row.external_campaign_id)) as external_key
    from public.marketing_campaigns campaign_row
    where campaign_row.organization_id = target_organization_id
      and campaign_row.deleted_at is null
      and ((campaign_row.branch_id is null and app_private.has_organization_wide_scope(target_organization_id))
        or (campaign_row.branch_id is not null and app_private.can_access_branch(target_organization_id, campaign_row.branch_id)))
  ), matched as materialized (
    select campaign.id as campaign_ref, lead_row.id as lead_ref, lead_row.branch_id,
      lead_row.team_id, lead_row.assigned_user_id, lead_row.lifecycle_status
    from campaigns campaign
    join public.leads lead_row
      on lead_row.organization_id = target_organization_id
      and lead_row.deleted_at is null
      and lead_row.campaign is not null
      and lower(btrim(lead_row.campaign)) in (campaign.name_key, campaign.external_key)
      and (campaign.branch_id is null or lead_row.branch_id is null or lead_row.branch_id = campaign.branch_id)
    where (select app_private.has_permission(target_organization_id, 'lead.view'))
  ), scopes as materialized (
    select distinct branch_id, team_id, assigned_user_id from matched
  ), allowed_scopes as materialized (
    select scope_row.* from scopes scope_row
    where app_private.can_access_record(target_organization_id,
      scope_row.branch_id, scope_row.team_id, scope_row.assigned_user_id)
  ), lead_totals as (
    select matched_row.campaign_ref, count(*) as leads,
      count(*) filter (where matched_row.lifecycle_status in ('Qualified', 'Appointment Scheduled', 'Transferred to Sales')) as qualified,
      count(*) filter (where exists (
        select 1 from public.bookings booking_row
        where booking_row.organization_id = target_organization_id
          and booking_row.lead_id = matched_row.lead_ref and booking_row.deleted_at is null)) as bookings
    from matched matched_row
    join allowed_scopes scope_row
      on scope_row.branch_id is not distinct from matched_row.branch_id
      and scope_row.team_id is not distinct from matched_row.team_id
      and scope_row.assigned_user_id is not distinct from matched_row.assigned_user_id
    group by matched_row.campaign_ref
  ), metric_totals as (
    select metric_row.campaign_id as campaign_ref, sum(metric_row.spend_amount) as spend,
      sum(metric_row.impressions) as impressions, sum(metric_row.clicks) as clicks,
      count(*) as spend_days, max(metric_row.metric_date) as last_metric_date,
      bool_or(metric_row.data_source = 'PROVIDER_SYNC') as has_provider
    from public.marketing_campaign_daily_metrics metric_row
    where metric_row.organization_id = target_organization_id
      and metric_row.campaign_id in (select id from campaigns)
    group by metric_row.campaign_id
  )
  select campaign.id, coalesce(lead_totals.leads, 0), coalesce(lead_totals.qualified, 0),
    coalesce(lead_totals.bookings, 0), metric_totals.spend, metric_totals.impressions,
    metric_totals.clicks, coalesce(metric_totals.spend_days, 0), metric_totals.last_metric_date,
    coalesce(metric_totals.has_provider, false)
  from campaigns campaign
  left join lead_totals on lead_totals.campaign_ref = campaign.id
  left join metric_totals on metric_totals.campaign_ref = campaign.id
$$;

create or replace function public.get_marketing_workspace_page(
  target_view text default 'CAMPAIGNS', target_search text default '', target_page integer default 1,
  target_page_size integer default 25, target_sort text default 'updated:desc', target_timezone text default 'Asia/Kolkata'
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare current_organization_id uuid; normalized_view text := upper(btrim(coalesce(target_view, 'CAMPAIGNS'))); normalized_search text := lower(btrim(coalesce(target_search, ''))); result jsonb; can_manage boolean;
begin
  if normalized_view not in ('SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS') or char_length(normalized_search) > 160
    or target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100)
    or target_sort not in ('updated:desc', 'created:desc', 'name:asc', 'status:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC') then raise exception using errcode = '22023', message = 'INVALID_MARKETING_QUERY'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not app_private.has_permission(current_organization_id, 'marketing.view') then
    raise exception using errcode = '42501', message = 'MARKETING_VIEW_PERMISSION_REQUIRED'; end if;
  can_manage := app_private.has_permission(current_organization_id, 'marketing.manage');
  if normalized_view = 'SOURCES' then
    with lead_scopes as materialized (
      select distinct branch_id, team_id, assigned_user_id
      from public.leads
      where organization_id = current_organization_id and deleted_at is null
    ), allowed_scopes as materialized (
      select scope_row.* from lead_scopes scope_row
      where app_private.has_permission(current_organization_id, 'lead.view')
        and app_private.can_access_record(current_organization_id,
          scope_row.branch_id, scope_row.team_id, scope_row.assigned_user_id)
    ), source_rows as materialized (
      select lead_row.source as source, count(*) as leads,
        count(*) filter (where lead_row.lifecycle_status in ('Qualified', 'Appointment Scheduled', 'Transferred to Sales')) as qualified,
        count(*) filter (where exists (select 1 from public.test_drives drive_row where drive_row.organization_id = lead_row.organization_id and drive_row.lead_id = lead_row.id)) as test_drives,
        count(*) filter (where exists (select 1 from public.quotations quotation_row where quotation_row.organization_id = lead_row.organization_id and quotation_row.lead_id = lead_row.id and quotation_row.deleted_at is null)) as quotations,
        count(*) filter (where exists (select 1 from public.bookings booking_row where booking_row.organization_id = lead_row.organization_id and booking_row.lead_id = lead_row.id and booking_row.deleted_at is null)) as bookings
      from public.leads lead_row where lead_row.organization_id = current_organization_id and lead_row.deleted_at is null
        and exists (
          select 1 from allowed_scopes scope_row
          where scope_row.branch_id is not distinct from lead_row.branch_id
            and scope_row.team_id is not distinct from lead_row.team_id
            and scope_row.assigned_user_id is not distinct from lead_row.assigned_user_id
        )
        and (normalized_search = '' or position(normalized_search in lower(lead_row.source)) > 0 or position(normalized_search in lower(coalesce(lead_row.campaign, ''))) > 0)
      group by lead_row.source
    ), campaign_stats as materialized (
      select stat_row.*, campaign_row.canonical_source, campaign_row.currency_code
      from app_private.marketing_campaign_stats(current_organization_id) stat_row
      join public.marketing_campaigns campaign_row on campaign_row.id = stat_row.stat_campaign_id
    ), paid as (
      -- Cost per lead only divides spend by the leads of campaigns that carry spend.
      select canonical_source, sum(stat_spend) as spend, sum(stat_leads) as paid_leads, sum(stat_bookings) as paid_bookings
      from campaign_stats where stat_spend is not null group by canonical_source
    ), spend_totals as (
      select sum(stat_spend) as spend, sum(stat_leads) as paid_leads, sum(stat_bookings) as paid_bookings,
        sum(stat_clicks) as clicks, sum(stat_impressions) as impressions,
        case when count(distinct currency_code) > 1 then 'MIXED' else coalesce(min(currency_code), 'INR') end as currency
      from campaign_stats where stat_spend is not null
    ), ordered as (select source_row.*, paid.spend, paid.paid_leads, row_number() over (order by case when target_sort = 'name:asc' then source_row.source end asc, source_row.leads desc, source_row.source asc) as page_order from source_rows source_row left join paid on paid.canonical_source = source_row.source), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size)
    select jsonb_build_object(
      'organization_id', current_organization_id, 'view', normalized_view, 'can_manage', can_manage,
      'records', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'leads', leads, 'qualified', qualified, 'test_drives', test_drives, 'quotations', quotations, 'bookings', bookings, 'conversion', case when leads = 0 then 0 else round(bookings::numeric * 100 / leads, 1) end, 'spend', spend, 'cost_per_lead', case when spend is null or coalesce(paid_leads, 0) = 0 then null else round(spend / paid_leads, 2) end) order by page_order) from page_rows), '[]'::jsonb),
      'total', (select count(*) from source_rows),
      'kpis', jsonb_build_object(
        'leads_generated', coalesce((select sum(leads) from source_rows), 0),
        'qualified_leads', coalesce((select sum(qualified) from source_rows), 0),
        'bookings', coalesce((select sum(bookings) from source_rows), 0),
        'conversion_percent', coalesce((select round(sum(bookings)::numeric * 100 / nullif(sum(leads), 0), 1) from source_rows), 0),
        'active_campaigns', (select count(*) from public.marketing_campaigns campaign_row where campaign_row.organization_id = current_organization_id and campaign_row.status = 'ACTIVE' and campaign_row.deleted_at is null and (campaign_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or campaign_row.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign_row.branch_id))),
        'review_requests', (select count(*) from public.customer_care_cases case_row where case_row.organization_id = current_organization_id and case_row.case_type = 'REVIEW_REQUEST' and case_row.deleted_at is null and app_private.can_access_record(case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id) and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)),
        'posts_published', (select count(*) from public.social_posts post_row where post_row.organization_id = current_organization_id and post_row.status = 'PUBLISHED' and post_row.deleted_at is null and (post_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or post_row.branch_id is not null and app_private.can_access_branch(current_organization_id, post_row.branch_id))),
        'ad_spend', (select spend from spend_totals),
        'paid_leads', coalesce((select paid_leads from spend_totals), 0),
        'cost_per_lead', (select case when spend is null or coalesce(paid_leads, 0) = 0 then null else round(spend / paid_leads, 2) end from spend_totals),
        'cost_per_booking', (select case when spend is null or coalesce(paid_bookings, 0) = 0 then null else round(spend / paid_bookings, 2) end from spend_totals),
        'click_through_percent', (select case when coalesce(impressions, 0) = 0 or clicks is null then null else round(clicks::numeric * 100 / impressions, 2) end from spend_totals),
        'spend_currency', (select currency from spend_totals)
      ),
      'source_chart', coalesce((select jsonb_agg(jsonb_build_object('name', source, 'value', leads, 'secondary', bookings) order by leads desc) from source_rows), '[]'::jsonb),
      'funnel_chart', jsonb_build_array(
        jsonb_build_object('name', 'Leads', 'value', coalesce((select sum(leads) from source_rows), 0)),
        jsonb_build_object('name', 'Qualified', 'value', coalesce((select sum(qualified) from source_rows), 0)),
        jsonb_build_object('name', 'Bookings', 'value', coalesce((select sum(bookings) from source_rows), 0))
      )
    ) into result;
  elsif normalized_view = 'CAMPAIGNS' then
    with campaign_stats as materialized (
      select * from app_private.marketing_campaign_stats(current_organization_id)
    ), authorized as materialized (select campaign_row.* from public.marketing_campaigns campaign_row where campaign_row.organization_id = current_organization_id and campaign_row.deleted_at is null and (campaign_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or campaign_row.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign_row.branch_id)) and (normalized_search = '' or position(normalized_search in lower(campaign_row.name)) > 0 or position(normalized_search in lower(campaign_row.canonical_source)) > 0)), ordered as (select *, row_number() over (order by case when target_sort = 'name:asc' then name end asc, case when target_sort = 'status:asc' then status end asc, case when target_sort = 'created:desc' then created_at end desc, updated_at desc, id desc) as page_order from authorized), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size),
    all_campaigns as (
      select stat_row.*, campaign_row.name, campaign_row.status, campaign_row.currency_code
      from campaign_stats stat_row join public.marketing_campaigns campaign_row on campaign_row.id = stat_row.stat_campaign_id
    ), spend_totals as (
      select sum(stat_spend) as spend, sum(stat_leads) as paid_leads, sum(stat_bookings) as paid_bookings,
        sum(stat_clicks) as clicks, sum(stat_impressions) as impressions,
        case when count(distinct currency_code) > 1 then 'MIXED' else coalesce(min(currency_code), 'INR') end as currency
      from all_campaigns where stat_spend is not null
    )
    select jsonb_build_object('organization_id', current_organization_id, 'view', normalized_view, 'can_manage', can_manage,
      'records', coalesce((select jsonb_agg((to_jsonb(page_row) - 'page_order') || jsonb_build_object(
          'leads', coalesce(stat_row.stat_leads, 0),
          'qualified', coalesce(stat_row.stat_qualified, 0),
          'bookings', coalesce(stat_row.stat_bookings, 0),
          'spend', stat_row.stat_spend,
          'impressions', stat_row.stat_impressions,
          'clicks', stat_row.stat_clicks,
          'spend_days', coalesce(stat_row.stat_spend_days, 0),
          'last_metric_date', stat_row.stat_last_metric_date,
          'spend_source', case when stat_row.stat_spend is null then null when stat_row.stat_has_provider_metrics then 'PROVIDER_SYNC' else 'MANUAL' end,
          'cost_per_lead', case when stat_row.stat_spend is null or coalesce(stat_row.stat_leads, 0) = 0 then null else round(stat_row.stat_spend / stat_row.stat_leads, 2) end,
          'cost_per_booking', case when stat_row.stat_spend is null or coalesce(stat_row.stat_bookings, 0) = 0 then null else round(stat_row.stat_spend / stat_row.stat_bookings, 2) end,
          'click_through_percent', case when coalesce(stat_row.stat_impressions, 0) = 0 or stat_row.stat_clicks is null then null else round(stat_row.stat_clicks::numeric * 100 / stat_row.stat_impressions, 2) end,
          'budget_used_percent', case when stat_row.stat_spend is null or coalesce(page_row.budget_amount, 0) = 0 then null else round(stat_row.stat_spend * 100 / page_row.budget_amount, 1) end
        ) order by page_row.page_order) from page_rows page_row left join campaign_stats stat_row on stat_row.stat_campaign_id = page_row.id), '[]'::jsonb),
      'total', (select count(*) from authorized),
      'campaign_kpis', jsonb_build_object(
        'active_campaigns', (select count(*) from all_campaigns where status = 'ACTIVE'),
        'campaign_leads', coalesce((select sum(stat_leads) from all_campaigns), 0),
        'campaign_bookings', coalesce((select sum(stat_bookings) from all_campaigns), 0),
        'ad_spend', (select spend from spend_totals),
        'cost_per_lead', (select case when spend is null or coalesce(paid_leads, 0) = 0 then null else round(spend / paid_leads, 2) end from spend_totals),
        'cost_per_booking', (select case when spend is null or coalesce(paid_bookings, 0) = 0 then null else round(spend / paid_bookings, 2) end from spend_totals),
        'click_through_percent', (select case when coalesce(impressions, 0) = 0 or clicks is null then null else round(clicks::numeric * 100 / impressions, 2) end from spend_totals),
        'spend_currency', (select currency from spend_totals)
      ),
      'campaign_chart', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'value', round(stat_spend / stat_leads, 2)) order by stat_spend / stat_leads desc) from (
          select name, stat_spend, stat_leads from all_campaigns
          where stat_spend is not null and stat_leads > 0 order by stat_spend desc limit 10) chart_row), '[]'::jsonb)
    ) into result;
  else
    with authorized as materialized (select post_row.* from public.social_posts post_row where post_row.organization_id = current_organization_id and post_row.deleted_at is null and (post_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or post_row.branch_id is not null and app_private.can_access_branch(current_organization_id, post_row.branch_id)) and (normalized_search = '' or position(normalized_search in lower(post_row.content)) > 0 or position(normalized_search in lower(post_row.platform)) > 0)), ordered as (select *, row_number() over (order by case when target_sort = 'status:asc' then status end asc, case when target_sort = 'created:desc' then created_at end desc, updated_at desc, id desc) as page_order from authorized), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size)
    select jsonb_build_object('organization_id', current_organization_id, 'view', normalized_view, 'can_manage', can_manage, 'records', coalesce((select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_order) from page_rows page_row), '[]'::jsonb), 'total', (select count(*) from authorized)) into result;
  end if;
  return result;
end;
$function$;

-- Create or edit a campaign. Branch-less campaigns need organization-wide scope;
-- an edit must carry the version it was read at.
create or replace function public.save_marketing_campaign(
  target_campaign_id uuid,
  target_expected_version bigint,
  target_name text,
  target_platform text,
  target_canonical_source text,
  target_status text,
  target_branch_id uuid,
  target_starts_on date,
  target_ends_on date,
  target_budget_amount numeric,
  target_currency_code text,
  target_external_campaign_id text,
  target_notes text,
  target_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  campaign_name text := btrim(coalesce(target_name, ''));
  external_ref text := nullif(btrim(coalesce(target_external_campaign_id, '')), '');
  campaign_notes text := nullif(btrim(coalesce(target_notes, '')), '');
  currency text := upper(btrim(coalesce(target_currency_code, 'INR')));
  existing public.marketing_campaigns%rowtype;
  saved public.marketing_campaigns%rowtype;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null
    or char_length(campaign_name) not between 2 and 180
    or coalesce(target_platform, '') not in ('META', 'GOOGLE_ADS', 'GOOGLE_BUSINESS_PROFILE', 'WEBSITE', 'OTHER')
    or coalesce(target_canonical_source, '') not in ('Facebook', 'Instagram', 'Google Ads', 'Website', 'WhatsApp Business', 'CarWale', 'CarDekho', 'Justdial', 'IndiaMART', 'Manual', 'Other')
    or coalesce(target_status, '') not in ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED')
    or (target_ends_on is not null and target_starts_on is not null and target_ends_on < target_starts_on)
    or (target_budget_amount is not null and (target_budget_amount < 0 or target_budget_amount > 999999999999.99))
    or currency !~ '^[A-Z]{3}$'
    or char_length(coalesce(external_ref, '')) > 200
    or char_length(coalesce(campaign_notes, '')) > 4000 then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_CAMPAIGN';
  end if;
  if target_branch_id is null then
    if not app_private.has_organization_wide_scope(current_organization_id) then
      raise exception using errcode = '42501', message = 'MARKETING_CAMPAIGN_SCOPE_DENIED';
    end if;
  elsif not exists (
    select 1 from public.branches branch_row
    where branch_row.organization_id = current_organization_id and branch_row.id = target_branch_id
  ) or not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'MARKETING_CAMPAIGN_SCOPE_DENIED';
  end if;

  if target_campaign_id is null then
    -- A retried create returns the campaign the first attempt made.
    select campaign_row.* into saved from public.audit_logs audit_row
    join public.marketing_campaigns campaign_row
      on campaign_row.organization_id = current_organization_id and campaign_row.id::text = audit_row.resource_id
    where audit_row.organization_id = current_organization_id
      and audit_row.request_id = target_request_id and audit_row.action = 'marketing_campaign.created';
    if found then
      return jsonb_build_object('campaign_id', saved.id, 'version', saved.version);
    end if;
    begin
      insert into public.marketing_campaigns (
        organization_id, branch_id, name, platform, canonical_source, external_campaign_id,
        status, starts_on, ends_on, budget_amount, currency_code, notes, created_by
      ) values (
        current_organization_id, target_branch_id, campaign_name, target_platform, target_canonical_source,
        external_ref, target_status, target_starts_on, target_ends_on, target_budget_amount, currency,
        campaign_notes, auth.uid()
      ) returning * into saved;
    exception when unique_violation then
      raise exception using errcode = 'PT409', message = 'MARKETING_CAMPAIGN_EXTERNAL_ID_TAKEN';
    end;
    insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, request_id, metadata)
    values (current_organization_id, auth.uid(), 'marketing_campaign.created', 'marketing_campaign', saved.id::text,
      target_request_id, jsonb_build_object('name', saved.name, 'platform', saved.platform, 'status', saved.status,
        'budget_amount', saved.budget_amount, 'branch_id', saved.branch_id));
    return jsonb_build_object('campaign_id', saved.id, 'version', saved.version);
  end if;

  select * into existing from public.marketing_campaigns campaign_row
  where campaign_row.organization_id = current_organization_id and campaign_row.id = target_campaign_id
    and campaign_row.deleted_at is null
  for update;
  if not found or not (
    (existing.branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
    or (existing.branch_id is not null and app_private.can_access_branch(current_organization_id, existing.branch_id))
  ) then
    raise exception using errcode = 'P0002', message = 'MARKETING_CAMPAIGN_NOT_FOUND';
  end if;
  if target_expected_version is null or existing.version <> target_expected_version then
    raise exception using errcode = 'PT409', message = 'MARKETING_CAMPAIGN_VERSION_CONFLICT';
  end if;
  begin
    update public.marketing_campaigns set
      branch_id = target_branch_id, name = campaign_name, platform = target_platform,
      canonical_source = target_canonical_source, external_campaign_id = external_ref,
      status = target_status, starts_on = target_starts_on, ends_on = target_ends_on,
      budget_amount = target_budget_amount, currency_code = currency, notes = campaign_notes,
      version = existing.version + 1, updated_at = now()
    where id = existing.id
    returning * into saved;
  exception when unique_violation then
    raise exception using errcode = 'PT409', message = 'MARKETING_CAMPAIGN_EXTERNAL_ID_TAKEN';
  end;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'marketing_campaign.updated', 'marketing_campaign', saved.id::text,
    target_request_id, jsonb_build_object(
      'before', jsonb_build_object('name', existing.name, 'status', existing.status, 'budget_amount', existing.budget_amount, 'branch_id', existing.branch_id),
      'after', jsonb_build_object('name', saved.name, 'status', saved.status, 'budget_amount', saved.budget_amount, 'branch_id', saved.branch_id)));
  return jsonb_build_object('campaign_id', saved.id, 'version', saved.version);
end;
$$;

-- Record one day's spend (and optionally impressions/clicks) by hand. A day a
-- provider sync already wrote is left alone, so a manual entry never masks the
-- ads account's own figures.
create or replace function public.record_marketing_campaign_metrics(
  target_campaign_id uuid,
  target_metric_date date,
  target_spend_amount numeric,
  target_impressions bigint,
  target_clicks bigint,
  target_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  campaign public.marketing_campaigns%rowtype;
  previous public.marketing_campaign_daily_metrics%rowtype;
  saved public.marketing_campaign_daily_metrics%rowtype;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.manage') then
    raise exception using errcode = '42501', message = 'MARKETING_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or target_metric_date is null
    or target_metric_date > today or target_metric_date < today - 730
    or target_spend_amount is null or target_spend_amount < 0 or target_spend_amount > 999999999999.99
    or (target_impressions is not null and target_impressions < 0)
    or (target_clicks is not null and target_clicks < 0)
    or (target_clicks is not null and target_impressions is not null and target_clicks > target_impressions) then
    raise exception using errcode = '22023', message = 'INVALID_MARKETING_CAMPAIGN_METRICS';
  end if;
  select * into campaign from public.marketing_campaigns campaign_row
  where campaign_row.organization_id = current_organization_id and campaign_row.id = target_campaign_id
    and campaign_row.deleted_at is null;
  if not found or not (
    (campaign.branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
    or (campaign.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign.branch_id))
  ) then
    raise exception using errcode = 'P0002', message = 'MARKETING_CAMPAIGN_NOT_FOUND';
  end if;

  select * into previous from public.marketing_campaign_daily_metrics metric_row
  where metric_row.organization_id = current_organization_id and metric_row.campaign_id = campaign.id
    and metric_row.metric_date = target_metric_date
  for update;
  if found and previous.data_source = 'PROVIDER_SYNC' then
    raise exception using errcode = 'PT409', message = 'PROVIDER_METRICS_LOCKED';
  end if;

  insert into public.marketing_campaign_daily_metrics (
    organization_id, campaign_id, metric_date, spend_amount, impressions, clicks, data_source, recorded_by
  ) values (
    current_organization_id, campaign.id, target_metric_date, round(target_spend_amount, 2),
    target_impressions, target_clicks, 'MANUAL', auth.uid()
  )
  on conflict on constraint marketing_campaign_metric_day_unique do update set
    spend_amount = excluded.spend_amount, impressions = excluded.impressions, clicks = excluded.clicks,
    recorded_by = excluded.recorded_by, updated_at = now()
  where public.marketing_campaign_daily_metrics.data_source = 'MANUAL'
  returning * into saved;
  if saved.id is null then
    raise exception using errcode = 'PT409', message = 'PROVIDER_METRICS_LOCKED';
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'marketing_campaign_metrics.recorded', 'marketing_campaign',
    campaign.id::text, target_request_id, jsonb_build_object(
      'metric_date', target_metric_date,
      'previous_spend', previous.spend_amount,
      'spend', saved.spend_amount, 'impressions', saved.impressions, 'clicks', saved.clicks));
  return jsonb_build_object('campaign_id', campaign.id, 'metric_date', saved.metric_date,
    'spend_amount', saved.spend_amount, 'currency_code', campaign.currency_code);
end;
$$;

-- The ad lead-source connections a marketing viewer can see, with how many ad
-- columns each has mapped. No credentials or connection settings are returned.
create or replace function public.get_marketing_lead_source_connections()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid := app_private.current_tenant_organization();
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.view') then
    raise exception using errcode = '42501', message = 'MARKETING_VIEW_PERMISSION_REQUIRED';
  end if;
  return jsonb_build_object(
    'can_map', app_private.has_permission(current_organization_id, 'marketing.manage')
      or app_private.has_permission(current_organization_id, 'integration.manage'),
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', connection_row.id,
        'provider_key', connection_row.provider_key,
        'display_name', connection_row.display_name,
        'status', connection_row.status,
        'scope_mode', connection_row.scope_mode,
        'last_sync_at', connection_row.last_sync_at,
        'mapping_count', (select count(*) from public.integration_field_mappings mapping_row
          where mapping_row.organization_id = current_organization_id
            and mapping_row.connected_account_id = connection_row.id)
      ) order by connection_row.display_name, connection_row.id)
      from public.connected_accounts connection_row
      where connection_row.organization_id = current_organization_id
        and connection_row.deleted_at is null
        and connection_row.provider_key = any (app_private.marketing_mappable_lead_providers())
        and (connection_row.scope_mode = 'ALL_BRANCHES' or exists (
          select 1 from public.integration_branch_mappings branch_mapping
          where branch_mapping.connected_account_id = connection_row.id
            and app_private.can_access_branch(current_organization_id, branch_mapping.branch_id)))
    ), '[]'::jsonb)
  );
end;
$$;

-- Field mapping: integration managers as before, and marketing managers for ad
-- lead-source connections only.
create or replace function public.get_integration_field_mappings(target_connection_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  current_organization_id uuid;
  connection_row public.connected_accounts%rowtype;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (app_private.has_permission(current_organization_id, 'integration.manage')
      or app_private.has_permission(current_organization_id, 'marketing.manage'))
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into connection_row from public.connected_accounts
  where id = target_connection_id and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'INTEGRATION_CONNECTION_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_organization_id, 'integration.manage')
    and not (connection_row.provider_key = any (app_private.marketing_mappable_lead_providers()))
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  return jsonb_build_object(
    'connection_id', connection_row.id,
    'provider_key', connection_row.provider_key,
    'canonical_fields', to_jsonb(app_private.canonical_lead_fields()),
    'mappings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mapping_row.id,
        'external_field', mapping_row.external_field,
        'canonical_field', mapping_row.canonical_field,
        'transform_config', mapping_row.transform_config
      ) order by mapping_row.canonical_field, mapping_row.external_field)
      from public.integration_field_mappings mapping_row
      where mapping_row.connected_account_id = connection_row.id
        and mapping_row.organization_id = current_organization_id
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.save_integration_field_mappings(target_connection_id uuid, target_mappings jsonb, target_request_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  current_organization_id uuid;
  connection_row public.connected_accounts%rowtype;
  normalized jsonb := coalesce(target_mappings, '[]'::jsonb);
  saved integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (app_private.has_permission(current_organization_id, 'integration.manage')
      or app_private.has_permission(current_organization_id, 'marketing.manage'))
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or jsonb_typeof(normalized) <> 'array'
    or jsonb_array_length(normalized) > 100
  then
    raise exception using errcode = '22023', message = 'INVALID_FIELD_MAPPING_INPUT';
  end if;

  select * into connection_row from public.connected_accounts
  where id = target_connection_id and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'INTEGRATION_CONNECTION_NOT_FOUND';
  end if;
  -- Marketing managers map ad lead-source columns only; every other provider
  -- stays with integration managers.
  if not app_private.has_permission(current_organization_id, 'integration.manage')
    and not (connection_row.provider_key = any (app_private.marketing_mappable_lead_providers()))
  then
    raise exception using errcode = '42501', message = 'INTEGRATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  if connection_row.scope_mode <> 'ALL_BRANCHES' and not exists (
    select 1 from public.integration_branch_mappings branch_mapping
    join public.branches branch_row on branch_row.id = branch_mapping.branch_id
    where branch_mapping.connected_account_id = connection_row.id
      and app_private.can_access_branch(current_organization_id, branch_row.id)
  ) then
    raise exception using errcode = '42501', message = 'INTEGRATION_SCOPE_DENIED';
  end if;

  -- Validated before anything is written, so an invalid entry leaves the
  -- existing mapping untouched instead of half-replacing it.
  if exists (
    select 1 from jsonb_array_elements(normalized) as entry
    where jsonb_typeof(entry) <> 'object'
      or char_length(btrim(coalesce(entry ->> 'external_field', ''))) not between 1 and 200
      or not (entry ->> 'canonical_field' = any (app_private.canonical_lead_fields()))
      or jsonb_typeof(coalesce(entry -> 'transform_config', '{}'::jsonb)) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_FIELD_MAPPING_ENTRY';
  end if;
  -- The table is unique on (connected_account_id, external_field); a duplicate
  -- in the payload would otherwise fail mid-write.
  if (
    select count(distinct btrim(entry ->> 'external_field'))
    from jsonb_array_elements(normalized) as entry
  ) <> jsonb_array_length(normalized) then
    raise exception using errcode = '22023', message = 'DUPLICATE_EXTERNAL_FIELD';
  end if;

  delete from public.integration_field_mappings
  where connected_account_id = connection_row.id
    and organization_id = current_organization_id;
  insert into public.integration_field_mappings (
    organization_id, connected_account_id, external_field, canonical_field, transform_config
  )
  select current_organization_id, connection_row.id,
    btrim(entry ->> 'external_field'), entry ->> 'canonical_field',
    coalesce(entry -> 'transform_config', '{}'::jsonb)
  from jsonb_array_elements(normalized) as entry;
  get diagnostics saved = row_count;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'integration_field_mappings.saved',
    'connected_account', connection_row.id::text, target_request_id,
    jsonb_build_object('mapping_count', saved, 'provider_key', connection_row.provider_key)
  );
  return jsonb_build_object('connection_id', connection_row.id, 'mapping_count', saved);
end;
$function$;

revoke all on function app_private.marketing_mappable_lead_providers() from public, anon, authenticated;
revoke all on function app_private.marketing_campaign_stats(uuid) from public, anon, authenticated;
revoke all on function public.save_marketing_campaign(uuid, bigint, text, text, text, text, uuid, date, date, numeric, text, text, text, uuid) from public, anon;
grant execute on function public.save_marketing_campaign(uuid, bigint, text, text, text, text, uuid, date, date, numeric, text, text, text, uuid) to authenticated;
revoke all on function public.record_marketing_campaign_metrics(uuid, date, numeric, bigint, bigint, uuid) from public, anon;
grant execute on function public.record_marketing_campaign_metrics(uuid, date, numeric, bigint, bigint, uuid) to authenticated;
revoke all on function public.get_marketing_lead_source_connections() from public, anon;
grant execute on function public.get_marketing_lead_source_connections() to authenticated;
revoke all on function public.get_marketing_workspace_page(text, text, integer, integer, text, text) from public, anon;
grant execute on function public.get_marketing_workspace_page(text, text, integer, integer, text, text) to authenticated;

commit;
