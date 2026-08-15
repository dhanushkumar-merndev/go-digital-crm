begin;

-- The platform review queue is ordered by status/submission time and searched by
-- dealership identity. These indexes support server-side paging without loading
-- the complete onboarding history into the browser.
create index organization_onboarding_review_queue_idx
  on public.organization_onboarding_submissions (status, submitted_at desc, id);
create index organization_onboarding_name_trgm_idx
  on public.organization_onboarding_submissions
  using gin (organization_name gin_trgm_ops);
create index organization_onboarding_legal_name_trgm_idx
  on public.organization_onboarding_submissions
  using gin (legal_name gin_trgm_ops);
create index organization_onboarding_gst_trgm_idx
  on public.organization_onboarding_submissions
  using gin (gst_number gin_trgm_ops);

create index organizations_platform_status_created_idx
  on public.organizations (status, created_at desc, id)
  where deleted_at is null;
create index organizations_name_trgm_idx
  on public.organizations using gin (name gin_trgm_ops);
create index organizations_legal_name_trgm_idx
  on public.organizations using gin (legal_name gin_trgm_ops);

drop policy if exists platform_profiles_read on public.profiles;
create policy platform_profiles_read on public.profiles
for select to authenticated using (
  app_private.is_platform_admin()
  and app_private.mfa_policy_satisfied(null)
);

create or replace function public.get_platform_onboarding_kpis()
returns table (
  submitted bigint,
  changes_required bigint,
  approved bigint,
  rejected bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*) filter (where status = 'SUBMITTED')::bigint as submitted,
    count(*) filter (where status = 'CHANGES_REQUIRED')::bigint as changes_required,
    count(*) filter (where status = 'APPROVED')::bigint as approved,
    count(*) filter (where status = 'REJECTED')::bigint as rejected
  from public.organization_onboarding_submissions;
$$;

revoke all on function public.get_platform_onboarding_kpis() from public, anon;
grant execute on function public.get_platform_onboarding_kpis() to authenticated;

create or replace function public.get_platform_dealership_kpis()
returns table (
  total bigint,
  active bigint,
  onboarding bigint,
  attention bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where status = 'ACTIVE')::bigint as active,
    count(*) filter (
      where status in ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED')
    )::bigint as onboarding,
    count(*) filter (where status in ('SUSPENDED', 'REJECTED', 'SOFT_DELETED'))::bigint as attention
  from public.organizations;
$$;

revoke all on function public.get_platform_dealership_kpis() from public, anon;
grant execute on function public.get_platform_dealership_kpis() to authenticated;

commit;
