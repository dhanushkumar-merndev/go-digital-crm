begin;

-- Review requests from Sales Consultants and Telecallers (product decision
-- 2026-10-18). Feedback links existed only for a delivered vehicle, sent by the
-- delivery desk, so nobody on the sales floor could ask a customer for a
-- review, and nobody could see who asked or how many customers answered.
--
-- A request now belongs to one lead and to the person who sent it, and any
-- lead can be asked, including a new one not yet linked to a customer: the
-- customer is filled in when there is one. The link is
-- the same signed, single-use public feedback form, so every existing rule
-- carries over: the token is the only credential, a low rating still opens a
-- customer-care case through route_completed_customer_feedback, and the
-- Google review link is offered for every rating (no review gating).
--
-- On the form the customer picks a few keywords and writes a line; the
-- public-review-rephrase Edge Function can turn that into a short review in
-- their own words, which they can edit. Submitting copies it and opens the
-- showroom's Google review page.

alter table public.feedback_requests
  add column if not exists lead_id uuid references public.leads(id),
  add column if not exists requested_by uuid references public.profiles(id),
  add column if not exists review_keywords text[] not null default '{}',
  add column if not exists review_redirected_at timestamptz,
  add column if not exists ai_rephrase_count smallint not null default 0;

-- Delivery feedback always has a customer; a review request may only have the
-- lead. Every row keeps at least one of the two.
alter table public.feedback_requests alter column customer_id drop not null;
alter table public.feedback_requests
  add constraint feedback_requests_customer_or_lead_check
  check (customer_id is not null or lead_id is not null) not valid;
alter table public.feedback_requests validate constraint feedback_requests_customer_or_lead_check;

-- The Reviews page reads one person's requests by date.
create index if not exists feedback_requests_requested_by_idx
  on public.feedback_requests (organization_id, requested_by, created_at desc, id)
  where requested_by is not null;
-- Resending to a lead reuses its open request instead of adding a second one.
create index if not exists feedback_requests_lead_open_idx
  on public.feedback_requests (organization_id, lead_id, created_at desc)
  where lead_id is not null and status <> 'COMPLETED';

-- Customer-facing keyword vocabulary. It is a constant, not tenant data: the
-- form sends keywords back, and anything outside this list is dropped.
create or replace function app_private.review_keyword_options()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'Friendly staff', 'Knowledgeable consultant', 'Smooth test drive', 'Transparent pricing',
    'Quick response', 'Good offers', 'Easy paperwork', 'Clean showroom', 'On-time delivery',
    'Patient explanation', 'Slow response', 'Long waiting time', 'Pricing not clear',
    'Follow-up needed'
  ]::text[]
$$;

