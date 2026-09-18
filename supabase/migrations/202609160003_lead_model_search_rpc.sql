begin;

-- Fast, debounced search RPC for interested model options when adding or updating leads.
-- Supports:
-- 1. Organization tenant isolation.
-- 2. Optional branch filtering (marks whether available stock exists at the target branch).
-- 3. Top-N limiting (default 5 for responsive debounced typeahead).
-- 4. Unified catalog + historic distinct lead models so consultants always get suggestions.
create or replace function public.get_interested_model_options(
  target_branch_id uuid default null,
  target_search text default '',
  target_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid := app_private.current_tenant_organization();
  clean_search text := left(btrim(coalesce(target_search, '')), 100);
  clean_limit integer := least(greatest(coalesce(target_limit, 5), 1), 20);
  result jsonb;
begin
  if auth.uid() is null or org is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if not (
    app_private.has_permission(org, 'lead.create')
    or app_private.has_permission(org, 'lead.view')
    or app_private.has_permission(org, 'lead.manage')
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  if target_branch_id is not null and not app_private.can_access_branch(org, target_branch_id) then
    raise exception using errcode = '42501', message = 'BRANCH_SCOPE_DENIED';
  end if;

  with catalog_models as (
    select
      m.id::text as id,
      m.name as model_name,
      b.name as brand_name,
      coalesce((
        select count(*)::int
        from public.stock_units s
        join public.vehicle_variants v
          on v.id = s.variant_id
         and v.organization_id = s.organization_id
        where s.organization_id = org
          and v.model_id = m.id
          and s.status = 'AVAILABLE'
          and s.deleted_at is null
          and (target_branch_id is null or s.branch_id = target_branch_id)
      ), 0) as stock_count
    from public.vehicle_models m
    join public.vehicle_brands b
      on b.id = m.brand_id
     and b.organization_id = m.organization_id
    where m.organization_id = org
      and m.active
      and b.active
      and (
        clean_search = ''
        or m.name ilike '%' || clean_search || '%'
        or b.name ilike '%' || clean_search || '%'
      )
  ),
  lead_models as (
    select distinct
      l.interested_model as id,
      l.interested_model as model_name,
      null::text as brand_name,
      0 as stock_count
    from public.leads l
    where l.organization_id = org
      and l.deleted_at is null
      and l.interested_model is not null
      and btrim(l.interested_model) <> ''
      and (target_branch_id is null or l.branch_id = target_branch_id)
      and (clean_search = '' or l.interested_model ilike '%' || clean_search || '%')
      and not exists (
        select 1 from catalog_models cm where lower(cm.model_name) = lower(btrim(l.interested_model))
      )
  ),
  combined as (
    select id, model_name, brand_name, stock_count, (stock_count > 0) as in_stock, 1 as priority
    from catalog_models
    union all
    select id, model_name, brand_name, stock_count, false as in_stock, 2 as priority
    from lead_models
  )
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
  into result
  from (
    select
      id,
      model_name,
      brand_name,
      in_stock,
      stock_count
    from combined
    order by
      case when target_branch_id is not null and in_stock then 0 else 1 end,
      priority,
      case when clean_search <> '' and model_name ilike clean_search || '%' then 0 else 1 end,
      model_name
    limit clean_limit
  ) r;

  return result;
end;
$$;

revoke all on function public.get_interested_model_options(uuid, text, integer) from public, anon;
grant execute on function public.get_interested_model_options(uuid, text, integer) to authenticated;

commit;
