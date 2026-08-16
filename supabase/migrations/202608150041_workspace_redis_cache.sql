begin;

-- Redis entries are disposable. This small database-side version ledger makes
-- every cache key obsolete as soon as the underlying authorized data changes.
create table if not exists public.workspace_cache_versions (
  scope_key text not null,
  resource_key text not null check (
    resource_key in ('tenant-dashboard', 'inventory-dashboard', 'platform-dashboard')
  ),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (scope_key, resource_key),
  check (scope_key = 'platform' or scope_key ~ '^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

alter table public.workspace_cache_versions enable row level security;
revoke all on public.workspace_cache_versions from public, anon, authenticated;

create or replace function app_private.bump_workspace_cache_version(
  target_organization_id uuid,
  target_resource_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare resolved_scope_key text;
begin
  if target_resource_key not in ('tenant-dashboard', 'inventory-dashboard', 'platform-dashboard') then
    raise exception using errcode = '22023', message = 'INVALID_WORKSPACE_CACHE_RESOURCE';
  end if;
  if target_resource_key = 'platform-dashboard' then
    resolved_scope_key := 'platform';
  elsif target_organization_id is not null then
    resolved_scope_key := 'tenant:' || target_organization_id::text;
  else
    return;
  end if;

  insert into public.workspace_cache_versions as cache_version (
    scope_key, resource_key, version, updated_at
  ) values (
    resolved_scope_key, target_resource_key, 1, now()
  ) on conflict (scope_key, resource_key) do update
    set version = cache_version.version + 1,
        updated_at = excluded.updated_at;
end;
$$;

create or replace function app_private.bump_workspace_cache_versions_from_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_organization_id uuid;
declare target_resource_key text;
begin
  target_organization_id := coalesce(new.organization_id, old.organization_id);
  foreach target_resource_key in array string_to_array(coalesce(tg_argv[0], ''), ',') loop
    perform app_private.bump_workspace_cache_version(target_organization_id, target_resource_key);
  end loop;
  return coalesce(new, old);
end;
$$;

create or replace function app_private.bump_platform_cache_version_from_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.bump_workspace_cache_version(null, 'platform-dashboard');
  return coalesce(new, old);
end;
$$;

-- Keep cache invalidation narrow and table-owned. These are dashboard inputs,
-- not an attempt to turn Redis into a second CRM database.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'leads', 'lead_assignments', 'followups', 'appointments', 'calls',
    'test_drive_appointments', 'bookings', 'quotations', 'stock_units',
    'stock_allocations', 'finance_cases', 'insurance_cases', 'rto_cases',
    'exchange_cases', 'delivery_cases'
  ] loop
    execute format('drop trigger if exists workspace_cache_tenant_dashboard on public.%I', table_name);
    execute format(
      'create trigger workspace_cache_tenant_dashboard after insert or update or delete on public.%I for each row execute function app_private.bump_workspace_cache_versions_from_row(''tenant-dashboard'')',
      table_name
    );
  end loop;

  foreach table_name in array array['stock_units', 'stock_allocations', 'vehicle_models', 'vehicle_variants', 'branches'] loop
    execute format('drop trigger if exists workspace_cache_inventory_dashboard on public.%I', table_name);
    execute format(
      'create trigger workspace_cache_inventory_dashboard after insert or update or delete on public.%I for each row execute function app_private.bump_workspace_cache_versions_from_row(''inventory-dashboard'')',
      table_name
    );
  end loop;

  foreach table_name in array array['organization_onboarding_submissions', 'connected_accounts', 'support_access_requests'] loop
    execute format('drop trigger if exists workspace_cache_platform_dashboard on public.%I', table_name);
    execute format(
      'create trigger workspace_cache_platform_dashboard after insert or update or delete on public.%I for each row execute function app_private.bump_workspace_cache_versions_from_row(''platform-dashboard'')',
      table_name
    );
  end loop;
end;
$$;

drop trigger if exists workspace_cache_platform_dashboard on public.organizations;
create trigger workspace_cache_platform_dashboard
after insert or update or delete on public.organizations
for each row execute function app_private.bump_platform_cache_version_from_row();

-- This returns only authorization/scope metadata to an authenticated Edge
-- function. It never exposes a cache key or cache value to the browser.
create or replace function public.get_workspace_cache_context(target_resource_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare access_context jsonb;
declare assignment_row public.user_role_assignments%rowtype;
declare role_key_value text;
declare branch_ids uuid[] := '{}';
declare team_ids uuid[] := '{}';
declare permissions_fingerprint text;
declare scope_subject jsonb;
declare cache_version bigint;
declare current_organization_id uuid;
declare can_view_dashboard boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_resource_key not in ('tenant-dashboard', 'inventory-dashboard', 'platform-dashboard') then
    raise exception using errcode = '22023', message = 'INVALID_WORKSPACE_CACHE_RESOURCE';
  end if;

  if target_resource_key = 'platform-dashboard' then
    if not app_private.is_platform_admin() or not app_private.mfa_policy_satisfied(null) then
      raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
    end if;
    select version into cache_version
    from public.workspace_cache_versions
    where scope_key = 'platform' and resource_key = target_resource_key;
    return jsonb_build_object(
      'resource', target_resource_key,
      'scope_key', 'platform',
      'scope_subject', jsonb_build_object('kind', 'PLATFORM'),
      'role_key', 'super-admin',
      'permissions_fingerprint', 'platform-aal2',
      'version', coalesce(cache_version, 1)
    );
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM' or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'CRM_ACCESS_CONTEXT_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  select ura.*
  into assignment_row
  from public.user_role_assignments ura
  join public.roles role_row on role_row.id = ura.role_id
  where ura.user_id = auth.uid() and ura.organization_id = current_organization_id and ura.active
  order by role_row.authority_level desc, ura.created_at desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'CRM_ROLE_ASSIGNMENT_REQUIRED';
  end if;
  select role_row.role_key into role_key_value
  from public.roles role_row
  where role_row.id = assignment_row.role_id;

  if target_resource_key = 'inventory-dashboard' then
    can_view_dashboard := app_private.has_permission(current_organization_id, 'inventory.view');
  else
    can_view_dashboard := app_private.has_permission(current_organization_id, 'lead.view')
      or app_private.has_permission(current_organization_id, 'call.view')
      or app_private.has_permission(current_organization_id, 'followup.view')
      or app_private.has_permission(current_organization_id, 'appointment.view')
      or app_private.has_permission(current_organization_id, 'booking.view')
      or app_private.has_permission(current_organization_id, 'booking.manage')
      or app_private.has_permission(current_organization_id, 'inventory.view')
      or app_private.has_permission(current_organization_id, 'inventory.stock_check')
      or app_private.has_permission(current_organization_id, 'test_drive.view')
      or app_private.has_permission(current_organization_id, 'test_drive.manage')
      or app_private.has_permission(current_organization_id, 'finance.view')
      or app_private.has_permission(current_organization_id, 'finance.manage')
      or app_private.has_permission(current_organization_id, 'insurance.view')
      or app_private.has_permission(current_organization_id, 'insurance.manage')
      or app_private.has_permission(current_organization_id, 'rto.view')
      or app_private.has_permission(current_organization_id, 'rto.manage')
      or app_private.has_permission(current_organization_id, 'exchange.view')
      or app_private.has_permission(current_organization_id, 'exchange.manage')
      or app_private.has_permission(current_organization_id, 'delivery.view')
      or app_private.has_permission(current_organization_id, 'delivery.manage');
  end if;
  if not can_view_dashboard then
    raise exception using errcode = '42501', message = 'WORKSPACE_CACHE_PERMISSION_REQUIRED';
  end if;

  select coalesce(array_agg(access_row.branch_id order by access_row.branch_id), '{}')
  into branch_ids
  from public.user_branch_access access_row
  where access_row.organization_id = current_organization_id and access_row.user_id = auth.uid();
  select coalesce(array_agg(member_row.team_id order by member_row.team_id), '{}')
  into team_ids
  from public.team_members member_row
  where member_row.organization_id = current_organization_id
    and member_row.user_id = auth.uid()
    and member_row.active;
  select coalesce(pg_catalog.md5(string_agg(permission_row.permission_key, ',' order by permission_row.permission_key)), 'none')
  into permissions_fingerprint
  from public.role_permissions role_permission
  join public.permissions permission_row on permission_row.id = role_permission.permission_id
  where role_permission.role_id = assignment_row.role_id;
  select version into cache_version
  from public.workspace_cache_versions
  where scope_key = 'tenant:' || current_organization_id::text
    and resource_key = target_resource_key;

  scope_subject := case assignment_row.data_scope::text
    when 'OWN_RECORDS' then jsonb_build_object('kind', 'OWN_RECORDS', 'user_id', auth.uid())
    when 'OWN_TEAM' then jsonb_build_object('kind', 'OWN_TEAM', 'team_ids', to_jsonb(team_ids))
    when 'ONE_BRANCH' then jsonb_build_object('kind', 'ONE_BRANCH', 'branch_ids', to_jsonb(array[assignment_row.scope_branch_id]))
    when 'SELECTED_BRANCHES' then jsonb_build_object('kind', 'SELECTED_BRANCHES', 'branch_ids', to_jsonb(assignment_row.selected_branch_ids))
    else jsonb_build_object('kind', assignment_row.data_scope::text, 'branch_ids', to_jsonb(branch_ids))
  end;

  return jsonb_build_object(
    'resource', target_resource_key,
    'scope_key', 'tenant:' || current_organization_id::text,
    'scope_subject', scope_subject,
    'organization_id', current_organization_id,
    'role_key', role_key_value,
    'permissions_fingerprint', permissions_fingerprint,
    'version', coalesce(cache_version, 1)
  );
end;
$$;

revoke all on function public.get_workspace_cache_context(text) from public, anon;
grant execute on function public.get_workspace_cache_context(text) to authenticated;

-- Cache only summary/analytics output. The live customer/lead names and phone
-- numbers continue to use a separate direct, scoped RPC below.
create or replace function public.get_tenant_dashboard_summary(
  target_days integer default 14,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_tenant_performance_dashboard(target_days, target_timezone)
    - 'lead_preview'
    - 'attention';
$$;

revoke all on function public.get_tenant_dashboard_summary(integer, text) from public, anon;
grant execute on function public.get_tenant_dashboard_summary(integer, text) to authenticated;

create or replace function public.get_tenant_dashboard_live_items(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
declare can_view_leads boolean;
declare can_view_followups boolean;
declare preview_result jsonb := '[]'::jsonb;
declare attention_result jsonb := '[]'::jsonb;
begin
  if target_timezone is null or target_timezone not in ('Asia/Kolkata', 'UTC') then
    raise exception using errcode = '22023', message = 'INVALID_TENANT_DASHBOARD_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null then
    raise exception using errcode = '42501', message = 'TENANT_DASHBOARD_ACCESS_REQUIRED';
  end if;
  can_view_leads := app_private.has_permission(current_organization_id, 'lead.view');
  can_view_followups := app_private.has_permission(current_organization_id, 'followup.view');

  if can_view_leads then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', preview_row.id, 'customer_name', preview_row.customer_name,
      'phone', preview_row.phone, 'source', preview_row.source,
      'interested_model', preview_row.interested_model,
      'lifecycle_status', preview_row.lifecycle_status,
      'temperature', preview_row.temperature, 'work_state', preview_row.work_state,
      'next_followup_at', preview_row.next_followup_at, 'updated_at', preview_row.updated_at
    ) order by preview_row.updated_at desc, preview_row.id desc), '[]'::jsonb)
    into preview_result
    from (
      select lead_row.id, lead_row.customer_name, lead_row.phone, lead_row.source,
        lead_row.interested_model, lead_row.lifecycle_status, lead_row.temperature,
        case
          when lead_row.first_contacted_at is null and lead_row.sla_due_at is not null and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state,
        lead_row.next_followup_at, lead_row.updated_at
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and app_private.can_access_record(
          lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
        )
      order by lead_row.updated_at desc, lead_row.id desc
      limit 5
    ) preview_row;
  end if;

  if can_view_followups then
    select coalesce(jsonb_agg(to_jsonb(attention_row) order by attention_row.sort_at, attention_row.id), '[]'::jsonb)
    into attention_result
    from (
      select followup_row.id, 'FOLLOWUP'::text as kind,
        coalesce(customer_row.full_name, lead_row.customer_name) as title,
        'Follow-up was due ' || to_char(timezone(target_timezone, followup_row.due_at), 'DD Mon, HH24:MI') as detail,
        case when followup_row.due_at < now() - interval '1 day' then 'HIGH' else 'MEDIUM' end as severity,
        followup_row.due_at as sort_at, followup_row.lead_id
      from public.followups followup_row
      left join public.leads lead_row
        on lead_row.organization_id = followup_row.organization_id
       and lead_row.id = followup_row.lead_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on customer_row.organization_id = followup_row.organization_id
       and customer_row.id = followup_row.customer_id
       and customer_row.deleted_at is null
      where followup_row.organization_id = current_organization_id
        and followup_row.status in ('OPEN', 'OVERDUE')
        and followup_row.due_at < now()
        and app_private.can_access_record(
          followup_row.organization_id, followup_row.branch_id,
          followup_row.team_id, followup_row.assigned_user_id
        )
        and (followup_row.lead_id is null or app_private.can_access_lead(followup_row.lead_id))
        and (followup_row.customer_id is null or app_private.can_access_customer(followup_row.organization_id, followup_row.customer_id))
      order by followup_row.due_at, followup_row.id
      limit 12
    ) attention_row;
  end if;

  return jsonb_build_object('lead_preview', preview_result, 'attention', attention_result);
end;
$$;

revoke all on function public.get_tenant_dashboard_live_items(text) from public, anon;
grant execute on function public.get_tenant_dashboard_live_items(text) to authenticated;

commit;
