begin;

create or replace function public.get_call_today_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  select jsonb_build_object(
    'total_calls', count(*)::integer,
    'connected_calls', count(*) filter (
      where upper(coalesce(call_row.outcome, '')) = 'CONNECTED'
    )::integer,
    'not_connected_calls', count(*) filter (
      where upper(coalesce(call_row.outcome, '')) <> 'CONNECTED'
    )::integer,
    'talk_time_seconds', coalesce(sum(call_row.duration_seconds), 0)::integer,
    'average_duration_seconds', coalesce(round(avg(call_row.duration_seconds)), 0)::integer
  ) into result
  from public.calls call_row
  where call_row.organization_id = current_organization_id
    and call_row.started_at >= date_trunc('day', now())
    and call_row.started_at < date_trunc('day', now()) + interval '1 day'
    and app_private.can_access_record(
      call_row.organization_id,
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id
    );
  return result;
end;
$$;

revoke all on function public.get_call_today_summary() from public, anon;
grant execute on function public.get_call_today_summary() to authenticated;

commit;
