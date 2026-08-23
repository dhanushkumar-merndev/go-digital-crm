-- Competitor profiles are tenant-owned reference data. They are never inferred
-- from a customer's free-text feedback; Client Admin explicitly maintains them.
begin;

create table public.competitor_vehicle_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  manufacturer text not null check (char_length(btrim(manufacturer)) between 2 and 120),
  model text not null check (char_length(btrim(model)) between 1 and 120),
  variant text not null check (char_length(btrim(variant)) between 1 and 160),
  fuel_type text,
  ex_showroom_price numeric(14,2) check (ex_showroom_price is null or ex_showroom_price >= 0),
  specifications jsonb not null default '{}'::jsonb check (jsonb_typeof(specifications) = 'object'),
  advantages jsonb not null default '[]'::jsonb check (jsonb_typeof(advantages) = 'array'),
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, manufacturer, model, variant)
);
create index competitor_vehicle_profiles_selector_idx
  on public.competitor_vehicle_profiles (organization_id, active, manufacturer, model, variant);
alter table public.competitor_vehicle_profiles enable row level security;
alter table public.competitor_vehicle_profiles force row level security;
revoke all on public.competitor_vehicle_profiles from anon, authenticated;

create or replace function public.list_sales_competitor_profiles()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not exists (
      select 1 from public.user_role_assignments assignment_row join public.roles role_row on role_row.id = assignment_row.role_id
      where assignment_row.user_id = auth.uid() and assignment_row.organization_id = current_organization_id
        and assignment_row.active and role_row.role_key = 'sales_consultant'
    )
  then raise exception using errcode = '42501', message = 'SALES_COMPETITOR_CATALOG_ACCESS_REQUIRED'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', profile_row.id, 'manufacturer', profile_row.manufacturer, 'model', profile_row.model,
    'variant', profile_row.variant, 'fuel_type', profile_row.fuel_type,
    'ex_showroom_price', profile_row.ex_showroom_price, 'specifications', profile_row.specifications,
    'advantages', profile_row.advantages
  ) order by profile_row.manufacturer, profile_row.model, profile_row.variant)
  from public.competitor_vehicle_profiles profile_row
  where profile_row.organization_id = current_organization_id and profile_row.active), '[]'::jsonb);
end;
$$;

create or replace function public.get_sales_competitor_comparison_options()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not exists (
      select 1 from public.user_role_assignments assignment_row join public.roles role_row on role_row.id = assignment_row.role_id
      where assignment_row.user_id = auth.uid() and assignment_row.organization_id = current_organization_id
        and assignment_row.active and role_row.role_key = 'sales_consultant'
    )
  then raise exception using errcode = '42501', message = 'SALES_COMPETITOR_CATALOG_ACCESS_REQUIRED'; end if;
  return jsonb_build_object(
    'our_variants', coalesce((select jsonb_agg(jsonb_build_object(
      'id', variant_row.id, 'brand', brand_row.name, 'model', model_row.name, 'variant', variant_row.name,
      'specifications', variant_row.specifications
    ) order by brand_row.name, model_row.name, variant_row.name)
    from public.vehicle_variants variant_row join public.vehicle_models model_row on model_row.id = variant_row.model_id
      join public.vehicle_brands brand_row on brand_row.id = model_row.brand_id
    where variant_row.organization_id = current_organization_id and variant_row.active and model_row.active and brand_row.active), '[]'::jsonb),
    'competitors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', profile_row.id, 'manufacturer', profile_row.manufacturer, 'model', profile_row.model, 'variant', profile_row.variant,
      'fuel_type', profile_row.fuel_type, 'ex_showroom_price', profile_row.ex_showroom_price,
      'specifications', profile_row.specifications, 'advantages', profile_row.advantages
    ) order by profile_row.manufacturer, profile_row.model, profile_row.variant)
    from public.competitor_vehicle_profiles profile_row where profile_row.organization_id = current_organization_id and profile_row.active), '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_competitor_vehicle_profile(
  target_id uuid, target_manufacturer text, target_model text, target_variant text,
  target_fuel_type text, target_ex_showroom_price numeric, target_specifications jsonb,
  target_advantages jsonb, target_active boolean, target_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare current_organization_id uuid; profile_row public.competitor_vehicle_profiles%rowtype;
