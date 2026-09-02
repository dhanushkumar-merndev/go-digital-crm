-- Qualify the Team Manager queue's organization variable. PL/pgSQL otherwise
-- treats the unqualified name as ambiguous beside joined organization_id columns.
create or replace function public.get_duplicate_lead_deletion_requests(
  target_status text default 'PENDING',
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
  current_organization_id uuid;
  normalized_status text := upper(btrim(coalesce(target_status, 'PENDING')));
  normalized_search text := btrim(coalesce(target_search, ''));
  result jsonb;
begin
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.is_team_manager(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'lead.view')
  then
    raise exception using errcode = '42501', message = 'TEAM_MANAGER_APPROVAL_REQUIRED';
  end if;
  if normalized_status not in ('PENDING', 'APPROVED', 'REJECTED') then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST_STATUS';
  end if;
  if target_page < 1 or target_page_size not in (25, 50, 100)
    or char_length(normalized_search) > 120
  then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION_OR_SEARCH';
  end if;

  with filtered as (
    select
      request_row.id,
      request_row.status,
      request_row.reason,
      request_row.review_note,
      request_row.requested_at,
      request_row.decided_at,
      request_row.lead_id,
      duplicate_lead.customer_name,
      duplicate_lead.phone,
      duplicate_lead.source,
      duplicate_lead.interested_model,
      duplicate_lead.lifecycle_status,
      duplicate_lead.branch_id,
      duplicate_lead.team_id,
      branch_row.name as branch_name,
      team_row.name as team_name,
      request_row.retained_lead_id,
      retained_lead.customer_name as retained_customer_name,
      retained_lead.source as retained_source,
      retained_lead.lifecycle_status as retained_lifecycle_status,
      retained_lead.created_at as retained_created_at,
      requester.full_name as requester_name,
      reviewer.full_name as reviewer_name
    from public.lead_duplicate_deletion_requests request_row
    join public.leads duplicate_lead
      on duplicate_lead.id = request_row.lead_id
     and duplicate_lead.organization_id = request_row.organization_id
    join public.leads retained_lead
      on retained_lead.id = request_row.retained_lead_id
     and retained_lead.organization_id = request_row.organization_id
    join public.branches branch_row on branch_row.id = request_row.branch_id
    left join public.teams team_row on team_row.id = request_row.team_id
    join public.profiles requester on requester.id = request_row.requested_by
    left join public.profiles reviewer on reviewer.id = request_row.reviewed_by
    where request_row.organization_id = current_organization_id
      and request_row.status = normalized_status
      and app_private.can_access_record(
        request_row.organization_id,
        request_row.branch_id,
        request_row.team_id,
        duplicate_lead.assigned_user_id
      )
      and (
        normalized_search = ''
        or duplicate_lead.customer_name ilike '%' || normalized_search || '%'
        or duplicate_lead.phone ilike '%' || normalized_search || '%'
        or duplicate_lead.id::text ilike '%' || normalized_search || '%'
        or requester.full_name ilike '%' || normalized_search || '%'
      )
  ), counted as (
    select filtered.*, count(*) over () as full_count
    from filtered
  ), paged as (
    select *
    from counted
    order by requested_at desc, id
    limit target_page_size
    offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce(
      jsonb_agg(to_jsonb(paged) - 'full_count' order by requested_at desc, id),
      '[]'::jsonb
    ),
    'total', coalesce(max(full_count), 0),
    'page', target_page,
    'page_size', target_page_size
  ) into result
  from paged;

  return result;
end;
$$;

revoke all on function public.get_duplicate_lead_deletion_requests(text, text, integer, integer)
  from public, anon;
grant execute on function public.get_duplicate_lead_deletion_requests(text, text, integer, integer)
  to authenticated;

