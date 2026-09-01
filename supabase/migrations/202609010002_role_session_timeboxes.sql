begin;

-- Keep Supabase access JWTs short-lived and renewable, while enforcing an
-- absolute application-session lifetime from the stable Auth session row.
-- The existing MFA policy is also the source of truth for which accounts are
-- sensitive, so scope-based/profile-forced MFA receives the shorter timebox
-- without encoding data scope into a role name.
create or replace function app_private.current_session_expires_at(
  target_organization_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select session_row.created_at + case
    when app_private.requires_mfa(target_organization_id) then interval '5 hours'
    else interval '7 days'
  end
  from auth.sessions session_row
  where session_row.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    and session_row.user_id = auth.uid()
  limit 1;
$$;

create or replace function app_private.session_policy_satisfied(
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce(app_private.current_session_expires_at(target_organization_id) > now(), false);
$$;

-- Session age is part of the common authorization boundary. This makes the
-- timebox apply to RLS and RPC helpers as well as page routing.
create or replace function app_private.mfa_policy_satisfied(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and app_private.session_policy_satisfied(target_organization_id)
    and exists (
      select 1 from public.profiles profile_row
      where profile_row.id = auth.uid()
        and profile_row.active
        and profile_row.deleted_at is null
    )
    and (
      not app_private.requires_mfa(target_organization_id)
      or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    );
$$;

-- Preserve the established access decisions while adding a first-class
-- SESSION_EXPIRED reason and the exact deadline used by web/mobile guards.
create or replace function public.get_access_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  profile_row public.profiles%rowtype;
  organization_row public.organizations%rowtype;
  role_row public.roles%rowtype;
  assignment_row public.user_role_assignments%rowtype;
  aal text;
  support_controller boolean := false;
  route_role_key text;
  mfa_required boolean;
  session_expires_at timestamptz;
  session_policy text;
begin
  if auth.uid() is null then
    return jsonb_build_object('authenticated', false, 'destination', 'LOGIN');
  end if;

  select * into profile_row from public.profiles where id = auth.uid();
  if not found or not profile_row.active or profile_row.deleted_at is not null then
    return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED');
  end if;

  aal := coalesce(auth.jwt()->>'aal', 'aal1');
  if profile_row.organization_id is null and app_private.is_platform_admin() then
    mfa_required := true;
    session_policy := 'SENSITIVE_5_HOURS';
    session_expires_at := app_private.current_session_expires_at(null);
    if session_expires_at is null or session_expires_at <= now() then
      return jsonb_build_object(
        'authenticated', true,
        'destination', 'LOGIN',
        'reason', 'SESSION_EXPIRED'
      );
    end if;
    if aal <> 'aal2' then
      return jsonb_build_object(
        'authenticated', true,
        'destination', 'MFA',
        'role_key', 'super-admin',
        'tenant_status', null,
        'mfa_required', true,
        'mfa_satisfied', false,
        'session_expires_at', session_expires_at,
        'session_policy', session_policy
      );
    end if;
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'CRM',
      'user_id', profile_row.id,
      'role_key', 'super-admin',
      'tenant_status', null,
      'mfa_required', true,
      'mfa_satisfied', true,
      'session_expires_at', session_expires_at,
      'session_policy', session_policy
    );
  end if;

  select * into organization_row
  from public.organizations
  where id = profile_row.organization_id;
  if not found or organization_row.status in ('SUSPENDED', 'REJECTED', 'SOFT_DELETED') or organization_row.deleted_at is not null then
    return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED');
  end if;

  select assignment_source.* into assignment_row
  from public.user_role_assignments assignment_source
  join public.roles role_source
    on role_source.id = assignment_source.role_id
   and role_source.organization_id = assignment_source.organization_id
  where assignment_source.user_id = auth.uid()
    and assignment_source.organization_id = profile_row.organization_id
    and assignment_source.active
  order by role_source.authority_level desc
  limit 1;
  if not found then
    return jsonb_build_object('authenticated', true, 'destination', 'NO_ROLE');
  end if;
  select * into role_row
  from public.roles
  where id = assignment_row.role_id
    and organization_id = assignment_row.organization_id;

  route_role_key := case role_row.role_key
    when 'telecaller_bdc' then 'telecaller'
    when 'inventory_manager' then 'inventory'
    when 'finance_manager' then 'finance'
    when 'insurance_manager' then 'insurance'
    when 'rto_manager' then 'rto'
    when 'exchange_manager' then 'exchange'
    when 'delivery_manager' then 'delivery'
    when 'customer_relationship_manager' then 'customer-care'
    when 'digital_marketing_manager' then 'digital-marketing'
    else replace(role_row.role_key, '_', '-')
  end;

  mfa_required := app_private.requires_mfa(profile_row.organization_id);
  session_policy := case
    when mfa_required then 'SENSITIVE_5_HOURS'
    else 'STANDARD_7_DAYS'
  end;
  session_expires_at := app_private.current_session_expires_at(profile_row.organization_id);
  if session_expires_at is null or session_expires_at <= now() then
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'LOGIN',
      'reason', 'SESSION_EXPIRED'
    );
  end if;

  if mfa_required and aal <> 'aal2' then
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'MFA',
      'role_key', route_role_key,
      'mfa_required', true,
      'mfa_satisfied', false,
      'session_expires_at', session_expires_at,
      'session_policy', session_policy
    );
  end if;

  if organization_row.status in ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED') then
    return jsonb_build_object(
      'authenticated', true,
      'destination', 'ONBOARDING',
      'tenant_status', organization_row.status,
      'role_key', route_role_key,
      'mfa_required', mfa_required,
      'mfa_satisfied', aal = 'aal2',
      'session_expires_at', session_expires_at,
      'session_policy', session_policy
    );
  end if;

  if organization_row.status = 'SUPPORT_MAINTENANCE' then
    support_controller := app_private.is_tenant_support_controller(organization_row.id);
    if not support_controller then
      return jsonb_build_object(
        'authenticated', true,
        'destination', 'MAINTENANCE',
        'tenant_status', organization_row.status,
        'role_key', route_role_key,
        'session_expires_at', session_expires_at,
        'session_policy', session_policy
      );
    end if;
  elsif organization_row.status <> 'ACTIVE' then
    return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED');
  end if;

  return jsonb_build_object(
    'authenticated', true,
    'destination', 'CRM',
    'user_id', profile_row.id,
    'organization_id', organization_row.id,
    'tenant_status', organization_row.status,
    'role_key', route_role_key,
    'data_scope', assignment_row.data_scope,
    'mfa_required', mfa_required,
    'mfa_satisfied', aal = 'aal2',
    'support_controller', support_controller,
    'session_expires_at', session_expires_at,
    'session_policy', session_policy
  );
end;
$$;

revoke all on function app_private.current_session_expires_at(uuid)
  from public, anon, authenticated;
revoke all on function app_private.session_policy_satisfied(uuid)
  from public, anon, authenticated;
revoke all on function app_private.mfa_policy_satisfied(uuid)
  from public, anon, authenticated;
revoke all on function public.get_access_context() from public, anon;
grant execute on function public.get_access_context() to authenticated;

commit;
