begin;

-- A deliberately small, page-based lookup for the application header.  This is
-- not a tenant export: callers must provide a meaningful search term and still
-- pass the same customer scope guard used by Customer 360.
create or replace function public.search_authorized_customers(
  target_search text,
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) not between 2 and 160 then
    raise exception using errcode = '22023', message = 'GLOBAL_CUSTOMER_SEARCH_REQUIRES_2_TO_160_CHARACTERS';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id
  into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;

  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  with matched_rows as materialized (
    select
      customer_row.id,
      customer_row.full_name,
      customer_row.primary_phone,
      customer_row.primary_email,
      customer_row.updated_at
    from public.customers customer_row
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and app_private.can_access_customer(customer_row.organization_id, customer_row.id)
      and (
        customer_row.id = search_uuid
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or customer_row.normalized_email = normalized_search
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone) = search_phone_digits
        )
      )
    order by customer_row.updated_at desc, customer_row.id desc
    limit target_page_size + 1
    offset (target_page - 1) * target_page_size
  ), page_rows as (
    select *
    from matched_rows
    order by updated_at desc, id desc
    limit target_page_size
  )
  select jsonb_build_object(
    'records', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'full_name', page_row.full_name,
            'primary_phone', page_row.primary_phone,
            'primary_email', page_row.primary_email,
            'updated_at', page_row.updated_at
          )
          order by page_row.updated_at desc, page_row.id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    'has_next', (select count(*) > target_page_size from matched_rows)
  ) into result;

  return result;
end;
$$;

revoke all on function public.search_authorized_customers(text, integer, integer) from public, anon;
grant execute on function public.search_authorized_customers(text, integer, integer) to authenticated;

commit;
