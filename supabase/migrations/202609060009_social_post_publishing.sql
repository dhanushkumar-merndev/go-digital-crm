-- social_posts already modelled the whole lifecycle -- SCHEDULED,
-- PUBLISH_REQUESTED, PUBLISHED, provider_post_id, safe_error_code -- but only
-- create_social_post_draft existed, so a post could be written and never leave
-- DRAFT. This adds the request path and the worker queue that lifecycle implies.

alter table public.social_posts
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_token text,
  add column if not exists asset_id uuid references public.marketing_assets(id);
alter table public.social_posts
  drop constraint if exists social_posts_attempts_bounded,
  add constraint social_posts_attempts_bounded check (attempts between 0 and 10);

-- The dispatcher's only query: what is due to publish now.
create index if not exists social_posts_due_idx
  on public.social_posts (next_attempt_at, id) where status = 'PUBLISH_REQUESTED';
create index if not exists social_posts_leased_idx
  on public.social_posts (updated_at) where status = 'PUBLISH_REQUESTED' and lease_token is not null;

-- Moves a reviewed draft into the publish queue. The connection is resolved and
-- pinned here rather than at send time, so the account a person chose is the
-- account that posts.
create or replace function public.request_social_post_publish(
  target_post_id uuid,
  target_connected_account_id uuid,
  target_asset_id uuid,
  target_scheduled_for timestamptz,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  post_row public.social_posts%rowtype;
  asset_file uuid;
  resolved_status text;
  resolved_due timestamptz;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_SOCIAL_PERMISSION_REQUIRED';
  end if;
  if target_post_id is null or target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_SOCIAL_PUBLISH_INPUT';
  end if;

  select * into post_row from public.social_posts
  where id = target_post_id and organization_id = current_organization_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'SOCIAL_POST_NOT_FOUND';
  end if;
  if post_row.branch_id is not null
    and not app_private.can_access_branch(current_organization_id, post_row.branch_id)
  then
    raise exception using errcode = '42501', message = 'SOCIAL_POST_SCOPE_DENIED';
  end if;
  -- Requesting publication twice is a double click; a published post is final.
  if post_row.status = 'PUBLISH_REQUESTED' then
    return jsonb_build_object('id', post_row.id, 'status', post_row.status, 'replayed', true);
  end if;
  if post_row.status not in ('DRAFT', 'SCHEDULED', 'FAILED') then
    raise exception using errcode = '22023', message = 'SOCIAL_POST_NOT_PUBLISHABLE';
  end if;

  -- Google Business Profile posts through a different API than the Meta graph;
  -- refusing here is clearer than a worker failing on every attempt.
  if post_row.platform not in ('FACEBOOK', 'INSTAGRAM') then
    raise exception using errcode = '22023', message = 'SOCIAL_PLATFORM_NOT_PUBLISHABLE';
  end if;
  if not exists (
    select 1 from public.connected_accounts account_row
    where account_row.id = target_connected_account_id
      and account_row.organization_id = current_organization_id
      and account_row.provider_key = 'meta'
      and account_row.status = 'CONNECTED'
      and account_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'SOCIAL_CONNECTION_NOT_AVAILABLE';
  end if;

  if target_asset_id is not null then
    select asset_row.object_file_id into asset_file
    from public.marketing_assets asset_row
    where asset_row.id = target_asset_id
      and asset_row.organization_id = current_organization_id
      and asset_row.deleted_at is null;
    if asset_file is null then
      raise exception using errcode = '22023', message = 'SOCIAL_ASSET_NOT_FOUND';
    end if;
  end if;
  -- Instagram will not accept a post without an image.
  if post_row.platform = 'INSTAGRAM' and asset_file is null
    and jsonb_array_length(post_row.media_object_file_ids) = 0
  then
    raise exception using errcode = '22023', message = 'SOCIAL_IMAGE_REQUIRED';
  end if;

  resolved_due := coalesce(target_scheduled_for, now());
  resolved_status := 'PUBLISH_REQUESTED';

  update public.social_posts
  set status = resolved_status,
    connected_account_id = target_connected_account_id,
    asset_id = target_asset_id,
    media_object_file_ids = case
      when asset_file is null then media_object_file_ids
      else jsonb_build_array(asset_file) end,
    scheduled_for = resolved_due,
    next_attempt_at = resolved_due,
    attempts = 0,
    lease_token = null,
    safe_error_code = null,
    version = version + 1,
    updated_at = now()
  where id = post_row.id and organization_id = current_organization_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'social_post.publish_requested', 'social_post',
    post_row.id::text, post_row.branch_id, target_request_id,
    jsonb_build_object('platform', post_row.platform, 'scheduled_for', resolved_due)
  );
  return jsonb_build_object('id', post_row.id, 'status', resolved_status, 'replayed', false);
end;
$$;

create or replace function public.claim_due_social_posts(
  target_worker_id text,
  target_batch_size integer default 5
)
returns table (
  id uuid, organization_id uuid, platform text, content text,
  connected_account_id uuid, media_object_file_ids jsonb, lease_token text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160
    or target_batch_size not between 1 and 25
  then
    raise exception using errcode = '22023', message = 'INVALID_SOCIAL_WORKER_CLAIM';
  end if;
  return query
  with candidates as (
    select post_row.id from public.social_posts post_row
    where post_row.status = 'PUBLISH_REQUESTED'
      and post_row.lease_token is null
      and coalesce(post_row.next_attempt_at, post_row.scheduled_for, post_row.created_at) <= now()
      and post_row.deleted_at is null
    order by coalesce(post_row.next_attempt_at, post_row.scheduled_for), post_row.id
    for update skip locked limit target_batch_size
  ), claimed as (
    update public.social_posts post_row
    set attempts = post_row.attempts + 1,
      lease_token = target_worker_id || ':' || gen_random_uuid()::text,
      updated_at = now()
    from candidates where post_row.id = candidates.id
    returning post_row.*
  )
  select claimed.id, claimed.organization_id, claimed.platform, claimed.content,
    claimed.connected_account_id, claimed.media_object_file_ids, claimed.lease_token
  from claimed;
end;
$$;

create or replace function public.complete_social_post(
  target_post_id uuid,
  target_lease_token text,
  target_provider_post_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare updated_rows integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.social_posts
  set status = 'PUBLISHED', published_at = now(), lease_token = null,
    provider_post_id = left(btrim(coalesce(target_provider_post_id, '')), 200),
    safe_error_code = null, version = version + 1, updated_at = now()
  where id = target_post_id and lease_token = target_lease_token
    and status = 'PUBLISH_REQUESTED';
  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$$;

create or replace function public.retry_social_post(
  target_post_id uuid,
  target_lease_token text,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  post_row public.social_posts%rowtype;
  normalized_code text := left(btrim(coalesce(target_safe_error_code, '')), 100);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if normalized_code !~ '^[A-Z0-9_]{3,100}$' then
    normalized_code := 'SOCIAL_PUBLISH_RETRY';
  end if;
  select * into post_row from public.social_posts
  where id = target_post_id and lease_token = target_lease_token
    and status = 'PUBLISH_REQUESTED'
  for update;
  if not found then return false; end if;

  if post_row.attempts >= 10 then
    -- A failed post stays visible with its reason rather than silently retrying
    -- forever; a person decides whether to request it again.
    update public.social_posts
    set status = 'FAILED', safe_error_code = normalized_code, lease_token = null,
      version = version + 1, updated_at = now()
    where id = post_row.id;
  else
    update public.social_posts
    set lease_token = null, safe_error_code = normalized_code, updated_at = now(),
      next_attempt_at = now() + least(interval '2 hours',
        interval '1 minute' * power(2, least(post_row.attempts, 6)))
    where id = post_row.id;
  end if;
  return true;
end;
$$;

create or replace function public.release_stalled_social_posts(
  target_stale_minutes integer default 20
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare released integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_stale_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'INVALID_SOCIAL_STALE_WINDOW';
  end if;
  update public.social_posts
  set lease_token = null, next_attempt_at = now(), safe_error_code = 'SOCIAL_LEASE_EXPIRED',
    updated_at = now()
  where status = 'PUBLISH_REQUESTED' and lease_token is not null
    and updated_at < now() - make_interval(mins => target_stale_minutes);
  get diagnostics released = row_count;
  return released;
end;
$$;

revoke all on function public.request_social_post_publish(uuid, uuid, uuid, timestamptz, uuid)
  from public, anon;
grant execute on function public.request_social_post_publish(uuid, uuid, uuid, timestamptz, uuid)
  to authenticated;
revoke all on function public.claim_due_social_posts(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_social_posts(text, integer) to service_role;
revoke all on function public.complete_social_post(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_social_post(uuid, text, text) to service_role;
revoke all on function public.retry_social_post(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.retry_social_post(uuid, text, text) to service_role;
revoke all on function public.release_stalled_social_posts(integer)
  from public, anon, authenticated;
grant execute on function public.release_stalled_social_posts(integer) to service_role;
