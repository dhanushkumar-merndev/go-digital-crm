-- The AI voice workspace deliberately projects only already-recorded provider
-- calls. It is not a campaign scheduler and does not expose connection secrets
-- or permit browser-side provider calling.

create index if not exists calls_org_connection_started_ai_voice_idx
  on public.calls (organization_id, connection_id, started_at desc, id)
  where call_source = 'PROVIDER' and connection_id is not null;

create or replace function public.get_ai_voice_call_workspace(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.view') then
    raise exception using errcode = '42501', message = 'AI_VOICE_CALL_VIEW_PERMISSION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in ('ALL', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception using errcode = '22023', message = 'INVALID_AI_VOICE_CALL_STATUS_FILTER';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);

  return (
    with scoped_calls as materialized (
      select
        call_row.id,
        call_row.organization_id,
        call_row.lead_id,
        call_row.customer_id,
        call_row.started_at,
        call_row.ended_at,
        call_row.duration_seconds,
        call_row.outcome,
        call_row.status,
        connection_row.display_name as provider_name,
        case
          when app_private.has_permission(current_organization_id, 'customer.view')
            and customer_row.id is not null
            and app_private.can_access_customer(current_organization_id, customer_row.id)
            then customer_row.full_name
          when app_private.has_permission(current_organization_id, 'lead.view')
            and lead_row.id is not null
            and app_private.can_access_lead(lead_row.id)
            then lead_row.customer_name
          else null
        end as customer_name,
        case
          when app_private.has_permission(current_organization_id, 'customer.view')
            and customer_row.id is not null
            and app_private.can_access_customer(current_organization_id, customer_row.id)
            then customer_row.primary_phone
          when app_private.has_permission(current_organization_id, 'lead.view')
            and lead_row.id is not null
            and app_private.can_access_lead(lead_row.id)
            then lead_row.phone
          else null
        end as phone,
        case
          when app_private.has_permission(current_organization_id, 'customer.view')
            and customer_row.id is not null
            and app_private.can_access_customer(current_organization_id, customer_row.id)
            then app_private.normalize_phone_digits(customer_row.normalized_phone)
          when app_private.has_permission(current_organization_id, 'lead.view')
            and lead_row.id is not null
            and app_private.can_access_lead(lead_row.id)
            then app_private.normalize_phone_digits(lead_row.normalized_phone)
          else ''
        end as search_phone
      from public.calls call_row
      join public.connected_accounts connection_row
        on connection_row.organization_id = call_row.organization_id
       and connection_row.id = call_row.connection_id
       and connection_row.deleted_at is null
       and connection_row.connection_config @> '{"capabilities":["AI_VOICE_CALLING"]}'::jsonb
      left join public.leads lead_row
        on lead_row.organization_id = call_row.organization_id
       and lead_row.id = call_row.lead_id
       and lead_row.deleted_at is null
      left join public.customers customer_row
        on customer_row.organization_id = call_row.organization_id
       and customer_row.id = coalesce(call_row.customer_id, lead_row.customer_id)
       and customer_row.deleted_at is null
      where call_row.organization_id = current_organization_id
        and call_row.call_source = 'PROVIDER'
        and app_private.can_access_record(
          call_row.organization_id,
          call_row.branch_id,
          call_row.team_id,
          call_row.assigned_user_id
        )
    ), filtered_calls as materialized (
      select *
      from scoped_calls
      where (normalized_status = 'ALL' or upper(status) = normalized_status)
        and (
          normalized_search = ''
          or lower(coalesce(customer_name, '')) like '%' || normalized_search || '%'
          or lower(provider_name) like '%' || normalized_search || '%'
          or (search_phone_digits <> '' and search_phone like '%' || search_phone_digits || '%')
        )
    ), page_rows as materialized (
      select *
      from filtered_calls
      order by started_at desc, id desc
      limit target_page_size
      offset (target_page - 1) * target_page_size
    )
    select jsonb_build_object(
      'generated_at', now(),
      'records', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', page_row.id,
          'lead_id', page_row.lead_id,
          'customer_id', page_row.customer_id,
          'customer_name', page_row.customer_name,
          'phone', page_row.phone,
          'provider_name', page_row.provider_name,
          'status', page_row.status,
          'outcome', page_row.outcome,
          'started_at', page_row.started_at,
          'ended_at', page_row.ended_at,
          'duration_seconds', page_row.duration_seconds,
          'recording_available', exists (
            select 1
            from public.call_recordings recording_row
            join public.object_files file_row
              on file_row.organization_id = recording_row.organization_id
             and file_row.id = recording_row.object_file_id
             and file_row.resource_type = 'call'
             and file_row.resource_id = recording_row.call_id
             and file_row.deleted_at is null
            where recording_row.organization_id = page_row.organization_id
              and recording_row.call_id = page_row.id
          ),
          'transcript_available', exists (
            select 1 from public.call_transcripts transcript_row
            where transcript_row.organization_id = page_row.organization_id
              and transcript_row.call_id = page_row.id
              and upper(transcript_row.status) in ('READY', 'COMPLETED')
          )
        ) order by page_row.started_at desc, page_row.id desc)
        from page_rows page_row
      ), '[]'::jsonb),
      'total', (select count(*)::integer from filtered_calls),
      'kpis', jsonb_build_object(
        'initiated_today', (select count(*)::integer from scoped_calls where started_at >= date_trunc('day', now())),
        'connected_today', (select count(*)::integer from scoped_calls where started_at >= date_trunc('day', now()) and upper(coalesce(outcome, '')) = 'CONNECTED'),
        'callbacks_open', (select count(*)::integer from scoped_calls where upper(coalesce(outcome, '')) = 'CALLBACK_REQUIRED'),
        'recordings_ready_today', (select count(*)::integer from scoped_calls scoped_row where scoped_row.started_at >= date_trunc('day', now()) and exists (
          select 1 from public.call_recordings recording_row
          join public.object_files file_row
            on file_row.organization_id = recording_row.organization_id
           and file_row.id = recording_row.object_file_id
           and file_row.resource_type = 'call'
           and file_row.resource_id = recording_row.call_id
           and file_row.deleted_at is null
          where recording_row.organization_id = scoped_row.organization_id
            and recording_row.call_id = scoped_row.id
        ))
      ),
      'has_verified_provider', exists (
        select 1 from public.connected_accounts connection_row
        where connection_row.organization_id = current_organization_id
          and connection_row.deleted_at is null
          and connection_row.status = 'CONNECTED'
          and connection_row.connection_config @> '{"capabilities":["AI_VOICE_CALLING"]}'::jsonb
      )
    )
  );
end;
$$;

revoke all on function public.get_ai_voice_call_workspace(text, integer, integer, text) from public, anon;
grant execute on function public.get_ai_voice_call_workspace(text, integer, integer, text) to authenticated;
