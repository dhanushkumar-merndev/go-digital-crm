begin;

create table public.object_upload_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  resource_type text not null,
  resource_id uuid not null,
  bucket text not null,
  object_key text not null unique,
  file_name text not null,
  expected_mime_type text not null,
  expected_size_bytes bigint not null check (expected_size_bytes between 1 and 262144000),
  expected_checksum text not null,
  requested_by uuid not null references public.profiles(id),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  object_file_id uuid references public.object_files(id),
  created_at timestamptz not null default now(),
  constraint object_upload_intent_expiry check (
    expires_at > created_at
    and expires_at <= created_at + interval '15 minutes'
  ),
  constraint object_upload_intent_checksum check (
    expected_checksum ~ '^[A-Za-z0-9+/]{43}=$'
  ),
  constraint object_upload_intent_branch_tenant_fk
    foreign key (organization_id, branch_id)
    references public.branches (organization_id, id)
    not valid,
  constraint object_upload_intent_requester_tenant_fk
    foreign key (organization_id, requested_by)
    references public.profiles (organization_id, id)
    not valid
);

alter table public.object_files
  add column original_file_name text,
  add constraint object_files_branch_tenant_fk
    foreign key (organization_id, branch_id)
    references public.branches (organization_id, id)
    not valid,
  add constraint object_files_uploader_tenant_fk
    foreign key (organization_id, uploaded_by)
    references public.profiles (organization_id, id)
    not valid;

alter table public.object_upload_intents enable row level security;
alter table public.object_upload_intents force row level security;
revoke all on public.object_upload_intents from public, anon, authenticated;
create index object_upload_intents_expiry_idx
  on public.object_upload_intents (expires_at)
  where finalized_at is null;

create or replace function public.authorize_object_action(
  target_organization_id uuid,
  target_branch_id uuid,
  target_resource_type text,
  target_resource_id uuid,
  target_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare permission_key text;
declare onboarding_owner boolean := false;
declare onboarding_reviewer boolean := false;
begin
  permission_key := case target_action
    when 'UPLOAD' then 'document.upload'
    when 'DOWNLOAD' then 'document.download'
    else null
  end;
  select exists (
    select 1
    from public.organizations organization_row
    join public.profiles profile_row
      on profile_row.id = auth.uid()
     and profile_row.organization_id = organization_row.id
     and profile_row.active
     and profile_row.deleted_at is null
    join public.user_role_assignments assignment_row
      on assignment_row.user_id = profile_row.id
     and assignment_row.organization_id = profile_row.organization_id
     and assignment_row.active
     and assignment_row.data_scope = 'ORGANIZATION'
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
     and role_row.role_key = 'business_owner'
    where organization_row.id = target_organization_id
      and organization_row.primary_owner_id = auth.uid()
      and organization_row.status in ('ONBOARDING', 'CHANGES_REQUIRED', 'UNDER_REVIEW')
      and organization_row.deleted_at is null
      and app_private.mfa_policy_satisfied(target_organization_id)
  ) into onboarding_owner;
  select target_action = 'DOWNLOAD'
    and app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
    and exists (
      select 1
      from public.organizations organization_row
      where organization_row.id = target_organization_id
        and organization_row.status in ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED')
        and organization_row.deleted_at is null
    )
  into onboarding_reviewer;
  -- Approved platform support can inspect a document with an explicit capability,
  -- but cannot create tenant evidence or become its uploader of record.
  if target_action = 'UPLOAD' and app_private.is_platform_admin() then
    return false;
  end if;
  if permission_key is null
    or (
      not onboarding_owner
      and not onboarding_reviewer
      and (
        not app_private.has_permission(target_organization_id, permission_key)
        or (target_branch_id is not null and not app_private.can_access_branch(target_organization_id, target_branch_id))
      )
    )
  then
    return false;
  end if;

  return case target_resource_type
    when 'organization' then target_resource_id = target_organization_id
      and target_branch_id is null
      and exists (
        select 1
        from public.organizations resource_row
        where resource_row.id = target_resource_id
          and resource_row.deleted_at is null
          and (
            onboarding_owner
            or onboarding_reviewer
            or app_private.has_organization_wide_scope(target_organization_id)
          )
      )
    when 'customer' then exists (
      select 1 from public.customers resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and resource_row.deleted_at is null
        and app_private.can_access_customer(target_organization_id, resource_row.id)
    )
    when 'lead' then exists (
      select 1 from public.leads resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and resource_row.deleted_at is null
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, resource_row.team_id, resource_row.assigned_user_id)
    )
    when 'call' then exists (
      select 1 from public.calls resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, resource_row.team_id, resource_row.assigned_user_id)
    )
    when 'appointment' then exists (
      select 1 from public.appointments resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, resource_row.team_id, resource_row.assigned_user_id)
    )
    when 'test_drive' then exists (
      select 1 from public.test_drives resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, resource_row.team_id, resource_row.assigned_user_id)
    )
    when 'quotation' then exists (
      select 1 from public.quotations resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, resource_row.team_id, resource_row.assigned_user_id)
    )
    when 'booking' then exists (
      select 1 from public.bookings resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, resource_row.team_id, resource_row.assigned_user_id)
    )
    when 'stock_unit' then exists (
      select 1 from public.stock_units resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, null, null)
    )
    when 'exchange_case' then exists (
      select 1 from public.exchange_cases resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, null, resource_row.assigned_user_id)
    )
    when 'finance_case' then exists (
      select 1 from public.finance_cases resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, null, resource_row.assigned_user_id)
    )
    when 'insurance_case' then exists (
      select 1 from public.insurance_cases resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, null, resource_row.assigned_user_id)
    )
    when 'rto_case' then exists (
      select 1 from public.rto_cases resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, null, resource_row.assigned_user_id)
    )
    when 'delivery_case' then exists (
      select 1 from public.delivery_cases resource_row
      where resource_row.id = target_resource_id
        and resource_row.organization_id = target_organization_id
        and (target_branch_id is null or resource_row.branch_id = target_branch_id)
        and app_private.can_access_record(resource_row.organization_id, resource_row.branch_id, null, resource_row.assigned_user_id)
    )
    else false
  end;
