-- Lead pickers (test drive, quotation, task) evaluated can_access_record,
-- can_access_customer and can_access_lead for every lead in the organization
-- before sorting and limiting. At 1,306 demo leads that already exceeded the
-- 8 s statement timeout, so each picker failed outright.
--
-- The replacement resolves the actor's scope once, then walks one ordered index
-- per scope branch (organization, branch, team, own records) and stops after
-- offset + limit rows. Search narrows first through the customer-name trigram,
-- phone-prefix and interested-model trigram indexes. `target_offset` supports a
-- "See more" control that fetches the next small page.

create index if not exists leads_org_interested_model_trgm_idx
  on public.leads using gin (lower(interested_model) gin_trgm_ops)
  where deleted_at is null and interested_model is not null;

create or replace function app_private.scoped_lead_option_page(
  target_organization_id uuid,
  target_search text,
  target_offset integer,
  target_limit integer,
  require_active_owner boolean
)
returns table(lead_id uuid, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  phone_key text;
  search_uuid uuid;
  matching_customer_ids uuid[] := array[]::uuid[];
  matching_lead_ids uuid[] := array[]::uuid[];
  scope_row record;
  window_size integer := target_offset + target_limit;
begin
  select * into scope_row
  from app_private.resolve_permission_record_scope(target_organization_id, array['lead.view']);
  if scope_row is null or not scope_row.granted then
    return;
  end if;

  if normalized_search <> '' then
    if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      search_uuid := normalized_search::uuid;
    end if;
    phone_key := app_private.phone_search_key(normalized_search);

    select coalesce(array_agg(customer_row.id), array[]::uuid[])
      into matching_customer_ids
    from (
      select customer_row.id
      from public.customers customer_row
      where customer_row.organization_id = target_organization_id
        and customer_row.deleted_at is null
        and customer_row.normalized_name ilike '%' || normalized_search || '%'
      limit 1000
    ) customer_row;

    if coalesce(phone_key, '') <> '' then
      select matching_customer_ids || coalesce(array_agg(customer_row.id), array[]::uuid[])
        into matching_customer_ids
      from (
        select customer_row.id
        from public.customers customer_row
        where customer_row.organization_id = target_organization_id
          and customer_row.deleted_at is null
          and coalesce(customer_row.normalized_phone, customer_row.primary_phone) is not null
          and app_private.phone_search_key(
            coalesce(customer_row.normalized_phone, customer_row.primary_phone)
          ) like phone_key || '%'
        limit 1000
      ) customer_row;
    end if;

    select coalesce(array_agg(lead_row.id), array[]::uuid[])
      into matching_lead_ids
    from (
      select lead_row.id
      from public.leads lead_row
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
        and lead_row.interested_model is not null
        and lower(lead_row.interested_model) like '%' || normalized_search || '%'
      limit 1000
    ) lead_row;

    if search_uuid is not null then
      matching_lead_ids := matching_lead_ids || search_uuid;
    end if;
  end if;

  return query
  with eligible as not materialized (
    select lead_row.id, lead_row.updated_at, lead_row.branch_id, lead_row.team_id,
      lead_row.assigned_user_id
    from public.leads lead_row
    join public.customers customer_row
      on customer_row.id = lead_row.customer_id
     and customer_row.organization_id = lead_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
     and branch_row.active
     and branch_row.deleted_at is null
    where lead_row.organization_id = target_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
      and (
        normalized_search = ''
        or lead_row.customer_id = any(matching_customer_ids)
        or lead_row.id = any(matching_lead_ids)
      )
      and (
        not require_active_owner
        or exists (
          select 1
          from public.profiles profile_row
          where profile_row.id = lead_row.assigned_user_id
            and profile_row.organization_id = lead_row.organization_id
            and profile_row.active
            and profile_row.deleted_at is null
        )
      )
  ), scoped as (
    (
      select eligible.id, eligible.updated_at from eligible
      where scope_row.organization_wide
      order by eligible.updated_at desc, eligible.id desc
      limit window_size
    )
    union
    (
      select eligible.id, eligible.updated_at from eligible
      where eligible.branch_id = any(scope_row.branch_scope_ids)
      order by eligible.updated_at desc, eligible.id desc
      limit window_size
    )
    union
    (
      select eligible.id, eligible.updated_at from eligible
      where eligible.team_id = any(scope_row.team_scope_ids)
      order by eligible.updated_at desc, eligible.id desc
      limit window_size
    )
    union
    (
      select eligible.id, eligible.updated_at from eligible
      where scope_row.own_records
        and eligible.assigned_user_id = auth.uid()
        and eligible.branch_id = any(scope_row.own_record_branch_ids)
      order by eligible.updated_at desc, eligible.id desc
      limit window_size
    )
  )
  select scoped.id, scoped.updated_at
  from scoped
  order by scoped.updated_at desc, scoped.id desc
  offset target_offset
  limit target_limit;
end;
$$;

revoke all on function app_private.scoped_lead_option_page(uuid, text, integer, integer, boolean)
  from public, anon, authenticated;

drop function if exists public.get_test_drive_lead_options(text, integer);
create function public.get_test_drive_lead_options(
  target_search text default '',
  target_limit integer default 25,
  target_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  result jsonb;
begin
  if char_length(btrim(coalesce(target_search, ''))) > 160
    or target_limit is null or target_limit not between 1 and 25
    or target_offset is null or target_offset not between 0 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_TEST_DRIVE_LEAD_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'test_drive.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not app_private.has_permission(current_organization_id, 'lead.view')
    or not app_private.has_permission(current_organization_id, 'lead.update')
  then raise exception using errcode = '42501', message = 'TEST_DRIVE_MANAGE_PERMISSION_REQUIRED'; end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'lead_id', lead_row.id,
        'customer_id', lead_row.customer_id,
        'branch_id', lead_row.branch_id,
        'team_id', lead_row.team_id,
        'assigned_user_id', lead_row.assigned_user_id,
        'customer_name', customer_row.full_name,
        'phone', customer_row.primary_phone,
        'interested_model', lead_row.interested_model,
        'branch_name', branch_row.name,
        'assigned_user_name', profile_row.full_name,
        'updated_at', lead_row.updated_at
      )
      order by page_row.updated_at desc, page_row.lead_id desc
    ),
    '[]'::jsonb
  )
    into result
  from app_private.scoped_lead_option_page(
    current_organization_id, target_search, target_offset, target_limit, true
  ) page_row
  join public.leads lead_row on lead_row.id = page_row.lead_id
  join public.customers customer_row on customer_row.id = lead_row.customer_id
  join public.branches branch_row on branch_row.id = lead_row.branch_id
  join public.profiles profile_row on profile_row.id = lead_row.assigned_user_id;
  return result;
