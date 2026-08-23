begin;

-- Delivery feedback is deliberately anchored to the delivery case, rather than
-- inferred from a booking. A customer can have more than one booking/delivery.
alter table public.feedback_requests
  add column if not exists delivery_case_id uuid;

alter table public.feedback_requests
  drop constraint if exists feedback_requests_delivery_case_org_fk;
alter table public.feedback_requests
  add constraint feedback_requests_delivery_case_org_fk
  foreign key (organization_id, delivery_case_id)
  references public.delivery_cases (organization_id, id) not valid;

create unique index if not exists feedback_requests_delivery_case_unique_idx
  on public.feedback_requests (organization_id, delivery_case_id)
  where delivery_case_id is not null;
create index if not exists feedback_requests_delivery_queue_idx
  on public.feedback_requests (organization_id, delivery_case_id, status, created_at desc)
  where delivery_case_id is not null;

create or replace function public.get_delivery_feedback_workspace_page(
  target_status text default 'PENDING',
  target_search text default '',
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
      and app_private.can_access_record(
        delivery_row.organization_id, delivery_row.branch_id, null, delivery_row.assigned_user_id
      )
      and app_private.can_access_customer(delivery_row.organization_id, delivery_row.customer_id)
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
$$;

create or replace function public.request_delivery_feedback(
  target_delivery_case_id uuid,
  target_channel text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  delivery_row public.delivery_cases%rowtype;
  feedback_row public.feedback_requests%rowtype;
  normalized_channel text := upper(btrim(coalesce(target_channel, '')));
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_delivery_case_id is null or target_request_id is null
    or normalized_channel not in ('MANUAL', 'SMS', 'WHATSAPP', 'EMAIL')
  then
    raise exception using errcode = '22023', message = 'INVALID_DELIVERY_FEEDBACK_REQUEST';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'delivery.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'DELIVERY_FEEDBACK_MANAGE_PERMISSION_REQUIRED';
  end if;
  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'delivery_case_id', target_delivery_case_id, 'channel', normalized_channel
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.delivery_feedback.requested', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  select * into delivery_row from public.delivery_cases source_row
  where source_row.organization_id = current_organization_id
    and source_row.id = target_delivery_case_id and source_row.deleted_at is null
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'DELIVERY_CASE_NOT_FOUND'; end if;
  if delivery_row.status <> 'DELIVERED'
    or not app_private.can_access_record(
      delivery_row.organization_id, delivery_row.branch_id, null, delivery_row.assigned_user_id
    )
    or not app_private.can_access_customer(delivery_row.organization_id, delivery_row.customer_id)
  then raise exception using errcode = '42501', message = 'DELIVERY_FEEDBACK_SCOPE_DENIED'; end if;

  insert into public.feedback_requests (
    organization_id, branch_id, customer_id, booking_id, delivery_case_id,
    channel, status, version, updated_at
  ) values (
    current_organization_id, delivery_row.branch_id, delivery_row.customer_id,
    delivery_row.booking_id, delivery_row.id, normalized_channel, 'PENDING', 1, now()
  ) on conflict (organization_id, delivery_case_id) where delivery_case_id is not null
    do update set channel = excluded.channel, updated_at = now(), version = public.feedback_requests.version + 1
    where public.feedback_requests.status = 'PENDING'
  returning * into feedback_row;
  if not found then
    select * into feedback_row from public.feedback_requests source_row
    where source_row.organization_id = current_organization_id
      and source_row.delivery_case_id = delivery_row.id;
  end if;
  if feedback_row.status = 'COMPLETED' then
    raise exception using errcode = '23514', message = 'DELIVERY_FEEDBACK_ALREADY_COMPLETED';
  end if;
  result := jsonb_build_object(
    'delivery_case_id', delivery_row.id, 'feedback_request_id', feedback_row.id,
    'status', feedback_row.status, 'version', feedback_row.version, 'replayed', false
  );
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  select current_organization_id, delivery_row.customer_id, booking_row.lead_id,
    'DELIVERY_FEEDBACK_REQUESTED', auth.uid(), jsonb_build_object(
      'delivery_case_id', delivery_row.id, 'feedback_request_id', feedback_row.id,
      'channel', normalized_channel
    ) from public.bookings booking_row
    where booking_row.organization_id = current_organization_id and booking_row.id = delivery_row.booking_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.delivery_feedback.requested',
    'delivery_case', delivery_row.id::text, delivery_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.capture_delivery_feedback(
  target_delivery_case_id uuid,
  expected_version bigint,
  target_rating smallint,
  target_comments text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  delivery_row public.delivery_cases%rowtype;
  feedback_row public.feedback_requests%rowtype;
  normalized_comments text := nullif(btrim(coalesce(target_comments, '')), '');
  fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if target_delivery_case_id is null or target_request_id is null
    or expected_version is null or expected_version < 1
    or target_rating is null or target_rating not between 1 and 5
    or char_length(coalesce(normalized_comments, '')) > 4000
  then
    raise exception using errcode = '22023', message = 'INVALID_DELIVERY_FEEDBACK_CAPTURE';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'delivery.manage')
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'DELIVERY_FEEDBACK_MANAGE_PERMISSION_REQUIRED';
  end if;
  fingerprint := app_private.operational_case_request_fingerprint(jsonb_build_object(
    'delivery_case_id', target_delivery_case_id, 'expected_version', expected_version,
    'rating', target_rating, 'comments', normalized_comments
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_operational_case_request(
    current_organization_id, 'case.delivery_feedback.captured', target_request_id, fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  select * into delivery_row from public.delivery_cases source_row
  where source_row.organization_id = current_organization_id
    and source_row.id = target_delivery_case_id and source_row.deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'DELIVERY_CASE_NOT_FOUND'; end if;
  if delivery_row.status <> 'DELIVERED'
    or not app_private.can_access_record(
      delivery_row.organization_id, delivery_row.branch_id, null, delivery_row.assigned_user_id
    )
    or not app_private.can_access_customer(delivery_row.organization_id, delivery_row.customer_id)
  then raise exception using errcode = '42501', message = 'DELIVERY_FEEDBACK_SCOPE_DENIED'; end if;
  select * into feedback_row from public.feedback_requests source_row
  where source_row.organization_id = current_organization_id
    and source_row.delivery_case_id = delivery_row.id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'DELIVERY_FEEDBACK_REQUEST_REQUIRED'; end if;
  if feedback_row.status <> 'PENDING' then
    raise exception using errcode = '23514', message = 'DELIVERY_FEEDBACK_NOT_PENDING';
  end if;
  if feedback_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'DELIVERY_FEEDBACK_VERSION_CONFLICT';
  end if;
  update public.feedback_requests set
    status = 'COMPLETED', rating = target_rating, comments = normalized_comments,
    completed_at = now(), version = version + 1, updated_at = now()
  where id = feedback_row.id
  returning * into feedback_row;
  result := jsonb_build_object(
    'delivery_case_id', delivery_row.id, 'feedback_request_id', feedback_row.id,
    'status', feedback_row.status, 'version', feedback_row.version, 'replayed', false
  );
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata)
  select current_organization_id, delivery_row.customer_id, booking_row.lead_id,
    'DELIVERY_FEEDBACK_CAPTURED', auth.uid(), jsonb_build_object(
      'delivery_case_id', delivery_row.id, 'feedback_request_id', feedback_row.id,
      'rating', target_rating
    ) from public.bookings booking_row
    where booking_row.organization_id = current_organization_id and booking_row.id = delivery_row.booking_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'case.delivery_feedback.captured',
    'delivery_case', delivery_row.id::text, delivery_row.branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

revoke all on function public.get_delivery_feedback_workspace_page(text, text, integer, integer) from public;
grant execute on function public.get_delivery_feedback_workspace_page(text, text, integer, integer) to authenticated;
revoke all on function public.request_delivery_feedback(uuid, text, uuid) from public;
grant execute on function public.request_delivery_feedback(uuid, text, uuid) to authenticated;
revoke all on function public.capture_delivery_feedback(uuid, bigint, smallint, text, uuid) from public;
grant execute on function public.capture_delivery_feedback(uuid, bigint, smallint, text, uuid) to authenticated;

alter table public.feedback_requests validate constraint feedback_requests_delivery_case_org_fk;

commit;
