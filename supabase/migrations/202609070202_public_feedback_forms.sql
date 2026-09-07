-- Feedback could only be recorded by a signed-in staff member: submit_customer_feedback
-- requires auth.uid() and customer.view, and the app has no unauthenticated route
-- at all. So the customer never filled anything in; somebody read the rating to
-- them over the phone.
--
-- This adds the customer-facing half: a per-branch form reached by a signed,
-- expiring, single-use link, and an approval step that turns a submitted rating
-- into a Google review invitation.
--
-- On review gating: the invitation is deliberately NOT restricted to high
-- ratings here. Google's review policy prohibits selectively soliciting positive
-- reviews, and the exposure lands on the dealership's own listing. Low ratings
-- still raise a complaint through the existing routing trigger, so the team sees
-- them; they are simply not excluded from being asked.

-- Each branch is its own Google Business Profile listing, so the review link
-- belongs on the branch. The organization value stays as the fallback.
alter table public.branches add column if not exists google_review_url text;

alter table public.feedback_requests
  add column if not exists public_token text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists review_request_id uuid references public.customer_review_requests(id);

-- The token is the only credential the customer presents, so it must be unique
-- and it must not be guessable. Partial, because most historic rows have none.
create unique index if not exists feedback_requests_public_token_idx
  on public.feedback_requests (public_token) where public_token is not null;

create or replace function public.issue_feedback_form_link(
  target_feedback_id uuid,
  target_valid_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  feedback_row public.feedback_requests%rowtype;
  new_token text;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'FEEDBACK_ACCESS_REQUIRED';
  end if;
  if target_valid_days not between 1 and 90 then
    raise exception using errcode = '22023', message = 'INVALID_FEEDBACK_LINK_WINDOW';
  end if;
  select * into feedback_row from public.feedback_requests
  where id = target_feedback_id and organization_id = current_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'FEEDBACK_REQUEST_NOT_FOUND';
  end if;
  if not app_private.can_access_branch(current_organization_id, feedback_row.branch_id) then
    raise exception using errcode = '42501', message = 'FEEDBACK_SCOPE_DENIED';
  end if;
  if feedback_row.status = 'COMPLETED' then
    raise exception using errcode = '22023', message = 'FEEDBACK_ALREADY_COMPLETED';
  end if;

  -- Reissuing replaces the old token, so a link that was forwarded on stops
  -- working the moment a new one is sent.
  new_token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.feedback_requests
  set public_token = new_token,
    token_expires_at = now() + make_interval(days => target_valid_days)
  where id = feedback_row.id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'feedback_request.link_issued', 'feedback_request',
    feedback_row.id::text, feedback_row.branch_id,
    jsonb_build_object('valid_days', target_valid_days)
  );
  return jsonb_build_object('feedback_id', feedback_row.id, 'token', new_token);
end;
$$;

-- Read by an anonymous visitor holding the token. Returns only what the form has
-- to render: which showroom is asking. No customer name, phone, email, booking
-- or identifier is exposed, so a leaked token reveals nothing about the person.
create or replace function public.get_public_feedback_form(target_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  branch_name text;
  organization_name text;
begin
  if target_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'INVALID');
  end if;
  select * into feedback_row from public.feedback_requests
  where public_token = target_token;
  if not found then return jsonb_build_object('status', 'INVALID'); end if;
  if feedback_row.token_expires_at is null or feedback_row.token_expires_at <= now() then
    return jsonb_build_object('status', 'EXPIRED');
  end if;
  if feedback_row.status = 'COMPLETED' then
    return jsonb_build_object('status', 'ALREADY_SUBMITTED');
  end if;
  select name into branch_name from public.branches where id = feedback_row.branch_id;
  select name into organization_name from public.organizations
  where id = feedback_row.organization_id;
  return jsonb_build_object(
    'status', 'OPEN', 'branch', branch_name, 'organization', organization_name
  );
end;
$$;

-- The customer's own submission. Single use: the token is cleared on success, so
-- the same link cannot be replayed to stuff ratings.
create or replace function public.submit_public_feedback(
  target_token text,
  target_rating smallint,
  target_comments text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  review_url text;
begin
  if target_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'INVALID');
  end if;
  if target_rating is null or target_rating not between 1 and 5
    or length(coalesce(target_comments, '')) > 4000
  then
    raise exception using errcode = '22023', message = 'INVALID_FEEDBACK_INPUT';
  end if;

  select * into feedback_row from public.feedback_requests
  where public_token = target_token
  for update;
  if not found then return jsonb_build_object('status', 'INVALID'); end if;
  if feedback_row.token_expires_at is null or feedback_row.token_expires_at <= now() then
    return jsonb_build_object('status', 'EXPIRED');
  end if;
  if feedback_row.status = 'COMPLETED' then
    return jsonb_build_object('status', 'ALREADY_SUBMITTED');
  end if;

  update public.feedback_requests
  set rating = target_rating,
    comments = nullif(btrim(target_comments), ''),
    status = 'COMPLETED',
    completed_at = now(),
    submitted_at = now(),
    -- Spent on use.
    public_token = null,
    token_expires_at = null
  where id = feedback_row.id;

  -- Branch listing first, organization as fallback.
  select coalesce(branch_row.google_review_url, organization_row.google_review_url)
  into review_url
  from public.branches branch_row
  join public.organizations organization_row on organization_row.id = branch_row.organization_id
  where branch_row.id = feedback_row.branch_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    feedback_row.organization_id, null, 'feedback_request.submitted_publicly',
    'feedback_request', feedback_row.id::text, feedback_row.branch_id,
    jsonb_build_object('rating', target_rating)
  );
  -- The link is returned to every rating. Withholding it from unhappy customers
  -- is review gating, which Google's policy prohibits; the routing trigger on
  -- feedback_requests still raises a complaint for low ratings.
  return jsonb_build_object(
    'status', 'RECORDED', 'rating', target_rating, 'review_url', review_url
  );
end;
$$;

-- Approval turns a submitted rating into an emailed invitation. It is a separate
-- step so a dealership can look at what was written before inviting.
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
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage')
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
  -- Approving twice is a double click, not a second invitation.
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

create or replace function public.set_branch_google_review_url(
  target_branch_id uuid,
  target_url text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid; normalized text := nullif(btrim(coalesce(target_url, '')), '');
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.automation.manage')
  then
    raise exception using errcode = '42501', message = 'REVIEW_INVITE_PERMISSION_REQUIRED';
  end if;
  if normalized is not null and normalized !~* '^https://' then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_URL';
  end if;
  update public.branches set google_review_url = normalized
  where id = target_branch_id and organization_id = current_organization_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'BRANCH_NOT_FOUND';
  end if;
  return true;
end;
$$;

revoke all on function public.issue_feedback_form_link(uuid, integer) from public, anon;
grant execute on function public.issue_feedback_form_link(uuid, integer) to authenticated;
-- Deliberately reachable without a session: these two ARE the public form. They
-- take a 64-hex token, return no customer data, and spend the token on use.
revoke all on function public.get_public_feedback_form(text) from public;
grant execute on function public.get_public_feedback_form(text) to anon, authenticated;
revoke all on function public.submit_public_feedback(text, smallint, text) from public;
grant execute on function public.submit_public_feedback(text, smallint, text) to anon, authenticated;
revoke all on function public.approve_feedback_review_invite(uuid, text, uuid) from public, anon;
grant execute on function public.approve_feedback_review_invite(uuid, text, uuid) to authenticated;
revoke all on function public.set_branch_google_review_url(uuid, text) from public, anon;
grant execute on function public.set_branch_google_review_url(uuid, text) to authenticated;
