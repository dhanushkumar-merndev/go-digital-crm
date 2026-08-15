begin;

-- Reports deliberately export aggregated operational data only.  Detailed CRM data
-- stays in its owning workspace and cannot be mass-exported through this boundary.
insert into public.permissions (permission_key, module, description) values
  ('report.view', 'reports', 'View scoped report history and aggregate operational reporting'),
  ('report.export', 'reports', 'Request scoped private aggregate report exports')
on conflict (permission_key) do update
set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row on permission_row.permission_key in ('report.view', 'report.export')
where role_row.organization_id is not null
  and role_row.system_role
  and (
    permission_row.permission_key = 'report.view'
    or role_row.role_key in (
      'business_owner', 'client_admin', 'system_administrator', 'gm_sales',
      'showroom_manager', 'team_manager', 'inventory_manager', 'finance_manager',
      'insurance_manager', 'rto_manager', 'exchange_manager', 'delivery_manager',
      'customer_relationship_manager', 'digital_marketing_manager'
    )
  )
on conflict do nothing;

create or replace function app_private.apply_default_report_permissions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_id is not null and new.system_role then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id
    from public.permissions permission_row
    where permission_row.permission_key = any(
      case when new.role_key in (
        'business_owner', 'client_admin', 'system_administrator', 'gm_sales',
        'showroom_manager', 'team_manager', 'inventory_manager', 'finance_manager',
        'insurance_manager', 'rto_manager', 'exchange_manager', 'delivery_manager',
        'customer_relationship_manager', 'digital_marketing_manager'
      ) then array['report.view', 'report.export']
      else array['report.view'] end
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists roles_apply_default_report_permissions on public.roles;
create trigger roles_apply_default_report_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_report_permissions();

create table public.report_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  report_key text not null,
  requested_by uuid not null references public.profiles(id),
  request_id uuid not null,
  status text not null default 'QUEUED',
  object_file_id uuid references public.object_files(id),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  safe_error_code text,
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, request_id),
  unique (organization_id, id),
  check (report_key in ('LEADS', 'CALLS', 'APPOINTMENTS', 'SALES', 'INVENTORY', 'MARKETING')),
  check (status in ('QUEUED', 'PROCESSING', 'READY', 'RETRY', 'FAILED', 'EXPIRED', 'CANCELLED')),
  check (attempt_count between 0 and 8),
  check ((status = 'READY') = (object_file_id is not null)),
  check (expires_at is null or expires_at > created_at)
);
create index report_exports_workspace_idx on public.report_exports
  (organization_id, created_at desc, id desc);
create index report_exports_worker_idx on public.report_exports
  (status, created_at, id) where status in ('QUEUED', 'RETRY', 'PROCESSING');
alter table public.report_exports
  add constraint report_exports_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid,
  add constraint report_exports_requester_org_fk foreign key (organization_id, requested_by)
  references public.profiles (organization_id, id) not valid;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
-- Export rows reference their private object_files, so delete the row before
-- the base object metadata (850).
values ('report_exports', 'DELETE', 835)
on conflict (table_name) do update set disposition = excluded.disposition, delete_order = excluded.delete_order;

alter table public.report_exports enable row level security;
alter table public.report_exports force row level security;
revoke insert, update, delete on public.report_exports from anon, authenticated;
create policy report_exports_read on public.report_exports for select to authenticated using (
  app_private.has_permission(organization_id, 'report.view')
  and (
    requested_by = auth.uid()
    or (branch_id is null and app_private.has_organization_wide_scope(organization_id))
    or (branch_id is not null and app_private.can_access_branch(organization_id, branch_id))
  )
);

create or replace function public.request_report_export(
  target_report_key text,
  target_branch_id uuid default null,
  target_request_id uuid default gen_random_uuid()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_organization_id uuid;
declare report_row public.report_exports%rowtype;
declare normalized_key text := upper(btrim(coalesce(target_report_key, '')));
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if normalized_key not in ('LEADS', 'CALLS', 'APPOINTMENTS', 'SALES', 'INVENTORY', 'MARKETING') then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_KEY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'report.export') then
    raise exception using errcode = '42501', message = 'REPORT_EXPORT_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is null then
    if not app_private.has_organization_wide_scope(current_organization_id) then
      raise exception using errcode = '42501', message = 'ORGANIZATION_SCOPE_REQUIRED';
    end if;
  elsif not app_private.can_access_branch(current_organization_id, target_branch_id) then
    raise exception using errcode = '42501', message = 'REPORT_BRANCH_SCOPE_DENIED';
  end if;
  insert into public.report_exports (
    organization_id, branch_id, report_key, requested_by, request_id
  ) values (
    current_organization_id, target_branch_id, normalized_key, auth.uid(), target_request_id
  ) on conflict (organization_id, request_id) do update
    set updated_at = public.report_exports.updated_at
  returning * into report_row;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'report.export_requested', 'report_export', report_row.id::text,
    target_branch_id, target_request_id, jsonb_build_object('report_key', normalized_key, 'replayed', report_row.created_at < now() - interval '1 second')
  );
  return jsonb_build_object('id', report_row.id, 'status', report_row.status, 'replayed', report_row.request_id = target_request_id and report_row.created_at < now() - interval '1 second');