-- Send (or resend) a review request for one lead the caller can see. Pass a
-- customer instead of a lead from Customer 360: the request is then attached to
-- that customer's most recent lead the caller can access.
create or replace function public.create_lead_review_request(
  target_lead_id uuid default null,
  target_customer_id uuid default null,
  target_channel text default 'WHATSAPP'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  lead_row public.leads%rowtype;
  open_row public.feedback_requests%rowtype;
  feedback_id uuid;
  new_token text := encode(extensions.gen_random_bytes(32), 'hex');
  expires_at timestamptz := now() + interval '14 days';
  normalized_channel text := upper(btrim(coalesce(target_channel, '')));
  reused boolean := false;
  branch_name text;
  customer_name text;
  customer_phone text;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'REVIEW_REQUEST_ACCESS_REQUIRED';
  end if;
  if normalized_channel not in ('WHATSAPP', 'SMS', 'LINK') then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_CHANNEL';
  end if;
  if (target_lead_id is null) = (target_customer_id is null) then
    raise exception using errcode = '22023', message = 'REVIEW_TARGET_REQUIRED';
  end if;

  if target_lead_id is not null then
    select * into lead_row from public.leads
    where id = target_lead_id and organization_id = current_organization_id and deleted_at is null;
    if not found or not app_private.can_access_lead(lead_row.id) then
      raise exception using errcode = '42501', message = 'REVIEW_LEAD_NOT_ACCESSIBLE';
    end if;
  else
    select candidate.* into lead_row from public.leads candidate
    where candidate.organization_id = current_organization_id
      and candidate.customer_id = target_customer_id
      and candidate.deleted_at is null
      and app_private.can_access_lead(candidate.id)
    order by candidate.created_at desc, candidate.id desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'REVIEW_LEAD_NOT_ACCESSIBLE';
    end if;
  end if;
  -- A short burst ceiling per sender. Ordinary use is a handful a day.
  if (select count(*) from public.feedback_requests
      where organization_id = current_organization_id and requested_by = auth.uid()
        and created_at > now() - interval '1 hour') >= 60
  then
    raise exception using errcode = 'P0001', message = 'REVIEW_REQUEST_RATE_LIMIT';
  end if;

  -- One open request per lead. Resending reissues its token, so a forwarded old
  -- link stops working and the sender's count is not inflated by retries.
  select * into open_row from public.feedback_requests
  where organization_id = current_organization_id and lead_id = lead_row.id
    and status <> 'COMPLETED'
  order by created_at desc
  limit 1
  for update;
  if found then
    reused := true;
    feedback_id := open_row.id;
    update public.feedback_requests
    set public_token = new_token, token_expires_at = expires_at, sent_at = now(),
      channel = normalized_channel, status = 'SENT',
      requested_by = coalesce(open_row.requested_by, auth.uid())
    where id = open_row.id;
  else
    insert into public.feedback_requests (
      organization_id, branch_id, customer_id, lead_id, requested_by, channel, status,
      sent_at, public_token, token_expires_at
    ) values (
      current_organization_id, lead_row.branch_id, lead_row.customer_id, lead_row.id, auth.uid(),
      normalized_channel, 'SENT', now(), new_token, expires_at
    ) returning id into feedback_id;
  end if;

  -- route_completed_customer_feedback attributes an unhappy customer's case to
  -- the actor of this audit row, because the public form has no session.
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'feedback_request.link_issued', 'feedback_request',
    feedback_id::text, lead_row.branch_id,
    jsonb_build_object('lead_id', lead_row.id, 'channel', normalized_channel,
      'source', 'SALES_REVIEW_REQUEST', 'reused', reused, 'valid_days', 14)
  );

  select name into branch_name from public.branches where id = lead_row.branch_id;
  select coalesce(nullif(btrim(customer_row.full_name), ''), lead_row.customer_name),
    coalesce(customer_row.whatsapp_phone, customer_row.primary_phone, lead_row.phone)
  into customer_name, customer_phone
  from (select 1) anchor_row
  left join public.customers customer_row on customer_row.id = lead_row.customer_id;

  return jsonb_build_object(
    'feedback_id', feedback_id, 'token', new_token, 'expires_at', expires_at,
    'lead_id', lead_row.id, 'customer_name', customer_name, 'phone', customer_phone,
    'branch', branch_name, 'reused', reused
  );
end;
$$;

