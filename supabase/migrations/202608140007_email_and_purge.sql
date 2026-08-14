begin;

create table public.email_messages (
  id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id), application_message_id uuid not null default gen_random_uuid(), provider_message_id text,
  template_id text not null, recipient text not null, status text not null default 'PENDING', error_code text, error_message text,
  requested_by uuid references public.profiles(id), created_at timestamptz not null default now(), accepted_at timestamptz, delivered_at timestamptz,
  unique (application_message_id)
);
alter table public.email_messages enable row level security;
alter table public.email_messages force row level security;
create policy email_tenant_scope on public.email_messages for all to authenticated
  using (organization_id is not null and app_private.can_access_organization(organization_id))
  with check (organization_id is not null and app_private.can_access_organization(organization_id));

create or replace function public.complete_controlled_purge(target_deletion_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare request_row public.deletion_requests%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  select * into request_row from public.deletion_requests where id = target_deletion_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'DELETION_REQUEST_NOT_FOUND'; end if;
  if request_row.status = 'PURGED' then return true; end if;
  if request_row.status <> 'APPROVED' or request_row.purge_after is null or request_row.purge_after > now() then raise exception using errcode = '23514', message = 'PURGE_NOT_ELIGIBLE'; end if;
  if exists (select 1 from public.object_files f where f.organization_id = request_row.organization_id and f.resource_type = request_row.resource_type and f.resource_id = request_row.resource_id and f.deleted_at is null) then raise exception using errcode = '23514', message = 'OBJECT_PURGE_INCOMPLETE'; end if;
  update public.deletion_requests set status = 'PURGED' where id = request_row.id;
  update public.purge_jobs set status = 'COMPLETED', completed_at = now() where deletion_request_id = request_row.id and status <> 'COMPLETED';
  insert into public.audit_logs (organization_id, action, resource_type, resource_id, metadata)
    values (request_row.organization_id, 'purge.completed', request_row.resource_type, request_row.resource_id::text, jsonb_build_object('deletion_request_id', request_row.id));
  return true;
end;
$$;
revoke all on function public.complete_controlled_purge(uuid) from public, anon, authenticated;
grant execute on function public.complete_controlled_purge(uuid) to service_role;

commit;
