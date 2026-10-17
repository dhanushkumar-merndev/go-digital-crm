-- Branch-themed customer feedback page, and the branch Google review link filled
-- from Google Business Profile.
--
-- 1. When a Google Business Profile location is mapped to a branch, the branch's
--    google_review_url is filled from the location's own "write a review" link
--    (Business Information API Location.metadata.newReviewUri). It only fills an
--    empty link: a link someone typed in is never overwritten by a mapping.
-- 2. Each branch can carry a brand colour and a logo for its public feedback
--    page. The logo is an image the admin uploaded through presign-upload as an
--    `organization` object; the public-feedback-logo Edge Function presigns it
--    for a visitor holding a live feedback token.
--
-- The review link is still shown to every rating. See 202609070202 on review
-- gating.

begin;

alter table public.branches
  add column if not exists feedback_brand_color text,
  add column if not exists feedback_logo_object_file_id uuid references public.object_files(id);

alter table public.branches
  drop constraint if exists branches_feedback_brand_color_format,
  add constraint branches_feedback_brand_color_format check (
    feedback_brand_color is null or feedback_brand_color ~ '^#[0-9a-f]{6}$'
  );

-- ---------------------------------------------------------------------------
-- 1. Review link from the mapped Google Business Profile location.
-- ---------------------------------------------------------------------------

create or replace function app_private.fill_branch_review_url_from_gbp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  review_url text := nullif(btrim(new.mapping_metadata ->> 'review_url'), '');
begin
  if new.deleted_at is not null
    or new.external_resource_type <> 'GBP_LOCATION'
    or review_url is null
    or char_length(review_url) > 2048
    or review_url !~* '^https://([a-z0-9-]+\.)*(google\.com|g\.page)/'
  then
    return new;
  end if;

  begin
    update public.branches
    set google_review_url = review_url
    where id = new.branch_id
      and organization_id = new.organization_id
      and deleted_at is null
      and google_review_url is null;
    if found then
      insert into public.audit_logs (
        organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
      ) values (
        new.organization_id, auth.uid(), 'branch.google_review_url_filled', 'branch',
        new.branch_id::text, new.branch_id,
        jsonb_build_object(
          'source', 'GOOGLE_BUSINESS_PROFILE',
          'location', new.external_resource_id,
          'connected_account_id', new.connected_account_id
        )
      );
    end if;
  exception when sqlstate '23514' then
    -- A legacy branch row that fails validate_branch_administration_row cannot
    -- take the update. The link stays empty and the mapping itself still saves.
    null;
  end;
  return new;
end;
$$;

revoke all on function app_private.fill_branch_review_url_from_gbp() from public, anon, authenticated;

drop trigger if exists fill_branch_review_url_from_gbp on public.integration_branch_mappings;
create trigger fill_branch_review_url_from_gbp
after insert or update of deleted_at, mapping_metadata on public.integration_branch_mappings
for each row execute function app_private.fill_branch_review_url_from_gbp();

-- ---------------------------------------------------------------------------
-- 2. Feedback page branding.
-- ---------------------------------------------------------------------------

create or replace function public.get_branch_feedback_branding(target_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  branch_row public.branches%rowtype;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
  then
    raise exception using errcode = '42501', message = 'BRANCH_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into branch_row from public.branches
  where id = target_branch_id
    and organization_id = current_organization_id
    and deleted_at is null;
  if not found or not app_private.can_access_branch(current_organization_id, branch_row.id) then
    raise exception using errcode = 'P0002', message = 'BRANCH_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'branch_id', branch_row.id,
    'version', branch_row.version,
    'brand_color', branch_row.feedback_brand_color,
    'logo_object_file_id', branch_row.feedback_logo_object_file_id,
    'google_review_url', branch_row.google_review_url
  );
end;
$$;