end;
$$;

create or replace function public.get_report_exports_page(
  target_search text default '', target_page integer default 1, target_page_size integer default 25
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid;
declare normalized_search text := lower(btrim(coalesce(target_search, '')));
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if char_length(normalized_search) > 80 or target_page not between 1 and 1000000 or target_page_size not in (25,50,100) then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_EXPORT_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null or not app_private.has_permission(current_organization_id, 'report.view') then
    raise exception using errcode = '42501', message = 'REPORT_VIEW_PERMISSION_REQUIRED';
  end if;
  return (
    with authorized as materialized (
      select export_row.*, profile_row.full_name as requested_by_name
      from public.report_exports export_row
      join public.profiles profile_row on profile_row.id = export_row.requested_by
      where export_row.organization_id = current_organization_id
        and (export_row.requested_by = auth.uid()
          or (export_row.branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
          or (export_row.branch_id is not null and app_private.can_access_branch(current_organization_id, export_row.branch_id)))
        and (normalized_search = '' or position(normalized_search in lower(export_row.report_key)) > 0
          or position(normalized_search in lower(export_row.status)) > 0)
    ), page_rows as (
      select * from authorized order by created_at desc, id desc
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'organization_id', current_organization_id,
      'records', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'report_key', report_key, 'branch_id', branch_id, 'requested_by', requested_by,
        'requested_by_name', requested_by_name, 'status', status, 'object_file_id', object_file_id,
        'safe_error_code', safe_error_code, 'expires_at', expires_at, 'completed_at', completed_at,
        'created_at', created_at
      ) order by created_at desc, id desc) from page_rows), '[]'::jsonb),
      'total', (select count(*) from authorized),
      'kpis', jsonb_build_object(
        'ready', (select count(*) from authorized where status = 'READY'),
        'processing', (select count(*) from authorized where status in ('QUEUED','PROCESSING','RETRY')),
        'failed', (select count(*) from authorized where status = 'FAILED'),
        'requested_30d', (select count(*) from authorized where created_at >= now() - interval '30 days')
      ),
      'status_chart', coalesce((select jsonb_agg(jsonb_build_object('name', status, 'value', count) order by status) from (select status, count(*) from authorized group by status) chart), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.claim_report_exports(target_worker_id text, target_batch_size integer default 5)
returns setof public.report_exports language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  if nullif(btrim(target_worker_id), '') is null or target_batch_size not between 1 and 10 then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_EXPORT_CLAIM';
  end if;
  return query with candidates as (
    select id from public.report_exports where (status in ('QUEUED','RETRY') or (status = 'PROCESSING' and lease_expires_at < now()))
    order by created_at, id for update skip locked limit target_batch_size
  ) update public.report_exports export_row
    set status = 'PROCESSING', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes',
      attempt_count = attempt_count + 1, safe_error_code = null, updated_at = now()
    from candidates where export_row.id = candidates.id returning export_row.*;
end;
$$;

create or replace function public.complete_report_export(
  target_export_id uuid, target_lease_token uuid, target_object_file_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare export_row public.report_exports%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select * into export_row from public.report_exports where id = target_export_id for update;
  if not found or export_row.status <> 'PROCESSING' or export_row.lease_token <> target_lease_token or export_row.lease_expires_at < now() then return false; end if;
  if not exists (select 1 from public.object_files where id = target_object_file_id and organization_id = export_row.organization_id and resource_type = 'report_export' and resource_id = export_row.id and deleted_at is null) then
    raise exception using errcode = '23503', message = 'REPORT_OBJECT_FILE_INVALID';
  end if;
  update public.report_exports set status = 'READY', object_file_id = target_object_file_id, completed_at = now(), expires_at = now() + interval '30 days', lease_token = null, lease_expires_at = null, updated_at = now() where id = target_export_id;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata)
  values (export_row.organization_id, export_row.requested_by, 'report.export_ready', 'report_export', export_row.id::text, export_row.branch_id, jsonb_build_object('object_file_id', target_object_file_id));
  return true;
end;
$$;

create or replace function public.retry_report_export(
  target_export_id uuid, target_lease_token uuid, target_safe_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare attempts integer;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select attempt_count into attempts from public.report_exports where id = target_export_id and status = 'PROCESSING' and lease_token = target_lease_token and lease_expires_at >= now() for update;
  if not found then return false; end if;
  update public.report_exports set status = case when attempts >= 5 then 'FAILED' else 'RETRY' end,
    safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''), 'REPORT_EXPORT_RETRY'), 120),
    lease_token = null, lease_expires_at = null, updated_at = now() where id = target_export_id;
  return true;
end;
$$;

