begin;

create or replace function public.provision_tenant_owner(
  target_actor_id uuid,
  target_owner_user_id uuid,
  target_owner_email text,
  target_owner_name text,
  target_organization_name text,
  target_organization_slug text,
  target_legal_name text,
  target_gst_number text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare created_organization_id uuid;
declare business_owner_role_id uuid;
declare normalized_owner_email text;
declare normalized_gst_number text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.profiles actor_profile
    join public.user_role_assignments actor_assignment
      on actor_assignment.user_id = actor_profile.id
     and actor_assignment.active
     and actor_assignment.data_scope = 'PLATFORM'
    join public.roles actor_role
      on actor_role.id = actor_assignment.role_id
     and actor_role.organization_id is null
     and actor_role.role_key = 'super_admin'
    where actor_profile.id = target_actor_id
      and actor_profile.organization_id is null
      and actor_profile.active
      and actor_profile.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_organization_name, ''))) not between 2 and 160
    or target_organization_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(target_organization_slug) not between 3 and 63
    or char_length(btrim(coalesce(target_owner_name, ''))) not between 2 and 160
  then
    raise exception using errcode = '22023', message = 'INVALID_TENANT_IDENTITY';
  end if;
  normalized_owner_email := lower(btrim(coalesce(target_owner_email, '')));
  if char_length(normalized_owner_email) > 254
    or normalized_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then
    raise exception using errcode = '22023', message = 'INVALID_OWNER_EMAIL';
  end if;
  normalized_gst_number := nullif(upper(btrim(coalesce(target_gst_number, ''))), '');
  if normalized_gst_number is not null
    and normalized_gst_number !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  then
    raise exception using errcode = '22023', message = 'INVALID_GST_NUMBER';
  end if;
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = target_owner_user_id
      and lower(auth_user.email) = normalized_owner_email
  ) or exists (
    select 1 from public.profiles profile_row where profile_row.id = target_owner_user_id
  ) then
    raise exception using errcode = '23505', message = 'OWNER_IDENTITY_ALREADY_PROVISIONED';
  end if;

  insert into public.organizations (
    name, slug, legal_name, gst_number, status
  ) values (
    btrim(target_organization_name),
    target_organization_slug,
    nullif(btrim(coalesce(target_legal_name, '')), ''),
    normalized_gst_number,
    'ONBOARDING'
  ) returning id into created_organization_id;

  insert into public.profiles (
    id, organization_id, full_name, email, active, mfa_required
  ) values (
    target_owner_user_id,
    created_organization_id,
    btrim(target_owner_name),
    normalized_owner_email,
    true,
    true
  );
  update public.organizations
  set primary_owner_id = target_owner_user_id, updated_at = now()
  where id = created_organization_id;

  perform public.provision_default_roles(created_organization_id);
  select role_row.id into business_owner_role_id
  from public.roles role_row
  where role_row.organization_id = created_organization_id
    and role_row.role_key = 'business_owner';
  if business_owner_role_id is null then
    raise exception using errcode = 'P0002', message = 'BUSINESS_OWNER_ROLE_NOT_PROVISIONED';
  end if;
  insert into public.user_role_assignments (
    organization_id,
    user_id,
    role_id,
    data_scope,
    selected_branch_ids,
    active,
    granted_by
  ) values (
    created_organization_id,
    target_owner_user_id,
    business_owner_role_id,
    'ORGANIZATION',
    '{}'::uuid[],
    true,
    target_actor_id
  );
  insert into public.tenant_status_history (
    organization_id, from_status, to_status, changed_by, reason
  ) values (
    created_organization_id, null, 'ONBOARDING', target_actor_id,
    'Tenant and initial Business Owner securely provisioned'
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    created_organization_id, target_actor_id, 'tenant.owner_provisioned',
    'organization', created_organization_id::text, target_request_id,
    jsonb_build_object('owner_id', target_owner_user_id, 'owner_email', normalized_owner_email)
  );
  return jsonb_build_object(
    'organization_id', created_organization_id,
    'owner_user_id', target_owner_user_id,
    'status', 'ONBOARDING'
  );
end;
$$;

revoke all on function public.provision_tenant_owner(uuid, uuid, text, text, text, text, text, text, uuid)
from public, anon, authenticated;
grant execute on function public.provision_tenant_owner(uuid, uuid, text, text, text, text, text, text, uuid)
to service_role;

commit;