begin
  if target_request_id is null or char_length(btrim(coalesce(target_manufacturer, ''))) not between 2 and 120
    or char_length(btrim(coalesce(target_model, ''))) not between 1 and 120
    or char_length(btrim(coalesce(target_variant, ''))) not between 1 and 160
    or coalesce(target_ex_showroom_price, 0) < 0
    or jsonb_typeof(coalesce(target_specifications, '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(target_advantages, '[]'::jsonb)) <> 'array'
  then raise exception using errcode = '22023', message = 'INVALID_COMPETITOR_PROFILE'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.mfa_policy_satisfied(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'user.manage')
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not exists (
      select 1 from public.user_role_assignments assignment_row join public.roles role_row on role_row.id = assignment_row.role_id
      where assignment_row.user_id = auth.uid() and assignment_row.organization_id = current_organization_id
        and assignment_row.active and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES') and role_row.role_key = 'client_admin'
    )
  then raise exception using errcode = '42501', message = 'COMPETITOR_PROFILE_MANAGE_REQUIRED'; end if;
  if target_id is null then
    insert into public.competitor_vehicle_profiles (organization_id, manufacturer, model, variant, fuel_type, ex_showroom_price, specifications, advantages, active, created_by, updated_by)
    values (current_organization_id, btrim(target_manufacturer), btrim(target_model), btrim(target_variant), nullif(btrim(coalesce(target_fuel_type, '')), ''), target_ex_showroom_price, coalesce(target_specifications, '{}'::jsonb), coalesce(target_advantages, '[]'::jsonb), coalesce(target_active, true), auth.uid(), auth.uid()) returning * into profile_row;
  else
    update public.competitor_vehicle_profiles set manufacturer = btrim(target_manufacturer), model = btrim(target_model), variant = btrim(target_variant), fuel_type = nullif(btrim(coalesce(target_fuel_type, '')), ''), ex_showroom_price = target_ex_showroom_price, specifications = coalesce(target_specifications, '{}'::jsonb), advantages = coalesce(target_advantages, '[]'::jsonb), active = coalesce(target_active, true), updated_by = auth.uid(), updated_at = now()
    where id = target_id and organization_id = current_organization_id returning * into profile_row;
    if not found then raise exception using errcode = 'P0002', message = 'COMPETITOR_PROFILE_NOT_FOUND'; end if;
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, request_id, metadata)
  values (current_organization_id, auth.uid(), 'competitor_profile.saved', 'competitor_vehicle_profile', profile_row.id::text, target_request_id, jsonb_build_object('active', profile_row.active));
  return jsonb_build_object('id', profile_row.id, 'manufacturer', profile_row.manufacturer, 'model', profile_row.model, 'variant', profile_row.variant, 'active', profile_row.active);
end;
$$;

create or replace function public.list_competitor_vehicle_profiles()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.mfa_policy_satisfied(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'user.manage')
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not exists (
      select 1 from public.user_role_assignments assignment_row join public.roles role_row on role_row.id = assignment_row.role_id
      where assignment_row.user_id = auth.uid() and assignment_row.organization_id = current_organization_id
        and assignment_row.active and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES') and role_row.role_key = 'client_admin'
    )
  then raise exception using errcode = '42501', message = 'COMPETITOR_PROFILE_MANAGE_REQUIRED'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', profile_row.id, 'manufacturer', profile_row.manufacturer, 'model', profile_row.model, 'variant', profile_row.variant,
    'fuel_type', profile_row.fuel_type, 'ex_showroom_price', profile_row.ex_showroom_price,
    'specifications', profile_row.specifications, 'advantages', profile_row.advantages, 'active', profile_row.active
  ) order by profile_row.active desc, profile_row.manufacturer, profile_row.model, profile_row.variant)
  from public.competitor_vehicle_profiles profile_row where profile_row.organization_id = current_organization_id), '[]'::jsonb);
end;
$$;

revoke all on function public.list_sales_competitor_profiles() from public, anon;
grant execute on function public.list_sales_competitor_profiles() to authenticated;
revoke all on function public.get_sales_competitor_comparison_options() from public, anon;
grant execute on function public.get_sales_competitor_comparison_options() to authenticated;
revoke all on function public.save_competitor_vehicle_profile(uuid, text, text, text, text, numeric, jsonb, jsonb, boolean, uuid) from public, anon;
grant execute on function public.save_competitor_vehicle_profile(uuid, text, text, text, text, numeric, jsonb, jsonb, boolean, uuid) to authenticated;
revoke all on function public.list_competitor_vehicle_profiles() from public, anon;
grant execute on function public.list_competitor_vehicle_profiles() to authenticated;
commit;