-- Leads the caller owns, for the "Send review request" picker. Own records
-- only, which is what both Telecaller and Sales Consultant work with; the
-- index on (organization_id, assigned_user_id, ...) serves it.
create or replace function public.search_review_request_leads(target_search text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  term text := left(btrim(coalesce(target_search, '')), 80);
  digits text := regexp_replace(left(coalesce(target_search, ''), 80), '\D', '', 'g');
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'REVIEW_REQUEST_ACCESS_REQUIRED';
  end if;
  return coalesce((
    select jsonb_agg(row_data order by updated_at desc)
    from (
      select lead_row.updated_at, jsonb_build_object(
        'lead_id', lead_row.id,
        'customer_name', coalesce(nullif(btrim(customer_row.full_name), ''), lead_row.customer_name),
        'phone', lead_row.phone,
        'interested_model', lead_row.interested_model,
        'has_customer', lead_row.customer_id is not null
      ) as row_data
      from public.leads lead_row
      left join public.customers customer_row on customer_row.id = lead_row.customer_id
      where lead_row.organization_id = current_organization_id
        and lead_row.assigned_user_id = auth.uid()
        and lead_row.deleted_at is null
        and (
          term = ''
          or lead_row.customer_name ilike '%' || replace(replace(term, '%', ''), '_', '') || '%'
          or (char_length(digits) >= 4 and lead_row.normalized_phone like '%' || digits || '%')
        )
      order by lead_row.updated_at desc
      limit 10
    ) picked
  ), '[]'::jsonb);
end;
$$;

-- The Reviews page: the caller's own requests, the numbers over a date range,
-- and one page of rows. Everything is read through requested_by = auth.uid().
create or replace function public.get_my_review_requests(
  target_from date,
  target_to date,
  target_view text default 'ALL',
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
  current_organization_id uuid := app_private.current_tenant_organization();
  range_start timestamptz;
  range_end timestamptz;
  normalized_view text := upper(coalesce(target_view, 'ALL'));
  term text := left(btrim(coalesce(target_search, '')), 80);
  digits text := regexp_replace(left(coalesce(target_search, ''), 80), '\D', '', 'g');
  page_size integer := case when target_page_size in (25, 50, 100) then target_page_size else 25 end;
  page_offset integer := (greatest(coalesce(target_page, 1), 1) - 1) * page_size;
  result jsonb;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'REVIEW_REQUEST_ACCESS_REQUIRED';
  end if;
  if target_from is null or target_to is null or target_to < target_from
    or target_to - target_from > 366
  then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_RANGE';
  end if;
  if normalized_view not in ('ALL', 'AWAITING', 'FILLED', 'EXPIRED') then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_VIEW';
  end if;
  range_start := target_from::timestamptz;
  range_end := (target_to + 1)::timestamptz;

  with mine as (
    select feedback_row.*,
      case
        when feedback_row.status = 'COMPLETED' then 'FILLED'
        when feedback_row.token_expires_at > now() then 'AWAITING'
        else 'EXPIRED'
      end as review_state
    from public.feedback_requests feedback_row
    where feedback_row.organization_id = current_organization_id
      and feedback_row.requested_by = auth.uid()
      and feedback_row.created_at >= range_start
      and feedback_row.created_at < range_end
  ),
  listed as (
    select mine.*, customer_row.full_name as customer_full_name, lead_row.customer_name as lead_name,
      lead_row.phone as lead_phone, lead_row.interested_model
    from mine
    left join public.customers customer_row on customer_row.id = mine.customer_id
    left join public.leads lead_row on lead_row.id = mine.lead_id
    where (normalized_view = 'ALL' or mine.review_state = normalized_view)
      and (
        term = ''
        or coalesce(customer_row.full_name, lead_row.customer_name, '')
          ilike '%' || replace(replace(term, '%', ''), '_', '') || '%'
        or (char_length(digits) >= 4 and coalesce(lead_row.normalized_phone, '') like '%' || digits || '%')
      )
  ),
  days as (
    select generate_series(target_from, target_to, interval '1 day')::date as day
  ),
  sent_by_day as (
    select created_at::date as day, count(*) as sent from mine group by 1
  ),
  filled_by_day as (
    select completed_at::date as day, count(*) as filled from mine
    where review_state = 'FILLED' group by 1
  )
  select jsonb_build_object(
    'kpis', (
      select jsonb_build_object(
        'sent', count(*),
        'filled', count(*) filter (where review_state = 'FILLED'),
        'awaiting', count(*) filter (where review_state = 'AWAITING'),
        'expired', count(*) filter (where review_state = 'EXPIRED'),
        'average_rating', round(avg(rating) filter (where review_state = 'FILLED'), 1),
        'five_star', count(*) filter (where review_state = 'FILLED' and rating = 5),
        'low_rating', count(*) filter (where review_state = 'FILLED' and rating <= 3),
        'sent_to_google', count(*) filter (where review_redirected_at is not null)
      ) from mine
    ),
    'ratings', (
      select jsonb_agg(jsonb_build_object('rating', star, 'count', (
        select count(*) from mine where review_state = 'FILLED' and rating = star
      )) order by star desc)
      from generate_series(1, 5) star
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day', days.day, 'sent', coalesce(sent_by_day.sent, 0),
        'filled', coalesce(filled_by_day.filled, 0)
      ) order by days.day), '[]'::jsonb)
      from days
      left join sent_by_day on sent_by_day.day = days.day
      left join filled_by_day on filled_by_day.day = days.day
    ),
    'total', (select count(*) from listed),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feedback_id', page_row.id,
        'lead_id', page_row.lead_id,
        'customer_id', page_row.customer_id,
        'customer_name', coalesce(nullif(btrim(page_row.customer_full_name), ''), page_row.lead_name, 'Customer'),
        'phone', page_row.lead_phone,
        'interested_model', page_row.interested_model,
        'channel', page_row.channel,
        'state', page_row.review_state,
        'sent_at', coalesce(page_row.sent_at, page_row.created_at),
        'expires_at', page_row.token_expires_at,
        'completed_at', page_row.completed_at,
        'rating', page_row.rating,
        'comments', page_row.comments,
        'keywords', to_jsonb(page_row.review_keywords),
        'sent_to_google', page_row.review_redirected_at is not null
      ) order by page_row.created_at desc, page_row.id desc)
      from (
        select * from listed order by created_at desc, id desc
        limit page_size offset page_offset
      ) page_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

