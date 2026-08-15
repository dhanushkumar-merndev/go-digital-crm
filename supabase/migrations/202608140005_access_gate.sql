begin;

create or replace function public.get_access_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare profile_row public.profiles%rowtype; organization_row public.organizations%rowtype; role_row public.roles%rowtype; assignment_row public.user_role_assignments%rowtype; aal text; support_controller boolean; route_role_key text;
begin
  if auth.uid() is null then return jsonb_build_object('authenticated', false, 'destination', 'LOGIN'); end if;
  select * into profile_row from public.profiles where id = auth.uid();
  if not found or not profile_row.active then return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED'); end if;
  if profile_row.organization_id is null and app_private.is_platform_admin() then
    return jsonb_build_object('authenticated', true, 'destination', 'CRM', 'role_key', 'super-admin', 'tenant_status', null, 'mfa_required', true);
  end if;
  select * into organization_row from public.organizations where id = profile_row.organization_id;
  if not found or organization_row.status in ('SUSPENDED','REJECTED','SOFT_DELETED') then return jsonb_build_object('authenticated', true, 'destination', 'ACCOUNT_LOCKED'); end if;
  select ura.* into assignment_row
  from public.user_role_assignments ura
  join public.roles r on r.id = ura.role_id
  where ura.user_id = auth.uid() and ura.active
  order by r.authority_level desc
  limit 1;
  if not found then return jsonb_build_object('authenticated', true, 'destination', 'NO_ROLE'); end if;
  select * into role_row from public.roles where id = assignment_row.role_id;
  route_role_key := case role_row.role_key
    when 'telecaller_bdc' then 'telecaller' when 'inventory_manager' then 'inventory' when 'finance_manager' then 'finance'
    when 'insurance_manager' then 'insurance' when 'rto_manager' then 'rto' when 'exchange_manager' then 'exchange'
    when 'delivery_manager' then 'delivery' when 'customer_relationship_manager' then 'customer-care'
    when 'digital_marketing_manager' then 'digital-marketing' else replace(role_row.role_key, '_', '-') end;
  aal := coalesce(auth.jwt()->>'aal', 'aal1');
  if (profile_row.mfa_required or role_row.mfa_required or role_row.role_key in ('super_admin','business_owner','client_admin','system_administrator','gm_sales')) and aal <> 'aal2' then
    return jsonb_build_object('authenticated', true, 'destination', 'MFA', 'mfa_required', true);
  end if;
  if organization_row.status in ('ONBOARDING','UNDER_REVIEW','CHANGES_REQUIRED') then
    return jsonb_build_object('authenticated', true, 'destination', 'ONBOARDING', 'tenant_status', organization_row.status, 'role_key', route_role_key);
  end if;
  select role_row.role_key in ('business_owner','client_admin') or exists (
    select 1 from public.support_sessions ss where ss.organization_id = organization_row.id and ss.ended_at is null and ss.expires_at > now() and auth.uid() in (ss.requester_id, ss.approver_id)
  ) into support_controller;
  if organization_row.status = 'SUPPORT_MAINTENANCE' and not support_controller then
    return jsonb_build_object('authenticated', true, 'destination', 'MAINTENANCE', 'tenant_status', organization_row.status);
  end if;
  return jsonb_build_object(
    'authenticated', true, 'destination', 'CRM', 'user_id', profile_row.id, 'organization_id', organization_row.id,
    'tenant_status', organization_row.status, 'role_key', route_role_key, 'data_scope', assignment_row.data_scope,
    'mfa_required', profile_row.mfa_required or role_row.mfa_required, 'mfa_satisfied', aal = 'aal2', 'support_controller', support_controller
  );
end;
$$;
revoke all on function public.get_access_context() from public, anon;
grant execute on function public.get_access_context() to authenticated;

drop policy if exists tenant_record_scope on public.user_role_assignments;
create policy own_or_managed_role_assignments on public.user_role_assignments for select to authenticated using (
  user_id = auth.uid() or app_private.has_permission(organization_id, 'user.manage') or app_private.is_platform_admin()
);
create policy managed_role_assignment_mutations on public.user_role_assignments for all to authenticated using (
  app_private.has_permission(organization_id, 'user.manage') or app_private.is_platform_admin()
) with check (app_private.has_permission(organization_id, 'user.manage') or app_private.is_platform_admin());

drop policy if exists tenant_record_scope on public.roles;
create policy assigned_role_catalog on public.roles for select to authenticated using (
  app_private.is_platform_admin() or exists (select 1 from public.user_role_assignments ura where ura.user_id = auth.uid() and ura.role_id = roles.id and ura.active)
  or (organization_id is not null and app_private.has_permission(organization_id, 'role.manage'))
);
create policy managed_role_mutations on public.roles for all to authenticated using (
  organization_id is not null and app_private.has_permission(organization_id, 'role.manage')
) with check (organization_id is not null and app_private.has_permission(organization_id, 'role.manage'));

commit;
