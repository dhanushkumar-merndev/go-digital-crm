-- Marketing performance timed out while calling can_access_lead for every lead.
-- Evaluate the same lead.view + can_access_record boundary once per distinct
-- branch/team/owner tuple. Keep tenant, soft-deletion and search predicates,
-- source attribution, pagination and the campaign/social paths unchanged.
begin;

create index if not exists test_drives_org_lead_performance_idx
  on public.test_drives (organization_id, lead_id);

create or replace function public.get_marketing_workspace_page(
  target_view text default 'CAMPAIGNS', target_search text default '', target_page integer default 1,
  target_page_size integer default 25, target_sort text default 'updated:desc', target_timezone text default 'Asia/Kolkata'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid; normalized_view text := upper(btrim(coalesce(target_view, 'CAMPAIGNS'))); normalized_search text := lower(btrim(coalesce(target_search, ''))); result jsonb;
begin
  if normalized_view not in ('SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS') or char_length(normalized_search) > 160
    or target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100)
    or target_sort not in ('updated:desc', 'created:desc', 'name:asc', 'status:asc')
    or target_timezone not in ('Asia/Kolkata', 'UTC') then raise exception using errcode = '22023', message = 'INVALID_MARKETING_QUERY'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not app_private.has_permission(current_organization_id, 'marketing.view') then
    raise exception using errcode = '42501', message = 'MARKETING_VIEW_PERMISSION_REQUIRED'; end if;
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
    ), ordered as (select *, row_number() over (order by case when target_sort = 'name:asc' then source end asc, leads desc, source asc) as page_order from source_rows), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size)
    select jsonb_build_object(
      'organization_id', current_organization_id, 'view', normalized_view,
      'records', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'leads', leads, 'qualified', qualified, 'test_drives', test_drives, 'quotations', quotations, 'bookings', bookings, 'conversion', case when leads = 0 then 0 else round(bookings::numeric * 100 / leads, 1) end) order by page_order) from page_rows), '[]'::jsonb),
      'total', (select count(*) from source_rows),
      'kpis', jsonb_build_object(
        'leads_generated', coalesce((select sum(leads) from source_rows), 0),
        'qualified_leads', coalesce((select sum(qualified) from source_rows), 0),
        'bookings', coalesce((select sum(bookings) from source_rows), 0),
        'conversion_percent', coalesce((select round(sum(bookings)::numeric * 100 / nullif(sum(leads), 0), 1) from source_rows), 0),
        'active_campaigns', (select count(*) from public.marketing_campaigns campaign_row where campaign_row.organization_id = current_organization_id and campaign_row.status = 'ACTIVE' and campaign_row.deleted_at is null and (campaign_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or campaign_row.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign_row.branch_id))),
        'review_requests', (select count(*) from public.customer_care_cases case_row where case_row.organization_id = current_organization_id and case_row.case_type = 'REVIEW_REQUEST' and case_row.deleted_at is null and app_private.can_access_record(case_row.organization_id, case_row.branch_id, null, case_row.assigned_user_id) and app_private.can_access_customer(case_row.organization_id, case_row.customer_id)),
        'posts_published', (select count(*) from public.social_posts post_row where post_row.organization_id = current_organization_id and post_row.status = 'PUBLISHED' and post_row.deleted_at is null and (post_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or post_row.branch_id is not null and app_private.can_access_branch(current_organization_id, post_row.branch_id)))
      ),
      'source_chart', coalesce((select jsonb_agg(jsonb_build_object('name', source, 'value', leads, 'secondary', bookings) order by leads desc) from source_rows), '[]'::jsonb),
      'funnel_chart', jsonb_build_array(
        jsonb_build_object('name', 'Leads', 'value', coalesce((select sum(leads) from source_rows), 0)),
        jsonb_build_object('name', 'Qualified', 'value', coalesce((select sum(qualified) from source_rows), 0)),
        jsonb_build_object('name', 'Bookings', 'value', coalesce((select sum(bookings) from source_rows), 0))
      )
    ) into result;
  elsif normalized_view = 'CAMPAIGNS' then
    with authorized as materialized (select campaign_row.* from public.marketing_campaigns campaign_row where campaign_row.organization_id = current_organization_id and campaign_row.deleted_at is null and (campaign_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or campaign_row.branch_id is not null and app_private.can_access_branch(current_organization_id, campaign_row.branch_id)) and (normalized_search = '' or position(normalized_search in lower(campaign_row.name)) > 0 or position(normalized_search in lower(campaign_row.canonical_source)) > 0)), ordered as (select *, row_number() over (order by case when target_sort = 'name:asc' then name end asc, case when target_sort = 'status:asc' then status end asc, case when target_sort = 'created:desc' then created_at end desc, updated_at desc, id desc) as page_order from authorized), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size)
    select jsonb_build_object('organization_id', current_organization_id, 'view', normalized_view, 'records', coalesce((select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_order) from page_rows page_row), '[]'::jsonb), 'total', (select count(*) from authorized)) into result;
  else
    with authorized as materialized (select post_row.* from public.social_posts post_row where post_row.organization_id = current_organization_id and post_row.deleted_at is null and (post_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id) or post_row.branch_id is not null and app_private.can_access_branch(current_organization_id, post_row.branch_id)) and (normalized_search = '' or position(normalized_search in lower(post_row.content)) > 0 or position(normalized_search in lower(post_row.platform)) > 0)), ordered as (select *, row_number() over (order by case when target_sort = 'status:asc' then status end asc, case when target_sort = 'created:desc' then created_at end desc, updated_at desc, id desc) as page_order from authorized), page_rows as (select * from ordered order by page_order limit target_page_size offset (target_page - 1) * target_page_size)
    select jsonb_build_object('organization_id', current_organization_id, 'view', normalized_view, 'records', coalesce((select jsonb_agg(to_jsonb(page_row) - 'page_order' order by page_order) from page_rows page_row), '[]'::jsonb), 'total', (select count(*) from authorized)) into result;
  end if;
  return result;
end;
$$;

revoke all on function public.get_marketing_workspace_page(text, text, integer, integer, text, text) from public, anon;
grant execute on function public.get_marketing_workspace_page(text, text, integer, integer, text, text) to authenticated;

commit;
