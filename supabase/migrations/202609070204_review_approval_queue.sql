-- Two gaps this closes.
--
-- First, a positive rating produced nothing a person could see. The routing
-- trigger writes a customer_care_case only for detractors; a promoter got an
-- audit row and nothing else, so completed feedback awaiting a review invite had
-- no queue anywhere in the product.
--
-- Second, approve_feedback_review_invite was gated on marketing.automation.manage,
-- which the Customer Relationship roles do not hold. The people who actually do
-- this work could not call it. Approving is a customer-care action that sends an
-- email, so it is gated on those two rights instead, with the marketing
-- permission still accepted so the marketing team keeps its existing access.

create or replace function public.approve_feedback_review_invite(
  target_feedback_id uuid,
  target_message text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  feedback_row public.feedback_requests%rowtype;
  new_review_request_id uuid;
  normalized_message text := left(btrim(coalesce(target_message, '')), 4000);
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (
      (app_private.has_permission(current_organization_id, 'customer_care.manage')
        and app_private.has_permission(current_organization_id, 'email.send'))
      or app_private.has_permission(current_organization_id, 'marketing.automation.manage')
    )
  then
    raise exception using errcode = '42501', message = 'REVIEW_INVITE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or char_length(normalized_message) < 1 then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_INVITE_INPUT';
  end if;

  select * into feedback_row from public.feedback_requests
  where id = target_feedback_id and organization_id = current_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'FEEDBACK_REQUEST_NOT_FOUND';
  end if;
  if not app_private.can_access_branch(current_organization_id, feedback_row.branch_id) then
    raise exception using errcode = '42501', message = 'FEEDBACK_SCOPE_DENIED';
  end if;
  if feedback_row.status <> 'COMPLETED' then
    raise exception using errcode = '22023', message = 'FEEDBACK_NOT_SUBMITTED';
  end if;
  if feedback_row.review_request_id is not null then
    return jsonb_build_object(
      'feedback_id', feedback_row.id,
      'review_request_id', feedback_row.review_request_id,
      'replayed', true
    );
  end if;

  insert into public.customer_review_requests (
    organization_id, branch_id, customer_id, booking_id, channel, message_body,
    status, created_by
  ) values (
    current_organization_id, feedback_row.branch_id, feedback_row.customer_id,
    feedback_row.booking_id, 'EMAIL', normalized_message, 'QUEUED', auth.uid()
  ) returning id into new_review_request_id;

  update public.feedback_requests
  set approved_at = now(), approved_by = auth.uid(), review_request_id = new_review_request_id
  where id = feedback_row.id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'feedback_request.review_invited', 'feedback_request',
    feedback_row.id::text, feedback_row.branch_id, target_request_id,
    jsonb_build_object('review_request_id', new_review_request_id, 'rating', feedback_row.rating)
  );
  return jsonb_build_object(
    'feedback_id', feedback_row.id, 'review_request_id', new_review_request_id, 'replayed', false
  );
end;
$$;

-- The queue the Reviews page renders. Server-side paginated with an exact count,
-- because completed feedback accumulates for the life of the tenant.
create or replace function public.get_review_approval_queue(
  target_view text default 'AWAITING',
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
  normalized_view text := upper(btrim(coalesce(target_view, 'AWAITING')));
  offset_rows integer;
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
          and app_private.can_access_branch(current_organization_id, source_row.branch_id)
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
        and app_private.can_access_branch(current_organization_id, source_row.branch_id)
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
        and app_private.can_access_branch(current_organization_id, source_row.branch_id)
    )
  );
end;
$$;

revoke all on function public.get_review_approval_queue(text, integer, integer) from public, anon;
grant execute on function public.get_review_approval_queue(text, integer, integer) to authenticated;
