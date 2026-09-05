begin;

-- The sales-consultant hot path added two Calls KPI fields. Other roles still
-- pass through the legacy seven-argument workspace function, whose response
-- predates those fields. Keep the shared response contract identical for every
-- role without changing the established legacy query and pagination behavior.
create or replace function public.get_call_workspace_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL',
  target_outcome text default 'ALL',
  target_source text default 'ALL',
  target_sort text default 'started:desc',
  target_view text default 'HISTORY'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  allowed_branch_ids uuid[];
  permission_keys text[];
  customer_access boolean;
  lead_access boolean;
  normalized_view text := upper(btrim(coalesce(target_view, 'HISTORY')));
  legacy_result jsonb;
  legacy_total_today bigint;
  legacy_connected_today bigint;
  legacy_talk_time_seconds bigint;
begin
  if normalized_view not in ('TODAY', 'HISTORY', 'MISSED', 'RECORDINGS', 'AI') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_VIEW';
  end if;

  access_context := public.get_access_context();
  if access_context->>'role_key' = 'sales-consultant' then
    if access_context->>'destination' <> 'CRM'
      or access_context->>'organization_id' is null
    then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    current_organization_id := (access_context->>'organization_id')::uuid;
    permission_keys := app_private.sales_consultant_permissions(current_organization_id);
    if not ('call.view' = any(permission_keys)) then
      raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
    end if;
    customer_access := 'customer.view' = any(permission_keys);
    lead_access := 'lead.view' = any(permission_keys);
    allowed_branch_ids := app_private.sales_consultant_allowed_branches(
      current_organization_id
    );
    return app_private.get_sales_consultant_call_workspace_page(
      current_organization_id,
      allowed_branch_ids,
      customer_access,
      lead_access,
      target_search,
      target_page,
      target_page_size,
      target_status,
      target_outcome,
      target_source,
      target_sort,
      normalized_view
    );
  end if;

  legacy_result := public.get_call_workspace_page_legacy(
    target_search,
    target_page,
    target_page_size,
    target_status,
    target_outcome,
    target_source,
    target_sort
  );

  current_organization_id := nullif(access_context->>'organization_id', '')::uuid;
  if current_organization_id is null then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  legacy_total_today := coalesce((legacy_result #>> '{kpis,total_today}')::bigint, 0);
  legacy_connected_today := coalesce(
    (legacy_result #>> '{kpis,connected_today}')::bigint,
    0
  );

  select coalesce(sum(call_row.duration_seconds), 0)::bigint
  into legacy_talk_time_seconds
  from public.calls call_row
  where call_row.organization_id = current_organization_id
    and call_row.started_at >= date_trunc('day', now())
    and app_private.can_access_record(
      call_row.organization_id,
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id
    );

  legacy_result := jsonb_set(
    legacy_result,
    '{kpis,not_connected_today}',
    to_jsonb(greatest(legacy_total_today - legacy_connected_today, 0)),
    true
  );
  legacy_result := jsonb_set(
    legacy_result,
    '{kpis,talk_time_seconds}',
    to_jsonb(legacy_talk_time_seconds),
    true
  );

  return legacy_result;
end;
$$;

revoke all on function public.get_call_workspace_page(
  text, integer, integer, text, text, text, text, text
) from public, anon;
grant execute on function public.get_call_workspace_page(
  text, integer, integer, text, text, text, text, text
) to authenticated;

commit;
