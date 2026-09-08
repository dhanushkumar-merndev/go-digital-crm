begin;

-- Quotations are keyed in by hand today: a consultant reads the price list off
-- a PDF and retypes ex-showroom, insurance and registration into every quote,
-- because the vehicle master has nowhere to hold them. `vehicle_variants`
-- carries a name, a model and a `specifications` jsonb, and nothing else.
--
-- Price sits on the variant rather than the model: it moves with fuel type and
-- trim, so two variants of one model rarely share an ex-showroom figure.
--
-- These are real numeric columns rather than three more `specifications` keys.
-- They are money on a customer-facing document, so they need a numeric type and
-- a non-negative constraint; `specifications` is untyped jsonb and can enforce
-- neither. Every column is nullable -- a dealership that has not loaded its
-- price list keeps working exactly as it does now, and the quotation form fills
-- in only what is actually set.

alter table public.vehicle_variants
  add column if not exists ex_showroom_price numeric(14, 2),
  add column if not exists insurance_amount numeric(14, 2),
  add column if not exists registration_amount numeric(14, 2);

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vehicle_variants_pricing_non_negative'
      and conrelid = 'public.vehicle_variants'::regclass
  ) then
    alter table public.vehicle_variants
      add constraint vehicle_variants_pricing_non_negative check (
        (ex_showroom_price is null or ex_showroom_price >= 0)
        and (insurance_amount is null or insurance_amount >= 0)
        and (registration_amount is null or registration_amount >= 0)
      );
  end if;
end;
$constraints$;

-- Return the new columns from the master-data list so the workspace can show
-- and edit them. 202609070101 rewrote this function into a generic dynamic-SQL
-- reader, so patch the installed definition rather than restating a body that
-- another migration may have extended since.
do $migration$
declare
  definition text;
  updated_definition text;
  anchor constant text :=
    ', r.model_id, m.name as model_name, b.name as brand_name, r.specifications';
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_master_data_workspace(text,integer,integer,text)'::regprocedure
  ) into definition;

  if position('ex_showroom_price' in definition) > 0 then
    return;
  end if;
  if position(anchor in definition) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'VARIANT_PRICING_PROJECTION_ANCHOR_NOT_FOUND';
  end if;

  updated_definition := replace(
    definition,
    anchor,
    anchor || ', r.ex_showroom_price, r.insurance_amount, r.registration_amount'
  );
  execute updated_definition;
end;
$migration$;

-- Pricing is written on its own rather than through `save_vehicle_master`.
-- That function is the shared write boundary for five master-data categories
-- and takes one jsonb for per-category detail; widening its signature for three
-- numeric columns that apply to exactly one category would push a variant-only
-- concern into every other category's path.
create or replace function public.set_variant_pricing(
  target_variant_id uuid,
  target_ex_showroom_price numeric default null,
  target_insurance_amount numeric default null,
  target_registration_amount numeric default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  org uuid := app_private.current_tenant_organization();
  variant_row public.vehicle_variants%rowtype;
begin
  if auth.uid() is null or org is null
    or not app_private.has_permission(org, 'integration.manage') then
    raise exception using
      errcode = '42501', message = 'MASTER_DATA_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_variant_id is null
    or coalesce(target_ex_showroom_price, 0) < 0
    or coalesce(target_insurance_amount, 0) < 0
    or coalesce(target_registration_amount, 0) < 0 then
    raise exception using errcode = '22023', message = 'INVALID_VARIANT_PRICING';
  end if;

  -- Scoped by organization as well as id: a uuid on its own is not tenant proof.
  update public.vehicle_variants set
    ex_showroom_price = target_ex_showroom_price,
    insurance_amount = target_insurance_amount,
    registration_amount = target_registration_amount
  where id = target_variant_id and organization_id = org
  returning * into variant_row;

  if variant_row.id is null then
    raise exception using errcode = '42501', message = 'VARIANT_NOT_IN_SCOPE';
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    org, auth.uid(), 'master_data.variant_pricing_saved', 'vehicle_variant',
    variant_row.id::text,
    jsonb_build_object('ex_showroom_price', variant_row.ex_showroom_price)
  );

  return jsonb_build_object(
    'id', variant_row.id,
    'ex_showroom_price', variant_row.ex_showroom_price,
    'insurance_amount', variant_row.insurance_amount,
    'registration_amount', variant_row.registration_amount
  );
end; $$;

-- Read side for the quotation form. It holds model and variant as names, not
-- ids, because its dropdowns are built from stock rows, so the lookup is by
-- name within the caller's own tenant.
create or replace function public.get_quotation_variant_pricing(
  target_branch_id uuid default null,
  target_model text default null,
  target_variant text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  org uuid := app_private.current_tenant_organization();
  result jsonb;
begin
  if auth.uid() is null or org is null
    or not (
      app_private.has_permission(org, 'inventory.stock_check')
      or app_private.has_permission(org, 'inventory.view')
    ) then
    raise exception using errcode = '42501', message = 'STOCK_CHECK_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(org, target_branch_id) then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  select jsonb_build_object(
    'ex_showroom_price', variant_row.ex_showroom_price,
    'insurance_amount', variant_row.insurance_amount,
    'registration_amount', variant_row.registration_amount
  ) into result
  from public.vehicle_variants variant_row
  join public.vehicle_models model_row
    on model_row.id = variant_row.model_id
   and model_row.organization_id = variant_row.organization_id
  where variant_row.organization_id = org
    and variant_row.active
    and model_row.name = btrim(coalesce(target_model, ''))
    and variant_row.name = btrim(coalesce(target_variant, ''))
  limit 1;

  return coalesce(result, '{}'::jsonb);
end; $$;

revoke all on function public.set_variant_pricing(uuid, numeric, numeric, numeric)
  from public, anon;
revoke all on function public.get_quotation_variant_pricing(uuid, text, text)
  from public, anon;
grant execute on function public.set_variant_pricing(uuid, numeric, numeric, numeric)
  to authenticated;
grant execute on function public.get_quotation_variant_pricing(uuid, text, text)
  to authenticated;

commit;