-- Same as 202610142271 plus what the review step needs: the keyword list, the
-- first name of whoever sent the link, and whether AI rephrasing is available.
-- Still returns no customer data.
create or replace function public.get_public_feedback_form(target_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  branch_row public.branches%rowtype;
  organization_name text;
  sender_first_name text;
  ai_ready boolean;
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
  select * into branch_row from public.branches where id = feedback_row.branch_id;
  select name into organization_name from public.organizations
  where id = feedback_row.organization_id;
  select nullif(split_part(btrim(coalesce(profile_row.full_name, '')), ' ', 1), '')
  into sender_first_name
  from public.profiles profile_row where profile_row.id = feedback_row.requested_by;
  select exists (
    select 1 from public.connected_accounts account_row
    where account_row.organization_id = feedback_row.organization_id
      and account_row.provider_key = 'openrouter'
      and account_row.scope_mode = 'ALL_BRANCHES'
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
      and account_row.connection_config -> 'capabilities' ? 'TEXT_GENERATION'
      and nullif(account_row.connection_config #>> '{models,text_model}', '') is not null
  ) into ai_ready;
  return jsonb_build_object(
    'status', 'OPEN', 'branch', branch_row.name, 'organization', organization_name,
    'brand_color', branch_row.feedback_brand_color,
    'has_logo', branch_row.feedback_logo_object_file_id is not null,
    'sender_first_name', sender_first_name,
    'keywords', to_jsonb(app_private.review_keyword_options()),
    'ai_available', ai_ready and feedback_row.ai_rephrase_count < 5,
    'ai_remaining', greatest(5 - feedback_row.ai_rephrase_count, 0)
  );
end;
$$;

-- The customer's submission with the review step. Single use like
-- submit_public_feedback, which stays for older links. review_redirected_at
-- records that the Google page was opened for them; whether they posted is not
-- something the CRM can see.
create or replace function public.submit_public_feedback_review(
  target_token text,
  target_rating smallint,
  target_review text,
  target_keywords text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  review_url text;
  allowed_keywords text[];
begin
  if target_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'INVALID');
  end if;
  if target_rating is null or target_rating not between 1 and 5
    or length(coalesce(target_review, '')) > 4000
    or coalesce(array_length(target_keywords, 1), 0) > 20
  then
    raise exception using errcode = '22023', message = 'INVALID_FEEDBACK_INPUT';
  end if;
  select coalesce(array_agg(distinct keyword order by keyword), '{}') into allowed_keywords
  from unnest(coalesce(target_keywords, '{}')) keyword
  where keyword = any(app_private.review_keyword_options());

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

  select coalesce(branch_row.google_review_url, organization_row.google_review_url)
  into review_url
  from public.branches branch_row
  join public.organizations organization_row on organization_row.id = branch_row.organization_id
  where branch_row.id = feedback_row.branch_id;

  update public.feedback_requests
  set rating = target_rating,
    comments = nullif(btrim(target_review), ''),
    review_keywords = allowed_keywords,
    status = 'COMPLETED',
    completed_at = now(),
    submitted_at = now(),
    review_redirected_at = case when review_url is not null then now() end,
    public_token = null,
    token_expires_at = null
  where id = feedback_row.id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    feedback_row.organization_id, null, 'feedback_request.submitted_publicly',
    'feedback_request', feedback_row.id::text, feedback_row.branch_id,
    jsonb_build_object('rating', target_rating, 'keywords', to_jsonb(allowed_keywords),
      'with_review_step', true)
  );
  -- Offered to every rating: withholding it from unhappy customers is review
  -- gating, which Google's policy prohibits.
  return jsonb_build_object(
    'status', 'RECORDED', 'rating', target_rating, 'review_url', review_url
  );
end;
$$;

-- Service role only, called by public-review-rephrase. Validates the live
-- token, spends one of the link's five rephrases and one AI credit, and
-- returns what the prompt needs. The reference makes a retried request free.
create or replace function public.begin_public_review_rephrase(
  target_token text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  branch_name text;
  sender_first_name text;
  reference text := 'review-rephrase:' || target_request_id::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_token !~ '^[0-9a-f]{64}$' or target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_REPHRASE_REQUEST';
  end if;
  select * into feedback_row from public.feedback_requests
  where public_token = target_token and token_expires_at > now() and status <> 'COMPLETED'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FEEDBACK_LINK_NOT_OPEN';
  end if;
  if exists (select 1 from public.credit_ledger
    where organization_id = feedback_row.organization_id and ledger_kind = 'AI'
      and reference_id = reference)
  then
    return jsonb_build_object('organization_id', feedback_row.organization_id, 'replayed', true);
  end if;
  if feedback_row.ai_rephrase_count >= 5 then
    raise exception using errcode = 'P0001', message = 'REPHRASE_LIMIT_REACHED';
  end if;
  perform public.consume_platform_ai_credits(
    feedback_row.organization_id, 1, 'REVIEW_REPHRASE', reference
  );
  update public.feedback_requests set ai_rephrase_count = ai_rephrase_count + 1
  where id = feedback_row.id;
  select name into branch_name from public.branches where id = feedback_row.branch_id;
  select nullif(split_part(btrim(coalesce(full_name, '')), ' ', 1), '') into sender_first_name
  from public.profiles where id = feedback_row.requested_by;
  return jsonb_build_object(
    'organization_id', feedback_row.organization_id, 'replayed', false,
    'branch', branch_name, 'sender_first_name', sender_first_name
  );
end;
$$;

-- Refunds a rephrase whose provider call failed: the credit and the attempt.
create or replace function public.refund_public_review_rephrase(
  target_token text,
  target_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_requests%rowtype;
  inserted integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into feedback_row from public.feedback_requests
  where public_token = target_token for update;
  if not found or not exists (select 1 from public.credit_ledger
    where organization_id = feedback_row.organization_id and ledger_kind = 'AI'
      and reference_id = 'review-rephrase:' || target_request_id::text)
  then
    return false;
  end if;
  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature, reference_id, reason
  ) values (
    feedback_row.organization_id, 'AI', 'REVERSAL', 1, 'REVIEW_REPHRASE',
    'review-rephrase-refund:' || target_request_id::text, 'Review rephrase failed'
  ) on conflict (organization_id, ledger_kind, reference_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    update public.feedback_requests set ai_rephrase_count = greatest(ai_rephrase_count - 1, 0)
    where id = feedback_row.id;
  end if;
  return inserted > 0;
end;
$$;

-- Customer-care cases, complaints and Google review e-mail invitations are all
-- keyed by customer. For a lead with no customer yet, the completion trigger
-- records the rating in the audit trail (it shows on the sender's Reviews page)
-- instead of opening a case, and the invitation is refused with a clear reason.
-- Both are guarded patches of the deployed bodies.
do $patch$
declare
  trigger_fn regprocedure := 'app_private.route_completed_customer_feedback()'::regprocedure;
  invite_fn regprocedure := 'public.approve_feedback_review_invite(uuid,text,uuid)'::regprocedure;
  definition text;
  trigger_anchor text := $a$then return new; end if;
  if new.rating>=4 then$a$;
  invite_anchor text := $a$    raise exception using errcode = '22023', message = 'FEEDBACK_NOT_SUBMITTED';
  end if;
$a$;
begin
  definition := pg_get_functiondef(trigger_fn);
  if position('feedback.rating_without_customer' in definition) = 0 then
    if (length(definition) - length(replace(definition, trigger_anchor, ''))) / length(trigger_anchor) <> 1 then
      raise exception 'route_completed_customer_feedback anchor not found exactly once';
    end if;
    execute replace(definition, trigger_anchor, $b$then return new; end if;
  if new.customer_id is null then
    insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,branch_id,metadata)
      values(new.organization_id,auth.uid(),'feedback.rating_without_customer','feedback_request',new.id::text,
        new.branch_id,jsonb_build_object('rating',new.rating,'feedback_id',new.id,'lead_id',new.lead_id));
    return new;
  end if;
  if new.rating>=4 then$b$);
  end if;

  definition := pg_get_functiondef(invite_fn);
  if position('REVIEW_INVITE_CUSTOMER_REQUIRED' in definition) = 0 then
    if (length(definition) - length(replace(definition, invite_anchor, ''))) / length(invite_anchor) <> 1 then
      raise exception 'approve_feedback_review_invite anchor not found exactly once';
    end if;
    execute replace(definition, invite_anchor, invite_anchor || $b$  if feedback_row.customer_id is null then
    raise exception using errcode = '22023', message = 'REVIEW_INVITE_CUSTOMER_REQUIRED';
  end if;
$b$);
  end if;
end;
$patch$;

revoke all on function app_private.review_keyword_options() from public, anon, authenticated;
revoke all on function public.create_lead_review_request(uuid, uuid, text) from public, anon;
grant execute on function public.create_lead_review_request(uuid, uuid, text) to authenticated;
revoke all on function public.search_review_request_leads(text) from public, anon;
grant execute on function public.search_review_request_leads(text) to authenticated;
revoke all on function public.get_my_review_requests(date, date, text, text, integer, integer)
  from public, anon;
grant execute on function public.get_my_review_requests(date, date, text, text, integer, integer)
  to authenticated;
revoke all on function public.get_public_feedback_form(text) from public;
grant execute on function public.get_public_feedback_form(text) to anon, authenticated;
-- Reachable without a session, like submit_public_feedback: the token is the
-- credential, the function returns no customer data and spends the token.
revoke all on function public.submit_public_feedback_review(text, smallint, text, text[]) from public;
grant execute on function public.submit_public_feedback_review(text, smallint, text, text[])
  to anon, authenticated;
revoke all on function public.begin_public_review_rephrase(text, uuid) from public, anon, authenticated;
grant execute on function public.begin_public_review_rephrase(text, uuid) to service_role;
revoke all on function public.refund_public_review_rephrase(text, uuid) from public, anon, authenticated;
grant execute on function public.refund_public_review_rephrase(text, uuid) to service_role;

commit;
