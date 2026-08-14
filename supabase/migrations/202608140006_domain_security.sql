begin;

create or replace function app_private.mfa_policy_satisfied(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin() and coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
  or exists (
    select 1 from public.user_role_assignments ura join public.roles r on r.id = ura.role_id join public.profiles p on p.id = ura.user_id
    where ura.user_id = auth.uid() and ura.organization_id = target_organization_id and ura.active and (
      (not p.mfa_required and not r.mfa_required and r.role_key not in ('business_owner','client_admin','system_administrator','gm_sales'))
      or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    )
  );
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['user_role_assignments','roles','connected_accounts','credit_ledger','support_access_requests','support_sessions','audit_logs','deletion_requests','purge_jobs']
  loop
    execute format('create policy require_privileged_mfa on public.%I as restrictive for all to authenticated using (app_private.mfa_policy_satisfied(organization_id)) with check (app_private.mfa_policy_satisfied(organization_id))', table_name);
  end loop;
end $$;

alter table public.role_permissions enable row level security;
alter table public.role_permissions force row level security;
create policy role_permission_catalog on public.role_permissions for all to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id and (app_private.is_platform_admin() or (r.organization_id is not null and (app_private.has_permission(r.organization_id, 'role.manage') or exists (select 1 from public.user_role_assignments ura where ura.user_id = auth.uid() and ura.role_id = r.id and ura.active))))))
  with check (exists (select 1 from public.roles r where r.id = role_id and (app_private.is_platform_admin() or (r.organization_id is not null and app_private.has_permission(r.organization_id, 'role.manage')))));
create policy require_role_permission_mfa on public.role_permissions as restrictive for all to authenticated
  using (app_private.mfa_policy_satisfied((select r.organization_id from public.roles r where r.id = role_id)))
  with check (app_private.mfa_policy_satisfied((select r.organization_id from public.roles r where r.id = role_id)));

create or replace function app_private.scope_rank(scope public.data_scope) returns integer language sql immutable set search_path = '' as $$
  select case scope when 'OWN_RECORDS' then 1 when 'OWN_TEAM' then 2 when 'ONE_BRANCH' then 3 when 'SELECTED_BRANCHES' then 4 when 'ALL_BRANCHES' then 5 when 'ORGANIZATION' then 6 when 'PLATFORM' then 7 end;
$$;

create or replace function app_private.validate_delegation_ceiling() returns trigger language plpgsql security definer set search_path = '' as $$
declare target_authority integer; actor_authority integer; actor_scope public.data_scope; actor_selected uuid[]; actor_branch uuid;
begin
  if auth.uid() is null or app_private.is_platform_admin() then return new; end if;
  if not app_private.has_permission(new.organization_id, 'user.manage') then raise exception using errcode = '42501', message = 'USER_MANAGE_PERMISSION_REQUIRED'; end if;
  select authority_level into target_authority from public.roles where id = new.role_id and organization_id = new.organization_id;
  select r.authority_level, ura.data_scope, ura.selected_branch_ids, ura.scope_branch_id into actor_authority, actor_scope, actor_selected, actor_branch
    from public.user_role_assignments ura join public.roles r on r.id = ura.role_id
    where ura.user_id = auth.uid() and ura.organization_id = new.organization_id and ura.active order by r.authority_level desc limit 1;
  if target_authority > actor_authority or app_private.scope_rank(new.data_scope) > app_private.scope_rank(actor_scope) then raise exception using errcode = '42501', message = 'DELEGATION_CEILING_EXCEEDED'; end if;
  if actor_scope = 'ONE_BRANCH' and (new.data_scope <> 'ONE_BRANCH' or new.scope_branch_id <> actor_branch) then raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED'; end if;
  if actor_scope = 'SELECTED_BRANCHES' and (
    (new.data_scope = 'ONE_BRANCH' and not (new.scope_branch_id = any(actor_selected)))
    or (new.data_scope = 'SELECTED_BRANCHES' and not new.selected_branch_ids <@ actor_selected)
  ) then raise exception using errcode = '42501', message = 'BRANCH_SCOPE_CEILING_EXCEEDED'; end if;
  return new;
end;
$$;
create trigger enforce_delegation_ceiling before insert or update of role_id, data_scope, scope_branch_id, selected_branch_ids on public.user_role_assignments for each row execute function app_private.validate_delegation_ceiling();

create or replace function public.possible_customer_matches(target_lead_id uuid)
returns table (customer_id uuid, full_name text, masked_phone text, masked_email text, match_reason text) language plpgsql stable security definer set search_path = '' as $$
declare lead_row public.leads%rowtype;
begin
  select * into lead_row from public.leads where id = target_lead_id and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND'; end if;
  if not app_private.can_access_record(lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id) then raise exception using errcode = '42501', message = 'SCOPE_DENIED'; end if;
  return query select c.id, c.full_name,
    case when c.primary_phone is null then null else left(c.primary_phone, 3) || '•••••' || right(c.primary_phone, 2) end,
    case when c.primary_email is null then null else left(c.primary_email, 2) || '•••@' || split_part(c.primary_email, '@', 2) end,
    case when c.normalized_phone = lead_row.normalized_phone then 'PHONE' else 'EMAIL' end
  from public.customers c where c.organization_id = lead_row.organization_id and c.deleted_at is null
    and (c.normalized_phone = lead_row.normalized_phone or (lead_row.email is not null and c.normalized_email = lower(trim(lead_row.email))))
  order by c.updated_at desc limit 10;
end;
$$;
revoke all on function public.possible_customer_matches(uuid) from public, anon;
grant execute on function public.possible_customer_matches(uuid) to authenticated;

create or replace function public.link_lead_to_customer(target_lead_id uuid, target_customer_id uuid, link_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads%rowtype;
begin
  select * into lead_row from public.leads where id = target_lead_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND'; end if;
  if lead_row.customer_id is not null then raise exception using errcode = '23505', message = 'LEAD_ALREADY_LINKED'; end if;
  if not app_private.has_permission(lead_row.organization_id, 'customer.link') or not app_private.can_access_record(lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id) then raise exception using errcode = '42501', message = 'PERMISSION_DENIED'; end if;
  if not exists (select 1 from public.customers c where c.id = target_customer_id and c.organization_id = lead_row.organization_id and c.deleted_at is null) then raise exception using errcode = '23503', message = 'CUSTOMER_NOT_IN_ORGANIZATION'; end if;
  update public.leads set customer_id = target_customer_id, updated_at = now() where id = target_lead_id;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata)
    values (lead_row.organization_id, auth.uid(), 'customer.link.reviewed', 'lead', target_lead_id::text, lead_row.branch_id, jsonb_build_object('customer_id', target_customer_id, 'reason', link_reason));
  return target_customer_id;
end;
$$;
revoke all on function public.link_lead_to_customer(uuid, uuid, text) from public, anon;
grant execute on function public.link_lead_to_customer(uuid, uuid, text) to authenticated;

commit;