create or replace function public.set_branch_feedback_branding(
  target_branch_id uuid,
  expected_version integer,
  target_brand_color text,
  target_logo_action text,
  target_logo_object_file_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  branch_row public.branches%rowtype;
  normalized_color text := lower(nullif(btrim(coalesce(target_brand_color, '')), ''));
  next_logo uuid;
  updated_version integer;
begin
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'branch.manage')
  then
    raise exception using errcode = '42501', message = 'BRANCH_MANAGE_PERMISSION_REQUIRED';
  end if;
  if normalized_color is not null and normalized_color !~ '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'INVALID_BRAND_COLOR';
  end if;
  if target_logo_action is null or target_logo_action not in ('KEEP', 'REPLACE', 'REMOVE')
    or (target_logo_action = 'REPLACE') <> (target_logo_object_file_id is not null)
  then
    raise exception using errcode = '22023', message = 'INVALID_LOGO_ACTION';
  end if;

  select * into branch_row from public.branches
  where id = target_branch_id
    and organization_id = current_organization_id
    and deleted_at is null
  for update;
  if not found or not app_private.can_access_branch(current_organization_id, branch_row.id) then
    raise exception using errcode = 'P0002', message = 'BRANCH_NOT_FOUND';
  end if;
  if branch_row.version <> expected_version then
    raise exception using errcode = 'PT409', message = 'BRANCH_VERSION_CONFLICT';
  end if;

  next_logo := case target_logo_action
    when 'KEEP' then branch_row.feedback_logo_object_file_id
    when 'REMOVE' then null
    else target_logo_object_file_id
  end;
  -- The logo becomes publicly visible on the feedback page, so only a small
  -- image the caller uploaded themselves can be linked. Organization objects
  -- also hold compliance documents; this keeps one from being published.
  if target_logo_action = 'REPLACE' and not exists (
    select 1 from public.object_files file_row
    where file_row.id = target_logo_object_file_id
      and file_row.organization_id = current_organization_id
      and file_row.resource_type = 'organization'
      and file_row.resource_id = current_organization_id
      and file_row.branch_id is null
      and file_row.uploaded_by = auth.uid()
      and file_row.deleted_at is null
      and file_row.mime_type in ('image/png', 'image/jpeg', 'image/webp')
      and file_row.size_bytes between 1 and 2 * 1024 * 1024
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LOGO_FILE';
  end if;

  update public.branches
  set feedback_brand_color = normalized_color,
    feedback_logo_object_file_id = next_logo
  where id = branch_row.id
  returning version into updated_version;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'branch.feedback_branding_updated', 'branch',
    branch_row.id::text, branch_row.id,
    jsonb_build_object(
      'previous_brand_color', branch_row.feedback_brand_color,
      'brand_color', normalized_color,
      'logo_action', target_logo_action,
      'logo_object_file_id', next_logo
    )
  );
  return jsonb_build_object(
    'branch_id', branch_row.id,
    'version', updated_version,
    'brand_color', normalized_color,
    'logo_object_file_id', next_logo
  );
end;
$$;

-- Unchanged from 202609070202 apart from the two branding keys. Still returns
-- no customer data: a leaked token reveals which showroom asked, nothing more.
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
  return jsonb_build_object(
    'status', 'OPEN', 'branch', branch_row.name, 'organization', organization_name,
    'brand_color', branch_row.feedback_brand_color,
    'has_logo', branch_row.feedback_logo_object_file_id is not null
  );
end;
$$;

-- Service role only: the public-feedback-logo Edge Function resolves a live
-- token to the branch logo object it may presign. Nothing else is returned.
create or replace function public.resolve_public_feedback_logo(target_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  logo_row public.object_files%rowtype;
begin
  if target_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select file_row.* into logo_row
  from public.feedback_requests feedback_row
  join public.branches branch_row
    on branch_row.id = feedback_row.branch_id
   and branch_row.organization_id = feedback_row.organization_id
  join public.object_files file_row
    on file_row.id = branch_row.feedback_logo_object_file_id
   and file_row.organization_id = feedback_row.organization_id
  where feedback_row.public_token = target_token
    and feedback_row.token_expires_at > now()
    and feedback_row.status <> 'COMPLETED'
    and file_row.deleted_at is null
    and file_row.mime_type in ('image/png', 'image/jpeg', 'image/webp');
  if not found then return null; end if;
  return jsonb_build_object(
    'bucket', logo_row.bucket,
    'object_key', logo_row.object_key,
    'mime_type', logo_row.mime_type
  );
end;
$$;

revoke all on function public.get_branch_feedback_branding(uuid) from public, anon;
grant execute on function public.get_branch_feedback_branding(uuid) to authenticated;
revoke all on function public.set_branch_feedback_branding(uuid, integer, text, text, uuid)
  from public, anon;
grant execute on function public.set_branch_feedback_branding(uuid, integer, text, text, uuid)
  to authenticated;
revoke all on function public.get_public_feedback_form(text) from public;
grant execute on function public.get_public_feedback_form(text) to anon, authenticated;
revoke all on function public.resolve_public_feedback_logo(text) from public, anon, authenticated;
grant execute on function public.resolve_public_feedback_logo(text) to service_role;

commit;