end;
$$;

create or replace function public.finalize_object_upload(
  target_intent_id uuid,
  actual_size_bytes bigint,
  actual_mime_type text,
  actual_checksum text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare intent_row public.object_upload_intents%rowtype;
declare created_file_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into intent_row
  from public.object_upload_intents
  where id = target_intent_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'UPLOAD_INTENT_NOT_FOUND';
  end if;
  if intent_row.object_file_id is not null then return intent_row.object_file_id; end if;
  if intent_row.expires_at < now() then
    raise exception using errcode = '23514', message = 'UPLOAD_INTENT_EXPIRED';
  end if;
  if actual_size_bytes <> intent_row.expected_size_bytes
    or lower(actual_mime_type) <> lower(intent_row.expected_mime_type)
    or actual_checksum <> intent_row.expected_checksum
  then
    raise exception using errcode = '23514', message = 'UPLOADED_OBJECT_MISMATCH';
  end if;

  insert into public.object_files (
    organization_id, branch_id, resource_type, resource_id, bucket, object_key,
    original_file_name, mime_type, size_bytes, checksum, uploaded_by
  ) values (
    intent_row.organization_id, intent_row.branch_id, intent_row.resource_type,
    intent_row.resource_id, intent_row.bucket, intent_row.object_key,
    intent_row.file_name, intent_row.expected_mime_type, intent_row.expected_size_bytes,
    intent_row.expected_checksum, intent_row.requested_by
  ) returning id into created_file_id;
  update public.object_upload_intents
  set finalized_at = now(), object_file_id = created_file_id
  where id = intent_row.id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    intent_row.organization_id, intent_row.requested_by, 'document.upload_finalized',
    'object_file', created_file_id::text, intent_row.branch_id,
    jsonb_build_object('target_type', intent_row.resource_type, 'target_id', intent_row.resource_id)
  );
  return created_file_id;
end;
$$;

revoke all on function public.authorize_object_action(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function public.authorize_object_action(uuid, uuid, text, uuid, text) to authenticated;
revoke all on function public.finalize_object_upload(uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.finalize_object_upload(uuid, bigint, text, text) to service_role;

commit;