end;
$$;

drop function if exists public.get_quotation_lead_options(text, integer);
create function public.get_quotation_lead_options(
  target_search text default '',
  target_limit integer default 25,
  target_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  result jsonb;
begin
  if char_length(btrim(coalesce(target_search, ''))) > 160
    or target_limit is null or target_limit not between 1 and 25
    or target_offset is null or target_offset not between 0 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_QUOTATION_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'quotation.manage')
  then raise exception using errcode = '42501', message = 'QUOTATION_MANAGE_PERMISSION_REQUIRED'; end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'lead_id', lead_row.id,
        'customer_id', lead_row.customer_id,
        'branch_id', lead_row.branch_id,
        'team_id', lead_row.team_id,
        'assigned_user_id', lead_row.assigned_user_id,
        'customer_name', customer_row.full_name,
        'phone', customer_row.primary_phone,
        'interested_model', lead_row.interested_model,
        'branch_name', branch_row.name,
        'lifecycle_status', lead_row.lifecycle_status,
        'updated_at', lead_row.updated_at
      )
      order by page_row.updated_at desc, page_row.lead_id desc
    ),
    '[]'::jsonb
  )
    into result
  from app_private.scoped_lead_option_page(
    current_organization_id, target_search, target_offset, target_limit, false
  ) page_row
  join public.leads lead_row on lead_row.id = page_row.lead_id
  join public.customers customer_row on customer_row.id = lead_row.customer_id
  join public.branches branch_row on branch_row.id = lead_row.branch_id;
  return result;
end;
$$;

drop function if exists public.get_task_lead_options(text, integer);
create function public.get_task_lead_options(
  target_search text default '',
  target_limit integer default 25,
  target_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  result jsonb;
begin
  if char_length(btrim(coalesce(target_search, ''))) > 160
    or target_limit is null or target_limit not between 1 and 25
    or target_offset is null or target_offset not between 0 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.create')
  then
    raise exception using errcode = '42501', message = 'TASK_CREATE_PERMISSION_REQUIRED';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'lead_id', lead_row.id,
        'customer_id', lead_row.customer_id,
        'branch_id', lead_row.branch_id,
        'team_id', lead_row.team_id,
        'customer_name', customer_row.full_name,
        'phone', customer_row.primary_phone,
        'interested_model', lead_row.interested_model,
        'branch_name', branch_row.name,
        'updated_at', lead_row.updated_at
      )
      order by page_row.updated_at desc, page_row.lead_id desc
    ),
    '[]'::jsonb
  )
    into result
  from app_private.scoped_lead_option_page(
    current_organization_id, target_search, target_offset, target_limit, false
  ) page_row
  join public.leads lead_row on lead_row.id = page_row.lead_id
  join public.customers customer_row on customer_row.id = lead_row.customer_id
  join public.branches branch_row on branch_row.id = lead_row.branch_id;
  return result;
end;
$$;

revoke all on function public.get_test_drive_lead_options(text, integer, integer) from public, anon;
revoke all on function public.get_quotation_lead_options(text, integer, integer) from public, anon;
revoke all on function public.get_task_lead_options(text, integer, integer) from public, anon;
grant execute on function public.get_test_drive_lead_options(text, integer, integer) to authenticated, service_role;
grant execute on function public.get_quotation_lead_options(text, integer, integer) to authenticated, service_role;
grant execute on function public.get_task_lead_options(text, integer, integer) to authenticated, service_role;
