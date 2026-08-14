begin;

alter table public.test_drive_appointments add constraint test_drive_appointment_stock_fk foreign key (stock_unit_id) references public.stock_units(id);
alter table public.stock_allocations add constraint stock_allocation_booking_fk foreign key (booking_id) references public.bookings(id);

create table public.finance_case_documents (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), finance_case_id uuid not null references public.finance_cases(id),
  document_type text not null, object_file_id uuid not null references public.object_files(id), status text not null default 'UPLOADED', created_at timestamptz not null default now()
);
create table public.insurance_case_documents (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), insurance_case_id uuid not null references public.insurance_cases(id),
  document_type text not null, object_file_id uuid not null references public.object_files(id), status text not null default 'UPLOADED', created_at timestamptz not null default now()
);
create table public.rto_case_documents (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), rto_case_id uuid not null references public.rto_cases(id),
  document_type text not null, object_file_id uuid not null references public.object_files(id), status text not null default 'UPLOADED', created_at timestamptz not null default now()
);
create table public.tenant_installations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), installation_key text not null,
  status text not null default 'ACTIVE', configuration jsonb not null default '{}'::jsonb, installed_by uuid references public.profiles(id), created_at timestamptz not null default now(), unique (organization_id, installation_key)
);

create or replace view public.ai_credit_ledger with (security_invoker = true) as select * from public.credit_ledger where ledger_kind = 'AI';
create or replace view public.tracking_credit_ledger with (security_invoker = true) as select * from public.credit_ledger where ledger_kind = 'TRACKING';

create or replace function public.authorize_action(target_organization_id uuid, target_permission text, target_branch_id uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.has_permission(target_organization_id, target_permission)
    and (target_branch_id is null or app_private.can_access_branch(target_organization_id, target_branch_id));
$$;
revoke all on function public.authorize_action(uuid, text, uuid) from public, anon;
grant execute on function public.authorize_action(uuid, text, uuid) to authenticated;

create or replace function app_private.can_access_customer(target_organization_id uuid, target_customer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.is_platform_admin() or (
    app_private.can_access_organization(target_organization_id) and exists (
      select 1 from public.user_role_assignments ura
      where ura.user_id = auth.uid() and ura.organization_id = target_organization_id and ura.active and (
        ura.data_scope in ('ORGANIZATION','ALL_BRANCHES')
        or exists (
          select 1 from public.leads l
          where l.organization_id = target_organization_id and l.customer_id = target_customer_id and l.deleted_at is null and (
            (ura.data_scope = 'OWN_RECORDS' and l.assigned_user_id = auth.uid())
            or (ura.data_scope = 'OWN_TEAM' and l.team_id in (select tm.team_id from public.team_members tm where tm.user_id = auth.uid() and tm.active))
            or (ura.data_scope = 'ONE_BRANCH' and l.branch_id = ura.scope_branch_id)
            or (ura.data_scope = 'SELECTED_BRANCHES' and l.branch_id = any(ura.selected_branch_ids))
          )
        )
      )
    )
  );
$$;

drop policy if exists tenant_record_scope on public.customers;
create policy customer_context_scope on public.customers for all to authenticated
  using (app_private.can_access_customer(organization_id, id))
  with check (app_private.has_permission(organization_id, 'customer.link'));

drop policy if exists tenant_record_scope on public.customer_contacts;
create policy customer_contact_context_scope on public.customer_contacts for all to authenticated
  using (app_private.can_access_customer(organization_id, customer_id))
  with check (app_private.can_access_customer(organization_id, customer_id));
drop policy if exists tenant_record_scope on public.customer_addresses;
create policy customer_address_context_scope on public.customer_addresses for all to authenticated
  using (app_private.can_access_customer(organization_id, customer_id))
  with check (app_private.can_access_customer(organization_id, customer_id));
drop policy if exists tenant_record_scope on public.customer_vehicles;
create policy customer_vehicle_context_scope on public.customer_vehicles for all to authenticated
  using (app_private.can_access_customer(organization_id, customer_id))
  with check (app_private.can_access_customer(organization_id, customer_id));

drop policy if exists tenant_record_scope on public.profiles;
create policy profile_directory_scope on public.profiles for select to authenticated using (
  id = auth.uid() or app_private.is_platform_admin() or (
    app_private.can_access_organization(organization_id) and exists (
      select 1 from public.user_role_assignments ura where ura.user_id = auth.uid() and ura.organization_id = profiles.organization_id and ura.active and (
        ura.data_scope in ('ORGANIZATION','ALL_BRANCHES','ONE_BRANCH','SELECTED_BRANCHES')
        or exists (
          select 1 from public.team_members self_tm join public.team_members target_tm on target_tm.team_id = self_tm.team_id
          where self_tm.user_id = auth.uid() and target_tm.user_id = profiles.id and self_tm.active and target_tm.active
        )
      )
    )
  )
);
create policy profile_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

do $$
declare table_name text;
begin
  foreach table_name in array array['finance_case_documents','insurance_case_documents','rto_case_documents','tenant_installations']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('create policy tenant_record_scope on public.%I for all to authenticated using (app_private.can_access_organization(organization_id)) with check (app_private.can_access_organization(organization_id))', table_name);
  end loop;
end $$;

commit;
