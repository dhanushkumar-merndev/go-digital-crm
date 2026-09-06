-- Review Collection & Sentiment Routing: Google Reviews vs Complaint Escalation
alter table public.organizations
  add column if not exists google_review_url text;

create or replace function public.set_organization_google_review_url(target_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not (
      app_private.has_permission(current_organization_id, 'tenant.manage')
      or app_private.has_permission(current_organization_id, 'marketing.manage')
      or app_private.has_permission(current_organization_id, 'customer_care.manage')
    ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  update public.organizations
  set google_review_url = nullif(trim(target_url), '')
  where id = current_organization_id;

  return true;
end;
$$;

create or replace function public.submit_customer_feedback(
  target_feedback_id uuid,
  target_rating smallint,
  target_comments text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  review_url text;
  complaint_row public.complaints%rowtype;
  outcome_type text;
begin
  if target_rating not between 1 and 5 then
    raise exception using errcode = '22023', message = 'INVALID_RATING_VALUE';
  end if;

  select * into feedback_row from public.feedback_requests
  where id = target_feedback_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'FEEDBACK_REQUEST_NOT_FOUND';
  end if;

  update public.feedback_requests set
    rating = target_rating,
    comments = nullif(trim(target_comments), ''),
    status = 'COMPLETED',
    completed_at = now()
  where id = target_feedback_id
  returning * into feedback_row;

  select google_review_url into review_url
  from public.organizations
  where id = feedback_row.organization_id;

  if target_rating >= 4 then
    outcome_type := 'POSITIVE_REVIEW';
    insert into public.audit_logs (
      organization_id, action, resource_type, resource_id, metadata
    ) values (
      feedback_row.organization_id, 'feedback.promoter_recorded', 'customer',
      feedback_row.customer_id::text,
      jsonb_build_object('rating', target_rating, 'google_review_url', review_url)
    );

    return jsonb_build_object(
      'feedback_id', feedback_row.id,
      'rating', feedback_row.rating,
      'status', 'COMPLETED',
      'outcome', outcome_type,
      'redirect_review_url', review_url
    );
  else
    outcome_type := 'DETRACTOR_ESCALATED';

    insert into public.complaints (
      organization_id, branch_id, customer_id, booking_id,
      category, description, priority, status
    ) values (
      feedback_row.organization_id, feedback_row.branch_id, feedback_row.customer_id,
      feedback_row.booking_id, 'DELIVERY_FEEDBACK',
      coalesce(target_comments, 'Customer submitted low delivery rating: ' || target_rating || '/5'),
      'HIGH', 'OPEN'
    )
    returning * into complaint_row;

    insert into public.audit_logs (
      organization_id, action, resource_type, resource_id, metadata
    ) values (
      feedback_row.organization_id, 'feedback.detractor_escalated', 'complaint',
      complaint_row.id::text,
      jsonb_build_object('rating', target_rating, 'complaint_id', complaint_row.id)
    );

    return jsonb_build_object(
      'feedback_id', feedback_row.id,
      'rating', feedback_row.rating,
      'status', 'COMPLETED',
      'outcome', outcome_type,
      'complaint_id', complaint_row.id
    );
  end if;
end;
$$;

create or replace function public.trigger_delivery_feedback_request(
  target_delivery_id uuid,
  target_channel text default 'WHATSAPP'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  delivery_rec public.delivery_cases%rowtype;
  feedback_rec public.feedback_requests%rowtype;
  channel_val text := upper(trim(coalesce(target_channel, 'WHATSAPP')));
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into delivery_rec from public.delivery_cases
  where id = target_delivery_id and organization_id = current_organization_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'DELIVERY_CASE_NOT_FOUND';
  end if;

  if channel_val not in ('WHATSAPP', 'SMS', 'EMAIL') then
    channel_val := 'WHATSAPP';
  end if;

  select * into feedback_rec from public.feedback_requests
  where booking_id = delivery_rec.booking_id and organization_id = current_organization_id;

  if not found then
    insert into public.feedback_requests (
      organization_id, branch_id, customer_id, booking_id, channel, status, sent_at
    ) values (
      current_organization_id, delivery_rec.branch_id, delivery_rec.customer_id,
      delivery_rec.booking_id, channel_val, 'SENT', now()
    )
    returning * into feedback_rec;
  end if;

  return jsonb_build_object(
    'feedback_id', feedback_rec.id,
    'booking_id', feedback_rec.booking_id,
    'customer_id', feedback_rec.customer_id,
    'channel', feedback_rec.channel,
    'status', feedback_rec.status
  );
end;
$$;

grant execute on function public.set_organization_google_review_url(text) to authenticated;
grant execute on function public.submit_customer_feedback(uuid, smallint, text) to authenticated, anon;
grant execute on function public.trigger_delivery_feedback_request(uuid, text) to authenticated;
