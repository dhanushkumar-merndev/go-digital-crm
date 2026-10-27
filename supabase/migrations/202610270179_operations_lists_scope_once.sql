-- Operations list pages: resolve the caller's scope once.
--
-- Stock Transfer (1.9-2.3 s), Stock Allocation (0.9 s), Customer Care Reviews
-- (1.5 s) and Delivery Feedback (1.0 s) called can_access_branch,
-- can_access_record or can_access_customer once per row. Accessible branches are
-- now resolved once into an array (exact: a branch's answer is the same for every
-- row in it). Delivery Feedback keeps the per-record check only for branches not
-- fully visible, and reads customer access from resolve_customer_access_scope,
-- the predicate already used by the appointment calendar.
-- Bodies are the deployed definitions with anchored edits.

begin;

CREATE OR REPLACE FUNCTION public.get_stock_movement_page(target_search text DEFAULT ''::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_movement_type text DEFAULT 'ALL'::text, target_branch_id uuid DEFAULT NULL::uuid, target_sort text DEFAULT 'moved:desc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid;
declare accessible_branch_ids uuid[];
declare normalized_search text;
declare identifier_search text;
declare normalized_movement_type text := upper(btrim(coalesce(target_movement_type, 'ALL')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_movement_type not in (
    'ALL', 'INTAKE', 'DETAIL_UPDATE', 'STATUS_CHANGE', 'BRANCH_TRANSFER',
    'ALLOCATION', 'ALLOCATION_RELEASE'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_MOVEMENT_TYPE_FILTER';
  end if;
  if target_sort not in ('moved:desc', 'moved:asc', 'vin:asc', 'type:asc') then
    raise exception using errcode = '22023', message = 'INVALID_MOVEMENT_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  identifier_search := app_private.normalize_inventory_identifier(normalized_search);

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;
  -- Branches the caller can open, resolved once instead of can_access_branch per row.
  select coalesce(array_agg(branch_row.id), array[]::uuid[])
    into accessible_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and app_private.can_access_branch(current_organization_id, branch_row.id);

  with scoped_movements as materialized (
    select
      movement_row.id,
      movement_row.stock_unit_id,
      movement_row.from_branch_id,
      movement_row.to_branch_id,
      movement_row.movement_type,
      movement_row.reason,
      movement_row.moved_at,
      stock_row.vin,
      stock_row.normalized_vin,
      stock_row.status as stock_status,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      from_branch_row.name as from_branch_name,
      to_branch_row.name as to_branch_name,
      actor_row.full_name as moved_by_name
    from public.stock_movements movement_row
    join public.stock_units stock_row
      on stock_row.organization_id = movement_row.organization_id
     and stock_row.id = movement_row.stock_unit_id
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = stock_row.organization_id
     and brand_row.id = model_row.brand_id
    left join public.branches from_branch_row
      on from_branch_row.organization_id = movement_row.organization_id
     and from_branch_row.id = movement_row.from_branch_id
    left join public.branches to_branch_row
      on to_branch_row.organization_id = movement_row.organization_id
     and to_branch_row.id = movement_row.to_branch_id
    left join public.profiles actor_row
      on actor_row.organization_id = movement_row.organization_id
     and actor_row.id = movement_row.moved_by
    where movement_row.organization_id = current_organization_id
      and (
        (
          movement_row.from_branch_id is not null
          and movement_row.from_branch_id = any(accessible_branch_ids)
        )
        or (
          movement_row.to_branch_id is not null
          and movement_row.to_branch_id = any(accessible_branch_ids)
        )
      )
  ), filtered_movements as materialized (
    select scoped_row.*
    from scoped_movements scoped_row
    where (
      normalized_movement_type = 'ALL'
      or scoped_row.movement_type = normalized_movement_type
    )
      and (
        target_branch_id is null
        or scoped_row.from_branch_id = target_branch_id
        or scoped_row.to_branch_id = target_branch_id
      )
      and (
        normalized_search = ''
        or (
          identifier_search <> ''
          and scoped_row.normalized_vin like identifier_search || '%'
        )
        or lower(scoped_row.model_name) like '%' || normalized_search || '%'
        or lower(scoped_row.variant_name) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.from_branch_name, '')) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.to_branch_name, '')) like '%' || normalized_search || '%'
        or lower(coalesce(scoped_row.reason, '')) like '%' || normalized_search || '%'
      )
  ), page_rows as (
    select filtered_row.*
    from filtered_movements filtered_row
    order by
      case when target_sort = 'moved:desc' then filtered_row.moved_at end desc,
      case when target_sort = 'moved:asc' then filtered_row.moved_at end asc,
      case when target_sort = 'vin:asc' then filtered_row.normalized_vin end asc,
      case when target_sort = 'type:asc' then filtered_row.movement_type end asc,
      filtered_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(
        to_jsonb(page_row) - 'normalized_vin'
        order by
          case when target_sort = 'moved:desc' then page_row.moved_at end desc,
          case when target_sort = 'moved:asc' then page_row.moved_at end asc,
          case when target_sort = 'vin:asc' then page_row.normalized_vin end asc,
          case when target_sort = 'type:asc' then page_row.movement_type end asc,
          page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_movements),
    'kpis', jsonb_build_object(
      'movements_today', count(*) filter (
        where scoped_row.moved_at >= date_trunc('day', now())
      ),
      'transfers', count(*) filter (
        where scoped_row.movement_type = 'BRANCH_TRANSFER'
      ),
      'intakes', count(*) filter (where scoped_row.movement_type = 'INTAKE'),
      'status_changes', count(*) filter (
        where scoped_row.movement_type = 'STATUS_CHANGE'
      )
    )
  ) into result
  from scoped_movements scoped_row;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_stock_allocation_page(target_search text DEFAULT ''::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25, target_status text DEFAULT 'ALL'::text, target_branch_id uuid DEFAULT NULL::uuid, target_sort text DEFAULT 'allocated:desc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_organization_id uuid;
declare accessible_branch_ids uuid[];
declare normalized_search text;
declare identifier_search text;
declare normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
declare result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in (
    'ALL', 'ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED',
    'ON_HOLD', 'RELEASED', 'CANCELLED'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_STATUS_FILTER';
  end if;
  if target_sort not in ('allocated:desc', 'allocated:asc', 'booking:asc', 'vin:asc') then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_SORT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 100 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  identifier_search := app_private.normalize_inventory_identifier(normalized_search);

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'inventory.view')
  then
    raise exception using errcode = '42501', message = 'INVENTORY_VIEW_REQUIRED';
  end if;
  if target_branch_id is not null
    and not app_private.can_access_branch(current_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'INVENTORY_BRANCH_SCOPE_DENIED';
  end if;
  -- Branches the caller can open, resolved once instead of can_access_branch per row.
  select coalesce(array_agg(branch_row.id), array[]::uuid[])
    into accessible_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and app_private.can_access_branch(current_organization_id, branch_row.id);

  with scoped_allocations as materialized (
    select
      allocation_row.id,
      allocation_row.organization_id,
      allocation_row.branch_id,
      allocation_row.stock_unit_id,
      allocation_row.booking_id,
      allocation_row.allocation_method,
      allocation_row.status,
      allocation_row.allocated_at,
      allocation_row.released_at,
      allocation_row.release_reason,
      allocation_row.updated_at,
      allocation_row.version,
      stock_row.version as stock_version,
      stock_row.vin,
      stock_row.normalized_vin,
      stock_row.status as stock_status,
      stock_row.color,
      branch_row.name as branch_name,
      brand_row.name as brand_name,
      model_row.name as model_name,
      variant_row.name as variant_name,
      booking_row.booking_number,
      actor_row.full_name as allocated_by_name
    from public.stock_allocations allocation_row
    join public.stock_units stock_row
      on stock_row.organization_id = allocation_row.organization_id
     and stock_row.id = allocation_row.stock_unit_id
     and stock_row.deleted_at is null
    join public.branches branch_row
      on branch_row.organization_id = allocation_row.organization_id
     and branch_row.id = allocation_row.branch_id
     and branch_row.deleted_at is null
    join public.vehicle_variants variant_row
      on variant_row.organization_id = stock_row.organization_id
     and variant_row.id = stock_row.variant_id
    join public.vehicle_models model_row
      on model_row.organization_id = stock_row.organization_id
     and model_row.id = variant_row.model_id
    join public.vehicle_brands brand_row
      on brand_row.organization_id = stock_row.organization_id
     and brand_row.id = model_row.brand_id
    left join public.bookings booking_row
      on booking_row.organization_id = allocation_row.organization_id
     and booking_row.id = allocation_row.booking_id
    left join public.profiles actor_row
      on actor_row.organization_id = allocation_row.organization_id
     and actor_row.id = allocation_row.allocated_by
    where allocation_row.organization_id = current_organization_id
      and allocation_row.branch_id = any(accessible_branch_ids)
  ), filtered_allocations as materialized (
    select scoped_row.*
    from scoped_allocations scoped_row
    where (normalized_status = 'ALL' or scoped_row.status = normalized_status)
      and (target_branch_id is null or scoped_row.branch_id = target_branch_id)
      and (
        normalized_search = ''
        or (
          identifier_search <> ''
          and scoped_row.normalized_vin like identifier_search || '%'
        )
        or lower(coalesce(scoped_row.booking_number, '')) like '%' || normalized_search || '%'
        or lower(scoped_row.model_name) like '%' || normalized_search || '%'
        or lower(scoped_row.variant_name) like '%' || normalized_search || '%'
      )
  ), page_rows as (
    select filtered_row.*
    from filtered_allocations filtered_row
    order by
      case when target_sort = 'allocated:desc' then filtered_row.allocated_at end desc,
      case when target_sort = 'allocated:asc' then filtered_row.allocated_at end asc,
      case when target_sort = 'booking:asc' then lower(filtered_row.booking_number) end asc nulls last,
      case when target_sort = 'vin:asc' then filtered_row.normalized_vin end asc,
      filtered_row.id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(
        to_jsonb(page_row) - 'normalized_vin' - 'organization_id'
        order by
          case when target_sort = 'allocated:desc' then page_row.allocated_at end desc,
          case when target_sort = 'allocated:asc' then page_row.allocated_at end asc,
          case when target_sort = 'booking:asc' then lower(page_row.booking_number) end asc nulls last,
          case when target_sort = 'vin:asc' then page_row.normalized_vin end asc,
          page_row.id asc
      ) from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered_allocations),
    'kpis', jsonb_build_object(
      'active', count(*) filter (
        where scoped_row.status in ('ACTIVE', 'PENDING', 'SUGGESTED', 'ON_HOLD')
      ),
      'reserved', count(*) filter (where scoped_row.status = 'RESERVED'),
      'allocated', count(*) filter (where scoped_row.status = 'ALLOCATED'),
      'released', count(*) filter (where scoped_row.status = 'RELEASED')
    )
  ) into result
  from scoped_allocations scoped_row;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_review_approval_queue(target_view text DEFAULT 'AWAITING'::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_organization_id uuid;
  normalized_view text := upper(btrim(coalesce(target_view, 'AWAITING')));
  offset_rows integer;
  accessible_branch_ids uuid[];
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer_care.view')
  then
    raise exception using errcode = '42501', message = 'REVIEW_QUEUE_ACCESS_REQUIRED';
  end if;
  if normalized_view not in ('AWAITING', 'INVITED', 'ALL') then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_QUEUE_VIEW';
  end if;
  if target_page not between 1 and 100000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_QUEUE_PAGE';
  end if;
  offset_rows := (target_page - 1) * target_page_size;
  -- Branches the caller can open, resolved once instead of can_access_branch per row.
  select coalesce(array_agg(branch_row.id), array[]::uuid[])
    into accessible_branch_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and app_private.can_access_branch(current_organization_id, branch_row.id);

  return jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feedback_id', feedback_row.id,
        'customer', coalesce(customer_row.full_name, 'Customer'),
        'branch', branch_row.name,
        'rating', feedback_row.rating,
        'comments', feedback_row.comments,
        'completed_at', feedback_row.completed_at,
        'approved_at', feedback_row.approved_at,
        'review_request_id', feedback_row.review_request_id
      ) order by feedback_row.completed_at desc, feedback_row.id desc)
      from (
        select * from public.feedback_requests source_row
        where source_row.organization_id = current_organization_id
          and source_row.status = 'COMPLETED'
          and source_row.rating is not null
          and source_row.branch_id = any(accessible_branch_ids)
          and (
            normalized_view = 'ALL'
            or (normalized_view = 'AWAITING' and source_row.review_request_id is null)
            or (normalized_view = 'INVITED' and source_row.review_request_id is not null)
          )
        order by source_row.completed_at desc, source_row.id desc
        limit target_page_size offset offset_rows
      ) feedback_row
      join public.branches branch_row on branch_row.id = feedback_row.branch_id
      left join public.customers customer_row on customer_row.id = feedback_row.customer_id
    ), '[]'::jsonb),
    'total', (
      select count(*)::integer from public.feedback_requests source_row
      where source_row.organization_id = current_organization_id
        and source_row.status = 'COMPLETED'
        and source_row.rating is not null
        and source_row.branch_id = any(accessible_branch_ids)
        and (
          normalized_view = 'ALL'
          or (normalized_view = 'AWAITING' and source_row.review_request_id is null)
          or (normalized_view = 'INVITED' and source_row.review_request_id is not null)
        )
    ),
    -- Counted once here so the tabs do not each run their own query.
    'counts', (
      select jsonb_build_object(
        'awaiting', count(*) filter (where source_row.review_request_id is null)::integer,
        'invited', count(*) filter (where source_row.review_request_id is not null)::integer
      )
      from public.feedback_requests source_row
      where source_row.organization_id = current_organization_id
        and source_row.status = 'COMPLETED'
        and source_row.rating is not null
        and source_row.branch_id = any(accessible_branch_ids)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_delivery_feedback_workspace_page(target_status text DEFAULT 'PENDING'::text, target_search text DEFAULT ''::text, target_page integer DEFAULT 1, target_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  branch_wide_ids uuid[];
  customer_scope record;
  current_organization_id uuid;
  normalized_status text := upper(btrim(coalesce(target_status, 'PENDING')));
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if normalized_status not in ('ALL', 'NOT_REQUESTED', 'PENDING', 'COMPLETED')
    or char_length(normalized_search) > 160
    or target_page is null or target_page not between 1 and 1000000
    or target_page_size is null or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_DELIVERY_FEEDBACK_QUERY';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'delivery.view')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'DELIVERY_FEEDBACK_VIEW_PERMISSION_REQUIRED';
  end if;
  -- can_access_record with no team and no owner passes only through branch-wide
  -- scope (or a support session), and then for every record in that branch.
  select coalesce(array_agg(branch_row.id), array[]::uuid[])
    into branch_wide_ids
  from public.branches branch_row
  where branch_row.organization_id = current_organization_id
    and app_private.can_access_record(current_organization_id, branch_row.id, null, null);
  select * into customer_scope
  from app_private.resolve_customer_access_scope(current_organization_id);

  with authorized as materialized (
    select
      delivery_row.id as delivery_case_id,
      delivery_row.organization_id,
      delivery_row.branch_id,
      delivery_row.booking_id,
      delivery_row.customer_id,
      delivery_row.delivered_at,
      delivery_row.updated_at as delivery_updated_at,
      booking_row.booking_number,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      feedback_row.id as feedback_request_id,
      coalesce(feedback_row.status, 'NOT_REQUESTED') as status,
      feedback_row.channel,
      feedback_row.sent_at,
      feedback_row.completed_at,
      feedback_row.rating,
      feedback_row.comments,
      coalesce(feedback_row.version, 0) as version,
      feedback_row.updated_at
    from public.delivery_cases delivery_row
    join public.bookings booking_row
      on booking_row.organization_id = delivery_row.organization_id
     and booking_row.id = delivery_row.booking_id
     and booking_row.deleted_at is null
    join public.customers customer_row
      on customer_row.organization_id = delivery_row.organization_id
     and customer_row.id = delivery_row.customer_id
     and customer_row.deleted_at is null
    left join public.feedback_requests feedback_row
      on feedback_row.organization_id = delivery_row.organization_id
     and feedback_row.delivery_case_id = delivery_row.id
    where delivery_row.organization_id = current_organization_id
      and delivery_row.deleted_at is null
      and delivery_row.status = 'DELIVERED'
      and case when delivery_row.branch_id = any(branch_wide_ids) then true
        else app_private.can_access_record(
          delivery_row.organization_id, delivery_row.branch_id, null, delivery_row.assigned_user_id
        ) end
      -- can_access_customer, from the customer scope resolved once above.
      and customer_scope.organization_access
      and (
        customer_scope.customer_ids_all
        or exists (
          select 1
          from public.leads customer_lead
          where customer_lead.organization_id = delivery_row.organization_id
            and customer_lead.customer_id = delivery_row.customer_id
            and customer_lead.deleted_at is null
            and (
              customer_lead.branch_id = any(customer_scope.branch_ids)
              or customer_lead.team_id = any(customer_scope.team_ids)
              or (
                customer_scope.own_records
                and (
                  customer_lead.assigned_user_id = auth.uid()
                  or app_private.has_owned_lead(customer_lead.organization_id, customer_lead.id)
                )
              )
            )
        )
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(booking_row.booking_number)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), filtered as materialized (
    select authorized_row.* from authorized authorized_row
    where normalized_status = 'ALL' or authorized_row.status = normalized_status
  ), page_rows as (
    select filtered_row.* from filtered filtered_row
    order by
      case when filtered_row.status = 'PENDING' then 0
           when filtered_row.status = 'NOT_REQUESTED' then 1 else 2 end,
      coalesce(filtered_row.sent_at, filtered_row.delivered_at, filtered_row.delivery_updated_at) asc,
      filtered_row.delivery_case_id desc
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'organization_id', current_organization_id,
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when page_row.status = 'PENDING' then 0 when page_row.status = 'NOT_REQUESTED' then 1 else 2 end,
      coalesce(page_row.sent_at, page_row.delivered_at, page_row.delivery_updated_at) asc,
      page_row.delivery_case_id desc) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'kpis', jsonb_build_object(
      'eligible_deliveries', (select count(*) from authorized),
      'not_requested', (select count(*) from authorized where status = 'NOT_REQUESTED'),
      'pending', (select count(*) from authorized where status = 'PENDING'),
      'completed', (select count(*) from authorized where status = 'COMPLETED'),
      'average_rating', (select coalesce(round(avg(rating)::numeric, 1), 0)
        from authorized where status = 'COMPLETED' and rating is not null)
    )
  ) into result;
  return result;
end;
$function$;

commit;
