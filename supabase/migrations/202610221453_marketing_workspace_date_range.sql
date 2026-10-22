-- Date range on the marketing workspace (Lead sources, Campaigns, Social posts,
-- dashboard and Performance all read get_marketing_workspace_page).
--
-- target_from / target_to are whole days in target_timezone, both or neither;
-- neither keeps today's all-time behaviour, so the deployed client that does not
-- send them is unaffected. A lead counts for the day it arrived (source rows,
-- campaign leads and their bookings follow the lead), spend counts by metric
-- date, posts by when they were published (or scheduled, or drafted), and
-- review requests by when they were raised. Campaign rows themselves are not
-- hidden by the range: a campaign with no leads in it still lists, with zeros.
--
-- Both functions are patched from their deployed definitions. New parameters
-- carry defaults, so the old signatures are dropped rather than overloaded,
-- which PostgREST could not resolve.

begin;

drop function if exists app_private.marketing_campaign_stats(uuid);
drop function if exists public.get_marketing_workspace_page(text, text, integer, integer, text, text);

CREATE OR REPLACE FUNCTION app_private.marketing_campaign_stats(target_organization_id uuid, target_from date DEFAULT NULL::date, target_to date DEFAULT NULL::date, target_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS TABLE(stat_campaign_id uuid, stat_leads bigint, stat_qualified bigint, stat_bookings bigint, stat_spend numeric, stat_impressions bigint, stat_clicks bigint, stat_spend_days bigint, stat_last_metric_date date, stat_has_provider_metrics boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- A lead counts for the period it arrived in, in the dealership's timezone.
      and (target_from is null or lead_row.created_at >= (target_from::timestamp at time zone target_timezone))
      and (target_to is null or lead_row.created_at < ((target_to + 1)::timestamp at time zone target_timezone))
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
      and (target_from is null or metric_row.metric_date >= target_from)
      and (target_to is null or metric_row.metric_date <= target_to)
    group by metric_row.campaign_id
  )
  select campaign.id, coalesce(lead_totals.leads, 0), coalesce(lead_totals.qualified, 0),
    coalesce(lead_totals.bookings, 0), metric_totals.spend, metric_totals.impressions,
    metric_totals.clicks, coalesce(metric_totals.spend_days, 0), metric_totals.last_metric_date,
    coalesce(metric_totals.has_provider, false)
  from campaigns campaign
  left join lead_totals on lead_totals.campaign_ref = campaign.id
  left join metric_totals on metric_totals.campaign_ref = campaign.id
$function$;

CREATE OR REPLACE FUNCTION public.get_marketing_workspace_page(target_view text DEFAULT 'CAMPAIGNS'::text, target_search text DEFAULT ''::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_sort text DEFAULT 'updated:desc'::text, target_timezone text DEFAULT 'Asia/Kolkata'::text, target_from date DEFAULT NULL::date, target_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid; normalized_view text := upper(btrim(coalesce(target_view, 'CAMPAIGNS'))); normalized_search text := lower(btrim(coalesce(target_search, ''))); result jsonb; can_manage boolean;
  range_start timestamptz; range_end timestamptz;
begin
  if normalized_view not in ('SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS') or char_length(normalized_search) > 160
    or target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100)
    or target_sort not in ('updated:desc', 'created:desc', 'name:asc', 'status:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or (target_from is null) <> (target_to is null) or target_to < target_from
    then raise exception using errcode = '22023', message = 'INVALID_MARKETING_QUERY'; end if;
  -- Both bounds are whole days in the requested timezone; no range means all time.
  range_start := target_from::timestamp at time zone target_timezone;
  range_end := (target_to + 1)::timestamp at time zone target_timezone;
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
        and (range_start is null or (lead_row.created_at >= range_start and lead_row.created_at < range_end))
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
      from app_private.marketing_campaign_stats(current_organization_id, target_from, target_to, target_timezone) stat_row
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
        'review_requests', (select count(*) from public.customer_care_cases case_row where case_row.organization_id = current_organization_id and case_row.case_type = 'REVIEW_REQUEST' and case_row.deleted_at is null and (range_start is null or (case_row.created_at >= range_start and case_row.created_at < range_end)) and app_private.can_access_record(case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id) and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)),
        'posts_published', (select count(*) from public.social_posts post_row where post_row.organization_id = current_organization_id and post_row.status = 'PUBLISHED' and post_row.deleted_at is null and (range_start is null or (post_row.published_at >= range_start and post_row.published_at < range_end)) and (post_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or post_row.branch_id is not null and app_private.can_access_branch(current_organization_id, post_row.branch_id))),
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
      select * from app_private.marketing_campaign_stats(current_organization_id, target_from, target_to, target_timezone)
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
    with authorized as materialized (select post_row.* from public.social_posts post_row where post_row.organization_id = current_organization_id and post_row.deleted_at is null and (range_start is null or (coalesce(post_row.published_at, post_row.scheduled_for, post_row.created_at) >= range_start and coalesce(post_row.published_at, post_row.scheduled_for, post_row.created_at) < range_end)) and (post_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or post_row.branch_id is not null and app_private.can_access_branch(current_organization_id, post_row.branch_id)) and (normalized_search = '' or position(normalized_search in lower(post_row.content)) > 0 or position(normalized_search in lower(post_row.platform)) > 0)), ordered as (select *, row_number() over (order by case when target_sort = 'status:asc' then status end asc, case when target_sort = 'created:desc' then created_at end desc, updated_at desc, id desc) as page_order from authorized), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size)
    select jsonb_build_object('organization_id', current_organization_id, 'view', normalized_view, 'can_manage', can_manage, 'records', coalesce((select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_order) from page_rows page_row), '[]'::jsonb), 'total', (select count(*) from authorized)) into result;
  end if;
  return result;
end;
$function$;

revoke all on function app_private.marketing_campaign_stats(uuid, date, date, text) from public, anon, authenticated;
revoke all on function public.get_marketing_workspace_page(text, text, integer, integer, text, text, date, date) from public, anon;
grant execute on function public.get_marketing_workspace_page(text, text, integer, integer, text, text, date, date) to authenticated, service_role;

commit;
