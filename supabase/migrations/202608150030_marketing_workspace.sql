begin;

insert into public.permissions (permission_key, module, description) values
  ('marketing.view', 'marketing', 'View source, campaign and social performance within authorized scope'),
  ('marketing.manage', 'marketing', 'Create and maintain campaign records within authorized scope'),
  ('marketing.social.manage', 'marketing', 'Create and schedule provider-safe social post drafts')
on conflict (permission_key) do update
set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row cross join public.permissions permission_row
where role_row.organization_id is not null and role_row.system_role
  and (
    (role_row.role_key = 'digital_marketing_manager'
      and permission_row.permission_key in ('marketing.view', 'marketing.manage', 'marketing.social.manage'))
    or (role_row.role_key in ('client_admin', 'system_administrator')
      and permission_row.permission_key in ('marketing.view', 'marketing.manage', 'marketing.social.manage'))
    or (role_row.role_key in ('business_owner', 'gm_sales')
      and permission_row.permission_key = 'marketing.view')
  )
on conflict do nothing;

create or replace function app_private.apply_default_marketing_permissions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_id is not null and new.system_role then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id from public.permissions permission_row
    where permission_row.permission_key = any(case
      when new.role_key in ('digital_marketing_manager', 'client_admin', 'system_administrator')
        then array['marketing.view', 'marketing.manage', 'marketing.social.manage']
      when new.role_key in ('business_owner', 'gm_sales') then array['marketing.view']
      else '{}'::text[] end)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists roles_apply_default_marketing_permissions on public.roles;
create trigger roles_apply_default_marketing_permissions after insert or update of role_key, system_role
on public.roles for each row execute function app_private.apply_default_marketing_permissions();

