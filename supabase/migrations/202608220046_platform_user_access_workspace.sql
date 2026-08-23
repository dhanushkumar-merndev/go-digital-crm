-- Platform user access is a read-only, paginated support/control-plane view.
-- It exposes neither auth factors nor provider credentials.

create or replace function public.get_platform_user_access_workspace(
  target_search text default '',
  target_status text default 'ALL',
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
begin
  if char_length(normalized_search) > 160
    or normalized_status not in ('ALL', 'ACTIVE', 'INACTIVE')
    or target_page not between 1 and 100000
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_USER_ACCESS_QUERY';
  end if;
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_USER_ACCESS_REQUIRED';
  end if;

  return (
    with filtered as materialized (
      select
        profile_row.id,
        profile_row.organization_id,
        coalesce(organization_row.name, 'Go Digital Marketing CRM') as organization_name,
        profile_row.full_name,
        profile_row.email,
        profile_row.phone,
        profile_row.employee_id,
        profile_row.active,
        profile_row.mfa_required,
        profile_row.created_at,
        profile_row.updated_at,
        coalesce(role_data.roles, '[]'::jsonb) as roles,
        coalesce(branch_data.branch_count, 0)::bigint as branch_count
      from public.profiles profile_row
      left join public.organizations organization_row
        on organization_row.id = profile_row.organization_id
       and organization_row.deleted_at is null
      left join lateral (
        select jsonb_agg(jsonb_build_object('name', role_row.name, 'key', role_row.role_key, 'scope', assignment_row.data_scope) order by role_row.authority_level desc, role_row.name) as roles
        from public.user_role_assignments assignment_row
        join public.roles role_row on role_row.id = assignment_row.role_id
        where assignment_row.user_id = profile_row.id
          and assignment_row.active
      ) role_data on true
      left join lateral (
        select count(*)::bigint as branch_count
        from public.user_branch_access access_row
        where access_row.user_id = profile_row.id
      ) branch_data on true
      where profile_row.deleted_at is null
        and (normalized_status = 'ALL' or (normalized_status = 'ACTIVE' and profile_row.active) or (normalized_status = 'INACTIVE' and not profile_row.active))
        and (
          normalized_search = ''
          or position(normalized_search in lower(profile_row.full_name)) > 0
          or position(normalized_search in lower(profile_row.email)) > 0
          or position(normalized_search in lower(coalesce(profile_row.phone, ''))) > 0
          or position(normalized_search in lower(coalesce(profile_row.employee_id, ''))) > 0
          or position(normalized_search in lower(coalesce(organization_row.name, ''))) > 0
        )
    ), page_rows as (
      select * from filtered
      order by active desc, updated_at desc, id desc
      limit target_page_size offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'records', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'organization_id', organization_id, 'organization_name', organization_name,
        'full_name', full_name, 'email', email, 'phone', phone, 'employee_id', employee_id,
        'active', active, 'mfa_required', mfa_required, 'created_at', created_at,
        'updated_at', updated_at, 'roles', roles, 'branch_count', branch_count
      ) order by active desc, updated_at desc, id desc) from page_rows), '[]'::jsonb),
      'total', (select count(*)::bigint from filtered),
      'kpis', jsonb_build_object(
        'total', (select count(*)::bigint from filtered),
        'active', (select count(*)::bigint from filtered where active),
        'mfa_required', (select count(*)::bigint from filtered where mfa_required),
        'organizations', (select count(distinct organization_id)::bigint from filtered where organization_id is not null)
      )
    )
  );
end;
$$;

revoke all on function public.get_platform_user_access_workspace(text, text, integer, integer) from public, anon;
grant execute on function public.get_platform_user_access_workspace(text, text, integer, integer) to authenticated;
