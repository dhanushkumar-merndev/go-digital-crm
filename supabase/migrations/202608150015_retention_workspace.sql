begin;

create index deletion_requests_platform_workspace_idx
  on public.deletion_requests (status, updated_at desc, id);
create index deletion_requests_platform_hold_idx
  on public.deletion_requests (legal_hold, purge_after, id)
  where status in ('PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED');

create or replace function public.get_platform_retention_workspace(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default '',
  target_status text default 'OPEN',
  target_sort text default 'PURGE_ASC'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare normalized_search text := btrim(coalesce(target_search, ''));
declare escaped_search text;
declare result jsonb;
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;
  if target_page is null
    or target_page < 1
    or target_page_size is null
    or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 160
    or target_status is null
    or target_status not in (
      'ALL', 'OPEN', 'PENDING_APPROVAL', 'APPROVED', 'LEGAL_HOLD',
      'PURGING', 'FAILED', 'RESTORED', 'REJECTED', 'PURGED'
    )
    or target_sort is null
    or target_sort not in ('PURGE_ASC', 'PURGE_DESC', 'DELETED_DESC', 'DEALERSHIP_ASC')
  then
    raise exception using errcode = '22023', message = 'INVALID_RETENTION_WORKSPACE_QUERY';
  end if;
  escaped_search := replace(replace(replace(normalized_search, '\', '\\'), '%', '\%'), '_', '\_');

  with filtered as (
    select
      request_row.id,
      request_row.organization_id,
      organization_row.name as organization_name,
      organization_row.slug as organization_slug,
      request_row.status,
      request_row.original_status,
      organization_row.deleted_at,
      organization_row.deleted_by,
      deleted_actor.full_name as deleted_by_name,
      request_row.requested_by,
      requester.full_name as requested_by_name,
      request_row.approved_by,
      approver.full_name as approved_by_name,
      request_row.reason,
      request_row.created_at as requested_at,
      request_row.approved_at,
      request_row.purge_after,
      greatest(0, ceil(extract(epoch from (
        request_row.purge_after - coalesce(organization_row.deleted_at, request_row.created_at)
      )) / 86400))::integer as retention_days,
      request_row.legal_hold,
      request_row.legal_hold_reason,
      request_row.legal_hold_at,
      request_row.failure_safe_code,
      request_row.restored_at,
      request_row.purge_started_at,
      job_row.id as purge_job_id,
      job_row.status as purge_job_status,
      job_row.attempts as purge_attempts,
      job_row.last_error_code as purge_last_error_code,
      manifest_row.id as manifest_id,
      manifest_row.status as manifest_status,
      manifest_row.final_checksum as manifest_checksum,
      manifest_row.summary as manifest_summary,
      manifest_row.completed_at as purge_completed_at
    from public.deletion_requests request_row
    join public.organizations organization_row
      on organization_row.id = request_row.organization_id
     and request_row.resource_type = 'ORGANIZATION'
     and request_row.resource_id = request_row.organization_id
    left join public.profiles deleted_actor on deleted_actor.id = organization_row.deleted_by
    left join public.profiles requester on requester.id = request_row.requested_by
    left join public.profiles approver on approver.id = request_row.approved_by
    left join lateral (
      select candidate_job.*
      from public.purge_jobs candidate_job
      where candidate_job.deletion_request_id = request_row.id
      order by (candidate_job.status <> 'CANCELLED') desc,
        candidate_job.created_at desc, candidate_job.id desc
      limit 1
    ) job_row on true
    left join public.purge_manifests manifest_row
      on manifest_row.deletion_request_id = request_row.id
    where (
      normalized_search = ''
      or organization_row.name ilike '%' || escaped_search || '%' escape '\'
      or organization_row.slug ilike '%' || escaped_search || '%' escape '\'
      or request_row.id::text = normalized_search
    )
      and case target_status
        when 'ALL' then true
        when 'OPEN' then request_row.status in (
          'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED'
        )
        when 'PENDING_APPROVAL' then request_row.status in ('PENDING', 'PENDING_APPROVAL')
        when 'LEGAL_HOLD' then request_row.legal_hold
          and request_row.status in (
            'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED'
          )
        else request_row.status = target_status
      end
  ),
  page_rows as (
    select filtered_row.*
    from filtered filtered_row
    order by
      case when target_sort = 'PURGE_ASC' then filtered_row.purge_after end asc nulls last,
      case when target_sort = 'PURGE_DESC' then filtered_row.purge_after end desc nulls last,
      case when target_sort = 'DELETED_DESC' then filtered_row.deleted_at end desc nulls last,
      case when target_sort = 'DEALERSHIP_ASC' then lower(filtered_row.organization_name) end asc,
      filtered_row.id
    offset (target_page - 1) * target_page_size
    limit target_page_size
  ),
  kpis as (
    select
      count(*) filter (where request_row.status in ('PENDING', 'PENDING_APPROVAL'))::bigint
        as awaiting_approval,
      count(*) filter (
        where request_row.status = 'APPROVED' and not request_row.legal_hold
      )::bigint as scheduled,
      count(*) filter (
        where request_row.legal_hold
          and request_row.status in (
            'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED'
          )
      )::bigint as on_hold,
      count(*) filter (where request_row.status in ('PURGING', 'FAILED'))::bigint
        as attention
    from public.deletion_requests request_row
    where request_row.resource_type = 'ORGANIZATION'
      and request_row.resource_id = request_row.organization_id
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row)) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'kpis', jsonb_build_object(
      'awaiting_approval', kpi_row.awaiting_approval,
      'scheduled', kpi_row.scheduled,
      'on_hold', kpi_row.on_hold,
      'attention', kpi_row.attention
    )
  ) into result
  from kpis kpi_row;
  return result;
end;
$$;

revoke all on function public.get_platform_retention_workspace(integer, integer, text, text, text)
  from public, anon;
grant execute on function public.get_platform_retention_workspace(integer, integer, text, text, text)
  to authenticated;

create or replace function public.get_platform_retention_tenant_options(
  target_search text default ''
)
returns table (
  id uuid,
  name text,
  slug text,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare normalized_search text := btrim(coalesce(target_search, ''));
declare escaped_search text;
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'INVALID_RETENTION_TENANT_SEARCH';
  end if;
  escaped_search := replace(replace(replace(normalized_search, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  select organization_row.id,
    organization_row.name,
    organization_row.slug,
    organization_row.status::text
  from public.organizations organization_row
  where organization_row.deleted_at is null
    and organization_row.status not in ('SOFT_DELETED', 'SUPPORT_MAINTENANCE')
    and not exists (
      select 1
      from public.deletion_requests request_row
      where request_row.organization_id = organization_row.id
        and request_row.resource_type = 'ORGANIZATION'
        and request_row.resource_id = organization_row.id
        and request_row.status in ('PENDING', 'PENDING_APPROVAL', 'APPROVED', 'PURGING', 'FAILED')
    )
    and not exists (
      select 1
      from public.support_sessions session_row
      where session_row.organization_id = organization_row.id
        and session_row.ended_at is null
        and session_row.expires_at > now()
    )
    and (
      normalized_search = ''
      or organization_row.name ilike '%' || escaped_search || '%' escape '\'
      or organization_row.slug ilike '%' || escaped_search || '%' escape '\'
    )
  order by lower(organization_row.name), organization_row.id
  limit 25;
end;
$$;

revoke all on function public.get_platform_retention_tenant_options(text)
  from public, anon;
grant execute on function public.get_platform_retention_tenant_options(text)
  to authenticated;

drop trigger if exists realtime_deletion_requests_platform_invalidate
on public.deletion_requests;
create trigger realtime_deletion_requests_platform_invalidate
after insert or update on public.deletion_requests
for each row execute function app_private.broadcast_platform_invalidation('retention');
drop trigger if exists realtime_purge_jobs_platform_invalidate on public.purge_jobs;
create trigger realtime_purge_jobs_platform_invalidate
after insert or update on public.purge_jobs
for each row execute function app_private.broadcast_platform_invalidation('retention');
drop trigger if exists realtime_purge_manifests_platform_invalidate on public.purge_manifests;
create trigger realtime_purge_manifests_platform_invalidate
after insert or update on public.purge_manifests
for each row execute function app_private.broadcast_platform_invalidation('retention');

commit;
