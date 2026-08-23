-- A provider-independent draft is a real CRM record. Publishing and scheduled
-- dispatch remain behind provider-specific jobs, not the browser.

create or replace function public.get_social_post_draft_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'SOCIAL_POST_MANAGE_PERMISSION_REQUIRED';
  end if;

  return jsonb_build_object(
    'can_use_organization_scope', app_private.has_organization_wide_scope(current_organization_id),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', branch_row.id, 'name', branch_row.name)
        order by branch_row.name, branch_row.id)
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.active
        and app_private.can_access_branch(current_organization_id, branch_row.id)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.create_social_post_draft(
  target_platform text,
  target_content text,
  target_branch_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_platform text := upper(btrim(coalesce(target_platform, '')));
  normalized_content text := btrim(coalesce(target_content, ''));
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  draft_id uuid := gen_random_uuid();
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null
    or normalized_platform not in ('FACEBOOK', 'INSTAGRAM', 'GOOGLE_BUSINESS_PROFILE', 'OTHER')
    or char_length(normalized_content) not between 1 and 5000
  then
    raise exception using errcode = '22023', message = 'INVALID_SOCIAL_POST_DRAFT_INPUT';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'SOCIAL_POST_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_branch_id is null then
    if not app_private.has_organization_wide_scope(current_organization_id) then
      raise exception using errcode = '42501', message = 'SOCIAL_POST_ORGANIZATION_SCOPE_DENIED';
    end if;
  elsif not exists (
    select 1
    from public.branches branch_row
    where branch_row.organization_id = current_organization_id
      and branch_row.id = target_branch_id
      and branch_row.active
      and app_private.can_access_branch(current_organization_id, branch_row.id)
  ) then
    raise exception using errcode = '42501', message = 'SOCIAL_POST_BRANCH_SCOPE_DENIED';
  end if;

  fingerprint := jsonb_build_object(
    'platform', normalized_platform,
    'content', normalized_content,
    'branch_id', target_branch_id
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'social_post.draft_created'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;

  insert into public.social_posts (
    id, organization_id, branch_id, platform, content, status, created_by
  ) values (
    draft_id, current_organization_id, target_branch_id, normalized_platform,
    normalized_content, 'DRAFT', auth.uid()
  );
  result := jsonb_build_object(
    'id', draft_id,
    'status', 'DRAFT',
    'platform', normalized_platform,
    'branch_id', target_branch_id,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'social_post.draft_created', 'social_post',
    draft_id::text, target_branch_id, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

revoke all on function public.get_social_post_draft_options() from public, anon;
grant execute on function public.get_social_post_draft_options() to authenticated;
revoke all on function public.create_social_post_draft(text, text, uuid, uuid) from public, anon;
grant execute on function public.create_social_post_draft(text, text, uuid, uuid) to authenticated;
