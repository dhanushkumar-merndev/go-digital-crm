begin;

-- The Inventory vehicle list (get_stock_unit_page) called
-- app_private.can_access_branch once per stock unit, although its result
-- depends only on the branch and a dealership has a handful of branches:
-- ~120 ms for the demo tenant's units, growing with stock. The viewer's
-- accessible branches are now resolved once per call; rows, counts, KPIs and
-- errors are unchanged.
--
-- Verified before deploy as a temporary copy against the live function:
-- 256/256 identical results (8 roles x status, search, age, sort, page and
-- branch filters, including denied roles and an out-of-scope branch). Median
-- per call 116-121 ms -> ~6 ms.
--
-- Patched in place from the deployed definition (never re-emitted), and the
-- result must be byte-identical to the verified text.
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.get_stock_unit_page(text,integer,integer,text,uuid,text,text)'::regprocedure
  );
begin
  if (length(definition) - length(replace(definition, $o$declare result jsonb;
begin
$o$, ''))) / length($o$declare result jsonb;
begin
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'STOCK_UNIT_PAGE_PATCH_TARGET_NOT_FOUND: edit 1';
  end if;
  definition := replace(definition, $o$declare result jsonb;
begin
$o$, $n$declare result jsonb;
declare accessible_branch_ids uuid[];
begin
$n$);
  if (length(definition) - length(replace(definition, $o$    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_units as materialized (
$o$, ''))) / length($o$    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_units as materialized (
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'STOCK_UNIT_PAGE_PATCH_TARGET_NOT_FOUND: edit 2';
  end if;
  definition := replace(definition, $o$    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;

  with scoped_units as materialized (
$o$, $n$    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;
  -- can_access_branch depends only on the branch: resolve the viewer's
  -- branches once instead of once per stock unit.
  accessible_branch_ids := array(
    select branch_row.id
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and app_private.can_access_branch(current_organization_id, branch_row.id)
  );

  with scoped_units as materialized (
$n$);
  if (length(definition) - length(replace(definition, $o$      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
  ), filtered_units as materialized (
$o$, ''))) / length($o$      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
  ), filtered_units as materialized (
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'STOCK_UNIT_PAGE_PATCH_TARGET_NOT_FOUND: edit 3';
  end if;
  definition := replace(definition, $o$      and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
  ), filtered_units as materialized (
$o$, $n$      and stock_row.branch_id = any(accessible_branch_ids)
  ), filtered_units as materialized (
$n$);

  if md5(definition) <> '118df2395f68dbf7345fd939ad8568b1' then
    raise exception using errcode = 'P0001', message = 'STOCK_UNIT_PAGE_PATCH_UNVERIFIED: ' || md5(definition);
  end if;
  execute definition;
end;
$migration$;

commit;