create or replace function public.get_report_export_payload(target_export_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare export_row public.report_exports%rowtype;
declare result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select * into export_row from public.report_exports where id = target_export_id;
  if not found then raise exception using errcode = 'P0002', message = 'REPORT_EXPORT_NOT_FOUND'; end if;
  if export_row.report_key = 'LEADS' then
    select coalesce(jsonb_agg(jsonb_build_object('source', source, 'lifecycle_status', lifecycle_status, 'lead_count', lead_count) order by source, lifecycle_status), '[]'::jsonb) into result from (
      select source, lifecycle_status, count(*)::integer as lead_count from public.leads
      where organization_id = export_row.organization_id and deleted_at is null and (export_row.branch_id is null or branch_id = export_row.branch_id)
      group by source, lifecycle_status
    ) rows;
  elsif export_row.report_key = 'CALLS' then
    select coalesce(jsonb_agg(jsonb_build_object('direction', direction, 'outcome', outcome, 'call_count', call_count, 'total_duration_seconds', total_duration_seconds) order by direction, outcome), '[]'::jsonb) into result from (
      select direction, coalesce(outcome, 'UNSPECIFIED') outcome, count(*)::integer call_count, coalesce(sum(duration_seconds), 0)::integer total_duration_seconds from public.calls
      where organization_id = export_row.organization_id and (export_row.branch_id is null or branch_id = export_row.branch_id)
      group by direction, coalesce(outcome, 'UNSPECIFIED')
    ) rows;
  elsif export_row.report_key = 'APPOINTMENTS' then
    select coalesce(jsonb_agg(jsonb_build_object('status', status, 'appointment_count', appointment_count) order by status), '[]'::jsonb) into result from (
      select status, count(*)::integer appointment_count from public.appointments
      where organization_id = export_row.organization_id and (export_row.branch_id is null or branch_id = export_row.branch_id)
      group by status
    ) rows;
  elsif export_row.report_key = 'SALES' then
    select coalesce(jsonb_agg(jsonb_build_object('document_type', document_type, 'status', status, 'document_count', document_count) order by document_type, status), '[]'::jsonb) into result from (
      select 'QUOTATION' document_type, status, count(*)::integer document_count from public.quotations where organization_id = export_row.organization_id and deleted_at is null and (export_row.branch_id is null or branch_id = export_row.branch_id) group by status
      union all select 'BOOKING', status, count(*)::integer from public.bookings where organization_id = export_row.organization_id and deleted_at is null and (export_row.branch_id is null or branch_id = export_row.branch_id) group by status
    ) rows;
  elsif export_row.report_key = 'INVENTORY' then
    select coalesce(jsonb_agg(jsonb_build_object('status', status, 'unit_count', unit_count) order by status), '[]'::jsonb) into result from (
      select status, count(*)::integer unit_count from public.stock_units where organization_id = export_row.organization_id and deleted_at is null and (export_row.branch_id is null or branch_id = export_row.branch_id) group by status
    ) rows;
  else
    select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'status', status, 'campaign_count', campaign_count) order by platform, status), '[]'::jsonb) into result from (
      select platform, status, count(*)::integer campaign_count from public.marketing_campaigns where organization_id = export_row.organization_id and deleted_at is null and (export_row.branch_id is null or branch_id = export_row.branch_id) group by platform, status
    ) rows;
  end if;
  return jsonb_build_object('report_key', export_row.report_key, 'branch_id', export_row.branch_id, 'generated_at', now(), 'rows', result);
end;
$$;

create or replace function public.authorize_report_export_download(target_export_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from public.report_exports export_row
    where export_row.id = target_export_id and export_row.status = 'READY' and export_row.expires_at > now()
      and app_private.has_permission(export_row.organization_id, 'report.view')
      and (export_row.requested_by = auth.uid() or (export_row.branch_id is null and app_private.has_organization_wide_scope(export_row.organization_id)) or (export_row.branch_id is not null and app_private.can_access_branch(export_row.organization_id, export_row.branch_id)))
  );
end;
$$;

revoke all on function public.request_report_export(text, uuid, uuid) from public, anon;
revoke all on function public.get_report_exports_page(text, integer, integer) from public, anon;
revoke all on function public.authorize_report_export_download(uuid) from public, anon;
grant execute on function public.request_report_export(text, uuid, uuid) to authenticated;
grant execute on function public.get_report_exports_page(text, integer, integer) to authenticated;
grant execute on function public.authorize_report_export_download(uuid) to authenticated;
revoke all on function public.claim_report_exports(text, integer) from public, anon, authenticated;
revoke all on function public.complete_report_export(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.retry_report_export(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_report_export_payload(uuid) from public, anon, authenticated;
grant execute on function public.claim_report_exports(text, integer) to service_role;
grant execute on function public.complete_report_export(uuid, uuid, uuid) to service_role;
grant execute on function public.retry_report_export(uuid, uuid, text) to service_role;
grant execute on function public.get_report_export_payload(uuid) to service_role;

commit;