create table public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  connected_account_id uuid references public.connected_accounts(id),
  name text not null,
  platform text not null,
  canonical_source text not null,
  external_campaign_id text,
  status text not null default 'DRAFT',
  starts_on date,
  ends_on date,
  budget_amount numeric(14,2),
  currency_code text not null default 'INR',
  notes text,
  version bigint not null default 1,
  created_by uuid not null references public.profiles(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (char_length(btrim(name)) between 2 and 180),
  check (platform in ('META', 'GOOGLE_ADS', 'GOOGLE_BUSINESS_PROFILE', 'WEBSITE', 'OTHER')),
  check (canonical_source in ('Facebook', 'Instagram', 'Google Ads', 'Website', 'WhatsApp Business', 'CarWale', 'CarDekho', 'Justdial', 'IndiaMART', 'Manual', 'Other')),
  check (status in ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED')),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check (budget_amount is null or budget_amount >= 0),
  check (currency_code ~ '^[A-Z]{3}$'),
  check (notes is null or char_length(notes) <= 4000),
  check (version > 0)
);
create unique index marketing_campaign_external_org_unique_idx
  on public.marketing_campaigns (organization_id, connected_account_id, external_campaign_id)
  where connected_account_id is not null and external_campaign_id is not null and deleted_at is null;
create index marketing_campaign_workspace_idx
  on public.marketing_campaigns (organization_id, branch_id, status, updated_at desc, id desc)
  where deleted_at is null;
create unique index marketing_campaigns_org_id_unique_idx on public.marketing_campaigns (organization_id, id);
alter table public.marketing_campaigns
  add constraint marketing_campaign_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint marketing_campaign_account_org_fk foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid,
  add constraint marketing_campaign_creator_org_fk foreign key (organization_id, created_by)
  references public.profiles (organization_id, id) not valid;

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  connected_account_id uuid references public.connected_accounts(id),
  campaign_id uuid references public.marketing_campaigns(id),
  platform text not null,
  content text not null,
  media_object_file_ids jsonb not null default '[]'::jsonb,
  status text not null default 'DRAFT',
  scheduled_for timestamptz,
  published_at timestamptz,
  provider_post_id text,
  safe_error_code text,
  version bigint not null default 1,
  created_by uuid not null references public.profiles(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (platform in ('FACEBOOK', 'INSTAGRAM', 'GOOGLE_BUSINESS_PROFILE', 'OTHER')),
  check (char_length(btrim(content)) between 1 and 5000),
  check (jsonb_typeof(media_object_file_ids) = 'array' and jsonb_array_length(media_object_file_ids) <= 10),
  check (status in ('DRAFT', 'SCHEDULED', 'PUBLISH_REQUESTED', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  check (scheduled_for is null or status in ('SCHEDULED', 'PUBLISH_REQUESTED', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  check (published_at is null or status = 'PUBLISHED'),
  check (version > 0)
);
create index social_post_workspace_idx
  on public.social_posts (organization_id, branch_id, status, scheduled_for, updated_at desc, id desc)
  where deleted_at is null;
create unique index social_posts_org_id_unique_idx on public.social_posts (organization_id, id);
alter table public.social_posts
  add constraint social_post_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint social_post_account_org_fk foreign key (organization_id, connected_account_id)
  references public.connected_accounts (organization_id, id) not valid,
  add constraint social_post_campaign_org_fk foreign key (organization_id, campaign_id)
  references public.marketing_campaigns (organization_id, id) not valid,
  add constraint social_post_creator_org_fk foreign key (organization_id, created_by)
  references public.profiles (organization_id, id) not valid;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order) values
  -- Social posts reference campaigns, and campaigns may reference connections.
  -- Their order must be unique and precede connected_accounts (790).
  ('social_posts', 'DELETE', 785), ('marketing_campaigns', 'DELETE', 786)
on conflict (table_name) do update set disposition = excluded.disposition, delete_order = excluded.delete_order;

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
    with source_rows as materialized (
      select lead_row.source as source, count(*) as leads,
        count(*) filter (where lead_row.lifecycle_status in ('Qualified', 'Appointment Scheduled', 'Transferred to Sales')) as qualified,
        count(*) filter (where exists (select 1 from public.test_drives drive_row where drive_row.organization_id = lead_row.organization_id and drive_row.lead_id = lead_row.id)) as test_drives,
        count(*) filter (where exists (select 1 from public.quotations quotation_row where quotation_row.organization_id = lead_row.organization_id and quotation_row.lead_id = lead_row.id and quotation_row.deleted_at is null)) as quotations,
        count(*) filter (where exists (select 1 from public.bookings booking_row where booking_row.organization_id = lead_row.organization_id and booking_row.lead_id = lead_row.id and booking_row.deleted_at is null)) as bookings
      from public.leads lead_row where lead_row.organization_id = current_organization_id and lead_row.deleted_at is null
        and app_private.can_access_lead(lead_row.id)
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

alter table public.marketing_campaigns enable row level security;
alter table public.marketing_campaigns force row level security;
alter table public.social_posts enable row level security;
alter table public.social_posts force row level security;
create policy marketing_campaigns_read on public.marketing_campaigns for select to authenticated using (
  deleted_at is null and app_private.has_permission(organization_id, 'marketing.view')
  and ((branch_id is null and app_private.has_organization_wide_scope(organization_id)) or (branch_id is not null and app_private.can_access_branch(organization_id, branch_id))));
create policy social_posts_read on public.social_posts for select to authenticated using (
  deleted_at is null and app_private.has_permission(organization_id, 'marketing.view')
  and ((branch_id is null and app_private.has_organization_wide_scope(organization_id)) or (branch_id is not null and app_private.can_access_branch(organization_id, branch_id))));
revoke insert, update, delete, truncate on public.marketing_campaigns from anon, authenticated;
revoke insert, update, delete, truncate on public.social_posts from anon, authenticated;

-- Preserve existing private topics and add Marketing visibility only for marketing viewers.
create or replace function app_private.realtime_topic_organization()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare current_topic text; topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(current_topic,
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales|operations|customer-care|marketing)$');
  return case when topic_match is null then null else topic_match[1]::uuid end;
exception when others then return null; end;
$$;
create or replace function app_private.realtime_topic_resource()
returns text language plpgsql stable security definer set search_path = '' as $$
declare current_topic text; topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(current_topic,
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support|administration|inventory|sales|operations|customer-care|marketing)$');
  return case when topic_match is null then null else topic_match[1] end;
exception when others then return null; end;
$$;
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists crm_tenant_broadcast_read on realtime.messages';
    execute $policy$
      create policy crm_tenant_broadcast_read on realtime.messages for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and app_private.can_access_organization(app_private.realtime_topic_organization())
        and case app_private.realtime_topic_resource()
          when 'leads' then app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view')
          when 'customers' then app_private.has_permission(app_private.realtime_topic_organization(), 'customer.view')
          when 'communications' then app_private.has_permission(app_private.realtime_topic_organization(), 'message.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'call.view')
          when 'work' then app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'followup.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'appointment.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'task.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'test_drive.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'test_drive.manage')
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(app_private.realtime_topic_organization(), 'integration.view')
          when 'support' then app_private.has_permission(app_private.realtime_topic_organization(), 'support.request') or app_private.has_permission(app_private.realtime_topic_organization(), 'support.approve')
          when 'administration' then app_private.tenant_user_mode_allowed(auth.uid(), 'CLIENT_ADMIN_BOOTSTRAP') or app_private.has_permission(app_private.realtime_topic_organization(), 'branch.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'team.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'user.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'role.manage')
          when 'inventory' then app_private.has_permission(app_private.realtime_topic_organization(), 'inventory.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'inventory.stock_check')
          when 'sales' then app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'quotation.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'booking.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'booking.manage')
          when 'operations' then app_private.has_permission(app_private.realtime_topic_organization(), 'finance.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'finance.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'insurance.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'insurance.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'rto.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'rto.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'exchange.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'exchange.manage') or app_private.has_permission(app_private.realtime_topic_organization(), 'delivery.view') or app_private.has_permission(app_private.realtime_topic_organization(), 'delivery.manage')
          when 'customer-care' then app_private.has_permission(app_private.realtime_topic_organization(), 'customer_care.view')
          when 'marketing' then app_private.has_permission(app_private.realtime_topic_organization(), 'marketing.view')
          else false
        end
      )
    $policy$;
  end if;
end $$;
drop trigger if exists realtime_marketing_campaigns_invalidate on public.marketing_campaigns;
create trigger realtime_marketing_campaigns_invalidate after insert or update on public.marketing_campaigns
for each row execute function app_private.broadcast_tenant_invalidation('marketing');
drop trigger if exists realtime_social_posts_invalidate on public.social_posts;
create trigger realtime_social_posts_invalidate after insert or update on public.social_posts
for each row execute function app_private.broadcast_tenant_invalidation('marketing');

alter table public.marketing_campaigns validate constraint marketing_campaign_branch_org_fk;
alter table public.marketing_campaigns validate constraint marketing_campaign_account_org_fk;
alter table public.marketing_campaigns validate constraint marketing_campaign_creator_org_fk;
alter table public.social_posts validate constraint social_post_branch_org_fk;
alter table public.social_posts validate constraint social_post_account_org_fk;
alter table public.social_posts validate constraint social_post_campaign_org_fk;
alter table public.social_posts validate constraint social_post_creator_org_fk;
revoke all on function public.get_marketing_workspace_page(text, text, integer, integer, text, text) from public, anon;
grant execute on function public.get_marketing_workspace_page(text, text, integer, integer, text, text) to authenticated;
revoke all on function app_private.apply_default_marketing_permissions() from public, anon, authenticated;
commit;
