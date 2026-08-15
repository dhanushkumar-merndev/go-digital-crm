begin;

create index if not exists support_requests_platform_pending_idx
  on public.support_access_requests (status, created_at desc, id)
  where status = 'PENDING';

create or replace function public.get_platform_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;

  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'active_dealerships', (
        select count(*)
        from public.organizations organization_row
        where organization_row.status = 'ACTIVE'
          and organization_row.deleted_at is null
      ),
      'onboarding', (
        select count(*)
        from public.organizations organization_row
        where organization_row.status in ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED')
          and organization_row.deleted_at is null
      ),
      'provider_attention', (
        select count(*)
        from public.connected_accounts connection_row
        where connection_row.deleted_at is null
          and (
            connection_row.status in ('ERROR', 'DISCONNECTED')
            or connection_row.last_error_code is not null
          )
      ),
      'pending_support', (
        select count(*)
        from public.support_access_requests request_row
        where request_row.status = 'PENDING'
      )
    ),
    'tenant_statuses', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', initcap(replace(status_summary.status, '_', ' ')),
            'value', status_summary.value
          )
          order by status_summary.status
        ),
        '[]'::jsonb
      )
      from (
        select organization_row.status::text as status, count(*)::integer as value
        from public.organizations organization_row
        where organization_row.deleted_at is null
        group by organization_row.status
      ) status_summary
    ),
    'activity', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', to_char(day_row.day, 'DD Mon'),
            'value', (
              select count(*)
              from public.organizations organization_row
              where organization_row.created_at >= day_row.day
                and organization_row.created_at < day_row.day + interval '1 day'
            ),
            'secondary', (
              select count(*)
              from public.organization_onboarding_submissions submission_row
              where submission_row.submitted_at >= day_row.day
                and submission_row.submitted_at < day_row.day + interval '1 day'
            )
          )
          order by day_row.day
        ),
        '[]'::jsonb
      )
      from (
        select generate_series(
          date_trunc('day', now()) - interval '13 days',
          date_trunc('day', now()),
          interval '1 day'
        ) as day
      ) day_row
    ),
    'attention', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'organization_id', attention_row.organization_id,
            'title', attention_row.title,
            'detail', attention_row.detail,
            'severity', attention_row.severity,
            'href', attention_row.href
          )
          order by attention_row.priority, attention_row.updated_at desc
        ),
        '[]'::jsonb
      )
      from (
        select attention_candidate.*
        from (
          select
            organization_row.id as organization_id,
            organization_row.name as title,
            case organization_row.status
              when 'UNDER_REVIEW' then 'Onboarding evidence is awaiting a platform decision.'
              when 'CHANGES_REQUIRED' then 'The Business Owner must resubmit requested evidence.'
              when 'SUSPENDED' then 'Tenant access is suspended and requires review.'
              else 'Tenant onboarding was rejected.'
            end as detail,
            case
              when organization_row.status in ('SUSPENDED', 'REJECTED') then 'high'
              else 'medium'
            end as severity,
            case
              when organization_row.status = 'UNDER_REVIEW'
                then '/super-admin/onboarding-reviews?status=submitted'
              when organization_row.status = 'CHANGES_REQUIRED'
                then '/super-admin/onboarding-reviews?status=changes-required'
              when organization_row.status = 'SUSPENDED'
                then '/super-admin/dealerships?status=suspended'
              else '/super-admin/dealerships?status=rejected'
            end as href,
            case
              when organization_row.status in ('SUSPENDED', 'REJECTED') then 1
              else 2
            end as priority,
            organization_row.updated_at
          from public.organizations organization_row
          where organization_row.status in (
            'UNDER_REVIEW', 'CHANGES_REQUIRED', 'SUSPENDED', 'REJECTED'
          )
            and organization_row.deleted_at is null

          union all

          select
            organization_row.id,
            organization_row.name,
            'A support access request is awaiting the Business Owner decision.',
            'medium',
            '/super-admin/support-sessions?status=pending',
            2,
            request_row.created_at
          from public.support_access_requests request_row
          join public.organizations organization_row
            on organization_row.id = request_row.organization_id
          where request_row.status = 'PENDING'
            and organization_row.deleted_at is null
        ) attention_candidate
        order by attention_candidate.priority, attention_candidate.updated_at desc
        limit 8
      ) attention_row
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_platform_dashboard() from public, anon;
grant execute on function public.get_platform_dashboard() to authenticated;

commit;
