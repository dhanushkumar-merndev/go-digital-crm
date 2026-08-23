-- Bounded content-calendar projection for the existing social-post workspace.

create index if not exists social_posts_calendar_idx
  on public.social_posts (organization_id, scheduled_for, id)
  where deleted_at is null and scheduled_for is not null;

create or replace function public.get_social_content_calendar(
  target_start date,
  target_days integer default 7,
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  range_start timestamptz;
  range_end timestamptz;
begin
  if target_days not in (7, 14, 31)
    or target_timezone not in ('Asia/Kolkata', 'UTC')
    or target_start is null
    or target_start < (timezone(target_timezone, now())::date - 365)
    or target_start > (timezone(target_timezone, now())::date + 365)
  then
    raise exception using errcode = '22023', message = 'INVALID_SOCIAL_CONTENT_CALENDAR_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.view')
  then
    raise exception using errcode = '42501', message = 'MARKETING_VIEW_PERMISSION_REQUIRED';
  end if;
  range_start := timezone(target_timezone, target_start::timestamp);
  range_end := timezone(target_timezone, (target_start + target_days)::timestamp);
  return jsonb_build_object(
    'start_date', target_start,
    'days', target_days,
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', post_row.id,
      'platform', post_row.platform,
      'content', left(post_row.content, 240),
      'status', post_row.status,
      'scheduled_for', post_row.scheduled_for,
      'published_at', post_row.published_at
    ) order by post_row.scheduled_for, post_row.id)
    from (
      select post_source.*
      from public.social_posts post_source
      where post_source.organization_id = current_organization_id
        and post_source.deleted_at is null
        and post_source.scheduled_for >= range_start
        and post_source.scheduled_for < range_end
        and (
          (post_source.branch_id is null and app_private.has_organization_wide_scope(current_organization_id))
          or (post_source.branch_id is not null and app_private.can_access_branch(current_organization_id, post_source.branch_id))
        )
      order by post_source.scheduled_for, post_source.id
      limit 500
    ) post_row), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_social_content_calendar(date, integer, text) from public, anon;
grant execute on function public.get_social_content_calendar(date, integer, text) to authenticated;
