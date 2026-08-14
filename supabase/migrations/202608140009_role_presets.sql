begin;

create or replace function public.provision_default_roles(target_organization_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare inserted_count integer;
begin
  if auth.role() <> 'service_role' and not app_private.is_platform_admin() then raise exception using errcode = '42501', message = 'PLATFORM_AUTHORITY_REQUIRED'; end if;
  if not exists (select 1 from public.organizations where id = target_organization_id and deleted_at is null) then raise exception using errcode = 'P0002', message = 'ORGANIZATION_NOT_FOUND'; end if;
  insert into public.roles (organization_id, name, role_key, authority_level, system_role, mfa_required) values
    (target_organization_id, 'Business Owner', 'business_owner', 900, true, true),
    (target_organization_id, 'Client Admin', 'client_admin', 850, true, true),
    (target_organization_id, 'System Administrator', 'system_administrator', 800, true, true),
    (target_organization_id, 'GM Sales Executive', 'gm_sales', 700, true, true),
    (target_organization_id, 'Showroom Manager', 'showroom_manager', 600, true, false),
    (target_organization_id, 'Team Manager', 'team_manager', 500, true, false),
    (target_organization_id, 'Sales Consultant', 'sales_consultant', 300, true, false),
    (target_organization_id, 'Telecaller / BDC Executive', 'telecaller_bdc', 300, true, false),
    (target_organization_id, 'Inventory Manager', 'inventory_manager', 450, true, false),
    (target_organization_id, 'Finance Manager', 'finance_manager', 450, true, false),
    (target_organization_id, 'Insurance Manager', 'insurance_manager', 450, true, false),
    (target_organization_id, 'RTO Manager', 'rto_manager', 450, true, false),
    (target_organization_id, 'Used Car / Exchange Manager', 'exchange_manager', 450, true, false),
    (target_organization_id, 'Delivery Manager', 'delivery_manager', 450, true, false),
    (target_organization_id, 'Customer Relationship Manager', 'customer_relationship_manager', 450, true, false),
    (target_organization_id, 'Digital Marketing Manager', 'digital_marketing_manager', 450, true, false)
  on conflict (organization_id, role_key) do update set name = excluded.name, authority_level = excluded.authority_level, mfa_required = excluded.mfa_required;
  get diagnostics inserted_count = row_count;

  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r cross join public.permissions p
  where r.organization_id = target_organization_id and (
    r.role_key = 'client_admin'
    or (r.role_key = 'system_administrator' and p.permission_key not in ('credit.allocate','support.approve'))
    or (r.role_key = 'business_owner' and p.permission_key in ('customer.view','audit.view','credit.allocate','support.request','support.approve','user.manage'))
    or (r.role_key = 'gm_sales' and p.permission_key in ('customer.view','lead.view','approval.decide','audit.view','document.download'))
    or (r.role_key = 'showroom_manager' and p.permission_key in ('customer.view','customer.link','lead.view','lead.update','lead.assign','call.view','test_drive.manage','quotation.manage','booking.manage','approval.decide','document.download'))
    or (r.role_key = 'team_manager' and p.permission_key in ('customer.view','customer.link','lead.view','lead.update','lead.assign','call.view','test_drive.manage','quotation.manage','booking.manage','document.download'))
    or (r.role_key = 'sales_consultant' and p.permission_key in ('customer.view','customer.create','customer.link','lead.view','lead.update','call.view','call.create','test_drive.manage','quotation.manage','booking.manage','credit.consume','document.upload','document.download','email.send'))
    or (r.role_key = 'telecaller_bdc' and p.permission_key in ('customer.view','customer.create','customer.link','lead.view','lead.update','call.view','call.create','credit.consume','document.upload','document.download','email.send'))
    or (r.role_key in ('inventory_manager','finance_manager','insurance_manager','rto_manager','exchange_manager','delivery_manager','customer_relationship_manager') and p.permission_key in ('customer.view','document.upload','document.download','email.send'))
    or (r.role_key = 'digital_marketing_manager' and p.permission_key in ('lead.view','document.upload','document.download'))
  ) on conflict do nothing;

  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
    values (target_organization_id, auth.uid(), 'role_presets.provisioned', 'organization', target_organization_id::text, jsonb_build_object('preset_count', inserted_count));
  return inserted_count;
end;
$$;
revoke all on function public.provision_default_roles(uuid) from public, anon, authenticated;
grant execute on function public.provision_default_roles(uuid) to service_role;

insert into public.roles (organization_id, name, role_key, authority_level, system_role, mfa_required)
values (null, 'Super Admin', 'super_admin', 1000, true, true)
on conflict (organization_id, role_key) do update set authority_level = excluded.authority_level, mfa_required = true;

commit;
