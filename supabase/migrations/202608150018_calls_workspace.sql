begin;

-- Calls keep their own mutation permission. Reading a call is not authority to
-- alter its customer outcome, and provider synchronization remains a separate,
-- server-only adapter concern.
insert into public.permissions (permission_key, module, description) values
  ('call.update', 'calls', 'Finalize authorized manual calls with an audited outcome')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

-- Backfill the frozen role presets without broadening tenant-defined roles.
insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row
  on permission_row.permission_key = 'call.update'
where role_row.organization_id is not null
  and role_row.system_role
  and role_row.role_key in (
    'client_admin', 'system_administrator', 'sales_consultant', 'telecaller_bdc'
  )
on conflict do nothing;

create or replace function app_private.apply_default_call_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is null or not new.system_role then
    return new;
  end if;

  if new.role_key in (
    'client_admin', 'system_administrator', 'sales_consultant', 'telecaller_bdc'
  ) then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, permission_row.id
    from public.permissions permission_row
    where permission_row.permission_key = 'call.update'
    on conflict do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists roles_apply_default_call_permissions on public.roles;
create trigger roles_apply_default_call_permissions
after insert or update of role_key, system_role on public.roles
for each row execute function app_private.apply_default_call_role_permissions();

alter table public.calls
  add column version bigint not null default 1 check (version > 0),
  add column notes text,
  add column finalized_at timestamptz,
  add column finalized_by uuid references public.profiles(id),
  add column updated_at timestamptz not null default now();

-- The original NULLS NOT DISTINCT table constraint accidentally allowed only
-- one manual (connection-less) call per tenant. The hardened partial provider
-- key from migration 001 is the correct idempotency boundary.
alter table public.calls
  drop constraint if exists calls_organization_id_connection_id_provider_call_id_key;
create unique index if not exists calls_provider_external_unique_idx
  on public.calls (organization_id, connection_id, provider_call_id)
  where connection_id is not null and provider_call_id is not null;

alter table public.calls
  add constraint calls_duration_nonnegative
  check (duration_seconds is null or duration_seconds >= 0) not valid;
alter table public.calls validate constraint calls_duration_nonnegative;
alter table public.calls
  add constraint calls_time_order
  check (ended_at is null or ended_at >= started_at) not valid;
alter table public.calls validate constraint calls_time_order;
alter table public.calls
  add constraint calls_notes_size
  check (notes is null or char_length(notes) <= 4000) not valid;
alter table public.calls validate constraint calls_notes_size;

create unique index if not exists calls_org_id_unique_idx
  on public.calls (organization_id, id);
create index if not exists calls_org_status_started_page_idx
  on public.calls (organization_id, status, started_at desc, id);
create index if not exists calls_org_branch_team_started_page_idx
  on public.calls (organization_id, branch_id, team_id, started_at desc, id);
create index if not exists calls_org_assignee_started_page_idx
  on public.calls (organization_id, assigned_user_id, started_at desc, id);
create index if not exists calls_org_source_outcome_started_page_idx
  on public.calls (organization_id, call_source, outcome, started_at desc, id);
create index if not exists calls_org_outcome_started_page_idx
  on public.calls (organization_id, outcome, started_at desc, id);
create index if not exists calls_provider_call_id_trgm_idx
  on public.calls using gin (lower(provider_call_id) gin_trgm_ops)
  where provider_call_id is not null;
create index if not exists leads_customer_name_trgm_idx
  on public.leads using gin (lower(customer_name) gin_trgm_ops)
  where deleted_at is null;
create index if not exists call_recordings_org_call_created_idx
  on public.call_recordings (organization_id, call_id, created_at desc, id);
create index if not exists call_transcripts_org_call_created_idx
  on public.call_transcripts (organization_id, call_id, created_at desc, id);
create index if not exists ai_call_summaries_org_call_created_idx
  on public.ai_call_summaries (organization_id, call_id, created_at desc, id);
create unique index if not exists call_mutation_request_unique_idx
  on public.audit_logs (organization_id, actor_id, request_id)
  where request_id is not null
    and action in ('call.manual_created', 'call.manual_finalized');

-- Composite foreign keys close the cross-tenant gaps left by the original
-- single-column references. NOT VALID protects migration availability while all
-- new writes are still checked immediately.
alter table public.calls
  add constraint calls_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.calls
  add constraint calls_team_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.calls
  add constraint calls_lead_org_fk foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.calls
  add constraint calls_customer_org_fk foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.calls
  add constraint calls_assignee_org_fk foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.calls
  add constraint calls_finalizer_org_fk foreign key (organization_id, finalized_by)
  references public.profiles (organization_id, id) not valid;
alter table public.call_recordings
  add constraint call_recordings_call_org_fk foreign key (organization_id, call_id)
  references public.calls (organization_id, id) not valid;
alter table public.call_transcripts
  add constraint call_transcripts_call_org_fk foreign key (organization_id, call_id)
  references public.calls (organization_id, id) not valid;
alter table public.ai_call_summaries
  add constraint ai_call_summaries_call_org_fk foreign key (organization_id, call_id)
  references public.calls (organization_id, id) not valid;
alter table public.call_recordings
  add constraint call_recordings_object_org_fk foreign key (organization_id, object_file_id)
  references public.object_files (organization_id, id) not valid;

create or replace function app_private.validate_call_recording_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.object_file_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.object_files file_row
    where file_row.id = new.object_file_id
      and file_row.organization_id = new.organization_id
      and file_row.resource_type = 'call'
      and file_row.resource_id = new.call_id
      and file_row.deleted_at is null
      and lower(file_row.mime_type) in (
        'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'
      )
  ) then
    raise exception using errcode = '23514', message = 'CALL_RECORDING_OBJECT_INVALID';
  end if;

  return new;
end;
$$;

drop trigger if exists call_recordings_validate_object on public.call_recordings;
create trigger call_recordings_validate_object
before insert or update of object_file_id, organization_id, call_id on public.call_recordings
for each row execute function app_private.validate_call_recording_object();

-- Reuse the private tenant communications topic for child-state changes that do
-- not update the parent call row (recording ingest, transcript, and AI summary).
drop trigger if exists realtime_call_recordings_invalidate on public.call_recordings;
create trigger realtime_call_recordings_invalidate
after insert or update on public.call_recordings
for each row execute function app_private.broadcast_tenant_invalidation('communications');
drop trigger if exists realtime_call_transcripts_invalidate on public.call_transcripts;
create trigger realtime_call_transcripts_invalidate
after insert or update on public.call_transcripts
for each row execute function app_private.broadcast_tenant_invalidation('communications');
drop trigger if exists realtime_ai_call_summaries_invalidate on public.ai_call_summaries;
create trigger realtime_ai_call_summaries_invalidate
after insert or update on public.ai_call_summaries
for each row execute function app_private.broadcast_tenant_invalidation('communications');

-- Reads inherit the exact parent call scope. Browser writes stay RPC-only.
drop policy if exists calls_read on public.calls;
create policy calls_read on public.calls
for select to authenticated using (
  app_private.can_access_call(organization_id, id)
);
drop policy if exists call_recordings_read on public.call_recordings;
create policy call_recordings_read on public.call_recordings
for select to authenticated using (
  app_private.can_access_call(organization_id, call_id)
);
drop policy if exists call_transcripts_read on public.call_transcripts;
create policy call_transcripts_read on public.call_transcripts
for select to authenticated using (
  app_private.can_access_call(organization_id, call_id)
);
drop policy if exists ai_call_summaries_read on public.ai_call_summaries;
create policy ai_call_summaries_read on public.ai_call_summaries
for select to authenticated using (
  app_private.can_access_call(organization_id, call_id)
);

revoke insert, update, delete on public.calls from anon, authenticated;
revoke insert, update, delete on public.call_recordings from anon, authenticated;
revoke insert, update, delete on public.call_transcripts from anon, authenticated;
revoke insert, update, delete on public.ai_call_summaries from anon, authenticated;

create or replace function app_private.call_request_fingerprint(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(coalesce(payload, '{}'::jsonb)::text, 'UTF8')),
    'hex'
  );
$$;

create or replace function public.get_call_workspace_page(
  target_search text default '',
  target_page integer default 1,
  target_page_size integer default 25,
  target_status text default 'ALL',
  target_outcome text default 'ALL',
  target_source text default 'ALL',
  target_sort text default 'started:desc'
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
  search_uuid uuid;
  normalized_status text := upper(btrim(coalesce(target_status, 'ALL')));
  normalized_outcome text := upper(btrim(coalesce(target_outcome, 'ALL')));
  normalized_source text := upper(btrim(coalesce(target_source, 'ALL')));
  customer_access boolean;
  lead_access boolean;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;
  if normalized_status not in ('ALL', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_STATUS_FILTER';
  end if;
  if normalized_outcome not in (
    'ALL', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF',
    'CALLBACK_REQUIRED', 'WRONG_NUMBER', 'OTHER'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CALL_OUTCOME_FILTER';
  end if;
  if normalized_source not in ('ALL', 'PROVIDER', 'PERSONAL_MANUAL') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_SOURCE_FILTER';
  end if;
  if target_sort not in (
    'started:desc', 'started:asc', 'duration:desc', 'duration:asc',
    'customer:asc', 'customer:desc'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CALL_SORT';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.view')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  customer_access := app_private.has_permission(current_organization_id, 'customer.view');
  lead_access := app_private.has_permission(current_organization_id, 'lead.view');

  -- Keep the scope/KPI set narrow. Expensive caller, provider, recording,
  -- transcript, and AI enrichment happens only after the requested page has
  -- been selected.
  with scoped_calls as materialized (
    select
      call_row.id,
      call_row.organization_id,
      call_row.branch_id,
      call_row.team_id,
      call_row.assigned_user_id,
      call_row.connection_id,
      case
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) then lead_row.id
        else null
      end as lead_id,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then customer_row.id
        else null
      end as customer_id,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then customer_row.full_name
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) then lead_row.customer_name
        else null
      end as customer_name,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then customer_row.primary_phone
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) then lead_row.phone
        else null
      end as phone,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then app_private.normalize_phone_digits(customer_row.normalized_phone)
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id)
          then app_private.normalize_phone_digits(lead_row.normalized_phone)
        else ''
      end as search_phone,
      call_row.provider_call_id,
      call_row.direction,
      call_row.call_source,
      call_row.started_at,
      call_row.ended_at,
      call_row.duration_seconds,
      call_row.outcome,
      call_row.status,
      call_row.version,
      call_row.updated_at
    from public.calls call_row
    left join public.leads lead_row
      on lead_row.organization_id = call_row.organization_id
     and lead_row.id = call_row.lead_id
     and lead_row.deleted_at is null
    left join public.customers customer_row
      on customer_row.organization_id = call_row.organization_id
     and customer_row.id = coalesce(call_row.customer_id, lead_row.customer_id)
     and customer_row.deleted_at is null
    where call_row.organization_id = current_organization_id
      and app_private.can_access_record(
        call_row.organization_id,
        call_row.branch_id,
        call_row.team_id,
        call_row.assigned_user_id
      )
  ), filtered_calls as materialized (
    select scoped_row.*
    from scoped_calls scoped_row
    where (normalized_status = 'ALL' or upper(scoped_row.status) = normalized_status)
      and (normalized_outcome = 'ALL' or upper(scoped_row.outcome) = normalized_outcome)
      and (normalized_source = 'ALL' or upper(scoped_row.call_source) = normalized_source)
      and (
        normalized_search = ''
        or scoped_row.id = search_uuid
        or lower(coalesce(scoped_row.customer_name, '')) like '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and scoped_row.search_phone like '%' || search_phone_digits || '%'
        )
        or lower(coalesce(scoped_row.provider_call_id, '')) like '%' || normalized_search || '%'
      )
  ), page_base as materialized (
    select *
    from filtered_calls
    order by
      case when target_sort = 'started:desc' then started_at end desc,
      case when target_sort = 'started:asc' then started_at end asc,
      case when target_sort = 'duration:desc' then duration_seconds end desc nulls last,
      case when target_sort = 'duration:asc' then duration_seconds end asc nulls last,
      case when target_sort = 'customer:asc' then lower(customer_name) end asc nulls last,
      case when target_sort = 'customer:desc' then lower(customer_name) end desc nulls last,
      id asc
    limit target_page_size
    offset (target_page - 1) * target_page_size
  ), page_rows as (
    select
      page_row.*,
      branch_row.name as branch_name,
      team_row.name as team_name,
      profile_row.full_name as caller_name,
      caller_role.role_name as caller_role,
      connection_row.display_name as provider_name,
      recording_row.status as recording_status,
      recording_row.object_file_id,
      transcript_row.status as transcript_status,
      summary_row.has_summary
    from page_base page_row
    join public.branches branch_row
      on branch_row.organization_id = page_row.organization_id
     and branch_row.id = page_row.branch_id
    left join public.teams team_row
      on team_row.organization_id = page_row.organization_id
     and team_row.branch_id = page_row.branch_id
     and team_row.id = page_row.team_id
    join public.profiles profile_row
      on profile_row.organization_id = page_row.organization_id
     and profile_row.id = page_row.assigned_user_id
    left join public.connected_accounts connection_row
      on connection_row.organization_id = page_row.organization_id
     and connection_row.id = page_row.connection_id
     and connection_row.deleted_at is null
    left join lateral (
      select role_row.name as role_name
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.organization_id = assignment_row.organization_id
       and role_row.id = assignment_row.role_id
      where assignment_row.organization_id = page_row.organization_id
        and assignment_row.user_id = page_row.assigned_user_id
        and assignment_row.active
      order by role_row.authority_level desc, role_row.id
      limit 1
    ) caller_role on true
    left join lateral (
      select
        recording_source.status,
        case
          when file_row.id is not null then recording_source.object_file_id
          else null
        end as object_file_id
      from public.call_recordings recording_source
      left join public.object_files file_row
        on file_row.organization_id = recording_source.organization_id
       and file_row.id = recording_source.object_file_id
       and file_row.resource_type = 'call'
       and file_row.resource_id = recording_source.call_id
       and file_row.deleted_at is null
      where recording_source.organization_id = page_row.organization_id
        and recording_source.call_id = page_row.id
      order by recording_source.created_at desc, recording_source.id
      limit 1
    ) recording_row on true
    left join lateral (
      select transcript_source.status
      from public.call_transcripts transcript_source
      where transcript_source.organization_id = page_row.organization_id
        and transcript_source.call_id = page_row.id
      order by transcript_source.created_at desc, transcript_source.id
      limit 1
    ) transcript_row on true
    left join lateral (
      select true as has_summary
      from public.ai_call_summaries summary_source
      where summary_source.organization_id = page_row.organization_id
        and summary_source.call_id = page_row.id
      order by summary_source.created_at desc, summary_source.id
      limit 1
    ) summary_row on true
  ), trend_rows as (
    select
      day_source.day::date as day,
      count(scoped_row.id)::integer as total,
      count(scoped_row.id) filter (
        where upper(coalesce(scoped_row.outcome, '')) = 'CONNECTED'
      )::integer as connected
    from pg_catalog.generate_series(
      current_date - 6,
      current_date,
      interval '1 day'
    ) day_source(day)
    left join scoped_calls scoped_row
      on scoped_row.started_at >= day_source.day
     and scoped_row.started_at < day_source.day + interval '1 day'
    group by day_source.day
    order by day_source.day
  )
  select jsonb_build_object(
    'records', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'organization_id', page_row.organization_id,
            'branch_id', page_row.branch_id,
            'team_id', page_row.team_id,
            'lead_id', page_row.lead_id,
            'customer_id', page_row.customer_id,
            'customer_name', page_row.customer_name,
            'phone', page_row.phone,
            'branch_name', page_row.branch_name,
            'team_name', page_row.team_name,
            'caller_name', page_row.caller_name,
            'caller_role', page_row.caller_role,
            'provider_name', page_row.provider_name,
            'provider_call_id', page_row.provider_call_id,
            'direction', page_row.direction,
            'call_source', page_row.call_source,
            'started_at', page_row.started_at,
            'ended_at', page_row.ended_at,
            'duration_seconds', page_row.duration_seconds,
            'outcome', page_row.outcome,
            'status', page_row.status,
            'recording_status', page_row.recording_status,
            'recording_available', page_row.object_file_id is not null,
            'transcript_status', page_row.transcript_status,
            'ai_summary_available', coalesce(page_row.has_summary, false),
            'version', page_row.version,
            'updated_at', page_row.updated_at
          ) order by
            case when target_sort = 'started:desc' then page_row.started_at end desc,
            case when target_sort = 'started:asc' then page_row.started_at end asc,
            case when target_sort = 'duration:desc' then page_row.duration_seconds end desc nulls last,
            case when target_sort = 'duration:asc' then page_row.duration_seconds end asc nulls last,
            case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc nulls last,
            case when target_sort = 'customer:desc' then lower(page_row.customer_name) end desc nulls last,
            page_row.id asc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    'total', (select count(*) from filtered_calls),
    'kpis', jsonb_build_object(
      'total_today', (
        select count(*) from scoped_calls
        where started_at >= date_trunc('day', now())
      ),
      'connected_today', (
        select count(*) from scoped_calls
        where started_at >= date_trunc('day', now())
          and upper(coalesce(outcome, '')) = 'CONNECTED'
      ),
      'connection_rate', (
        select case when count(*) = 0 then 0
          else round(
            100.0 * count(*) filter (where upper(coalesce(outcome, '')) = 'CONNECTED')
            / count(*),
            1
          )
        end
        from scoped_calls
        where started_at >= date_trunc('day', now())
      ),
      'average_duration_seconds', (
        select coalesce(round(avg(duration_seconds)), 0)
        from scoped_calls
        where started_at >= date_trunc('day', now())
          and duration_seconds is not null
      ),
      'callbacks_required', (
        select count(*) from scoped_calls
        where upper(coalesce(outcome, '')) = 'CALLBACK_REQUIRED'
      ),
      'recordings_ready', (
        select count(*)
        from scoped_calls scoped_row
        where scoped_row.started_at >= date_trunc('day', now())
          and exists (
            select 1
            from public.call_recordings recording_row
            join public.object_files file_row
              on file_row.organization_id = recording_row.organization_id
             and file_row.id = recording_row.object_file_id
             and file_row.resource_type = 'call'
             and file_row.resource_id = recording_row.call_id
             and file_row.deleted_at is null
            where recording_row.organization_id = scoped_row.organization_id
              and recording_row.call_id = scoped_row.id
          )
      )
    ),
    'trend', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'name', to_char(trend_row.day, 'DD Mon'),
            'value', trend_row.total,
            'secondary', trend_row.connected
          ) order by trend_row.day
        )
        from trend_rows trend_row
      ),
      '[]'::jsonb
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_call_workspace_page(text, integer, integer, text, text, text, text)
  from public, anon;
grant execute on function public.get_call_workspace_page(text, integer, integer, text, text, text, text)
  to authenticated;

create or replace function public.get_call_party_options(
  target_search text default '',
  target_limit integer default 25
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
  search_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_OPTION_LIMIT';
  end if;
  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'SEARCH_TOO_LONG';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'call.create')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  with accessible_leads as materialized (
    select
      lead_row.id as lead_id,
      lead_row.customer_id,
      lead_row.branch_id,
      lead_row.team_id,
      coalesce(customer_row.full_name, lead_row.customer_name) as customer_name,
      coalesce(customer_row.primary_phone, lead_row.phone) as phone,
      app_private.normalize_phone_digits(
        coalesce(customer_row.normalized_phone, lead_row.normalized_phone)
      ) as search_phone,
      lead_row.lifecycle_status::text as context_label,
      lead_row.updated_at as last_activity_at
    from public.leads lead_row
    left join public.customers customer_row
      on customer_row.organization_id = lead_row.organization_id
     and customer_row.id = lead_row.customer_id
     and customer_row.deleted_at is null
     and app_private.has_permission(lead_row.organization_id, 'customer.view')
     and app_private.can_access_customer(lead_row.organization_id, customer_row.id)
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and app_private.has_permission(lead_row.organization_id, 'lead.view')
      and app_private.can_access_record(
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.assigned_user_id
      )
      and (
        normalized_search = ''
        or lead_row.id = search_uuid
        or lead_row.customer_id = search_uuid
        or lower(coalesce(customer_row.full_name, lead_row.customer_name))
          like '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(
            coalesce(customer_row.normalized_phone, lead_row.normalized_phone)
          ) like '%' || search_phone_digits || '%'
        )
      )
  ), customer_only as materialized (
    select
      null::uuid as lead_id,
      customer_row.id as customer_id,
      null::uuid as branch_id,
      null::uuid as team_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      app_private.normalize_phone_digits(customer_row.normalized_phone) as search_phone,
      'Customer only'::text as context_label,
      customer_row.updated_at as last_activity_at
    from public.customers customer_row
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and app_private.has_permission(customer_row.organization_id, 'customer.view')
      and app_private.can_access_customer(customer_row.organization_id, customer_row.id)
      and not exists (
        select 1
        from accessible_leads lead_row
        where lead_row.customer_id = customer_row.id
      )
      and (
        normalized_search = ''
        or customer_row.id = search_uuid
        or customer_row.normalized_name like '%' || normalized_search || '%'
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone)
            like '%' || search_phone_digits || '%'
        )
      )
  ), candidates as (
    select * from accessible_leads
    union all
    select * from customer_only
  ), option_rows as (
    select *
    from candidates
    order by last_activity_at desc, coalesce(lead_id, customer_id)
    limit target_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', case
          when option_row.lead_id is not null then 'LEAD:' || option_row.lead_id::text
          else 'CUSTOMER:' || option_row.customer_id::text
        end,
        'lead_id', option_row.lead_id,
        'customer_id', option_row.customer_id,
        'branch_id', option_row.branch_id,
        'team_id', option_row.team_id,
        'customer_name', option_row.customer_name,
        'phone', option_row.phone,
        'context_label', option_row.context_label
      ) order by option_row.last_activity_at desc, coalesce(option_row.lead_id, option_row.customer_id)
    ),
    '[]'::jsonb
  ) into result
  from option_rows option_row;

  return result;
end;
$$;

revoke all on function public.get_call_party_options(text, integer) from public, anon;
grant execute on function public.get_call_party_options(text, integer) to authenticated;

create or replace function public.get_call_detail(target_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  call_record public.calls%rowtype;
  customer_access boolean;
  lead_access boolean;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_call_id is null then
    raise exception using errcode = '22023', message = 'CALL_ID_REQUIRED';
  end if;

  select * into call_record
  from public.calls call_row
  where call_row.id = target_call_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if not app_private.has_permission(call_record.organization_id, 'call.view')
    or not app_private.can_access_record(
      call_record.organization_id,
      call_record.branch_id,
      call_record.team_id,
      call_record.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  customer_access := app_private.has_permission(call_record.organization_id, 'customer.view');
  lead_access := app_private.has_permission(call_record.organization_id, 'lead.view');

  select jsonb_build_object(
    'id', call_record.id,
    'organization_id', call_record.organization_id,
    'branch_id', call_record.branch_id,
    'team_id', call_record.team_id,
    'lead_id', case
      when lead_access and call_record.lead_id is not null
        and app_private.can_access_lead(call_record.lead_id) then call_record.lead_id
      else null
    end,
    'customer_id', case
      when customer_access and customer_row.id is not null
        and app_private.can_access_customer(call_record.organization_id, customer_row.id)
        then customer_row.id
      else null
    end,
    'customer_name', case
      when customer_access and customer_row.id is not null
        and app_private.can_access_customer(call_record.organization_id, customer_row.id)
        then customer_row.full_name
      when lead_access and lead_row.id is not null
        and app_private.can_access_lead(lead_row.id) then lead_row.customer_name
      else null
    end,
    'phone', case
      when customer_access and customer_row.id is not null
        and app_private.can_access_customer(call_record.organization_id, customer_row.id)
        then customer_row.primary_phone
      when lead_access and lead_row.id is not null
        and app_private.can_access_lead(lead_row.id) then lead_row.phone
      else null
    end,
    'branch_name', branch_row.name,
    'team_name', team_row.name,
    'caller_name', caller_row.full_name,
    'provider_name', connection_row.display_name,
    'provider_call_id', call_record.provider_call_id,
    'direction', call_record.direction,
    'call_source', call_record.call_source,
    'started_at', call_record.started_at,
    'ended_at', call_record.ended_at,
    'duration_seconds', call_record.duration_seconds,
    'outcome', call_record.outcome,
    'status', call_record.status,
    'notes', call_record.notes,
    'version', call_record.version,
    'updated_at', call_record.updated_at,
    'finalized_at', call_record.finalized_at,
    'can_finalize', call_record.call_source = 'PERSONAL_MANUAL'
      and upper(call_record.status) = 'PENDING'
      and app_private.has_permission(call_record.organization_id, 'call.update'),
    'recordings', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', recording_row.id,
            'source', recording_row.source,
            'status', recording_row.status,
            'object_file_id', file_row.id,
            'mime_type', file_row.mime_type,
            'size_bytes', file_row.size_bytes,
            'created_at', recording_row.created_at
          ) order by recording_row.created_at desc, recording_row.id
        )
        from public.call_recordings recording_row
        left join public.object_files file_row
          on file_row.organization_id = recording_row.organization_id
         and file_row.id = recording_row.object_file_id
         and file_row.resource_type = 'call'
         and file_row.resource_id = recording_row.call_id
         and file_row.deleted_at is null
        where recording_row.organization_id = call_record.organization_id
          and recording_row.call_id = call_record.id
      ),
      '[]'::jsonb
    ),
    'transcript', (
      select jsonb_build_object(
        'id', transcript_row.id,
        'status', transcript_row.status,
        'language', transcript_row.language,
        'text', left(transcript_row.transcript_text, 100000),
        'truncated', char_length(coalesce(transcript_row.transcript_text, '')) > 100000,
        'created_at', transcript_row.created_at
      )
      from public.call_transcripts transcript_row
      where transcript_row.organization_id = call_record.organization_id
        and transcript_row.call_id = call_record.id
      order by transcript_row.created_at desc, transcript_row.id
      limit 1
    ),
    'ai_summary', (
      select jsonb_build_object(
        'id', summary_row.id,
        'summary', left(summary_row.summary, 20000),
        'created_at', summary_row.created_at
      )
      from public.ai_call_summaries summary_row
      where summary_row.organization_id = call_record.organization_id
        and summary_row.call_id = call_record.id
      order by summary_row.created_at desc, summary_row.id
      limit 1
    )
  ) into result
  from public.branches branch_row
  left join public.teams team_row
    on team_row.organization_id = call_record.organization_id
   and team_row.branch_id = call_record.branch_id
   and team_row.id = call_record.team_id
  join public.profiles caller_row
    on caller_row.organization_id = call_record.organization_id
   and caller_row.id = call_record.assigned_user_id
  left join public.leads lead_row
    on lead_row.organization_id = call_record.organization_id
   and lead_row.id = call_record.lead_id
   and lead_row.deleted_at is null
  left join public.customers customer_row
    on customer_row.organization_id = call_record.organization_id
   and customer_row.id = coalesce(call_record.customer_id, lead_row.customer_id)
   and customer_row.deleted_at is null
  left join public.connected_accounts connection_row
    on connection_row.organization_id = call_record.organization_id
   and connection_row.id = call_record.connection_id
   and connection_row.deleted_at is null
  where branch_row.organization_id = call_record.organization_id
    and branch_row.id = call_record.branch_id;

  return result;
end;
$$;

revoke all on function public.get_call_detail(uuid) from public, anon;
grant execute on function public.get_call_detail(uuid) to authenticated;

create or replace function public.create_manual_call(
  target_organization_id uuid,
  target_branch_id uuid,
  target_team_id uuid,
  target_lead_id uuid,
  target_customer_id uuid,
  target_direction text,
  target_started_at timestamptz,
  target_notes text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_organization_id uuid;
  lead_record public.leads%rowtype;
  effective_branch_id uuid := target_branch_id;
  effective_team_id uuid := target_team_id;
  effective_customer_id uuid := target_customer_id;
  normalized_direction text := upper(btrim(coalesce(target_direction, '')));
  normalized_notes text := nullif(btrim(coalesce(target_notes, '')), '');
  fingerprint text;
  previous_action text;
  previous_metadata jsonb;
  created_call public.calls%rowtype;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if target_organization_id is null or target_started_at is null then
    raise exception using errcode = '22023', message = 'REQUIRED_CALL_FIELD_MISSING';
  end if;
  if normalized_direction not in ('INBOUND', 'OUTBOUND') then
    raise exception using errcode = '22023', message = 'INVALID_CALL_DIRECTION';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 4000 then
    raise exception using errcode = '22023', message = 'CALL_NOTES_TOO_LONG';
  end if;
  if target_started_at > now() + interval '5 minutes'
    or target_started_at < now() - interval '366 days'
  then
    raise exception using errcode = '22023', message = 'CALL_START_TIME_OUT_OF_RANGE';
  end if;
  if target_lead_id is null and target_customer_id is null then
    raise exception using errcode = '22023', message = 'CALL_PARTY_REQUIRED';
  end if;

  select profile_row.organization_id into actor_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.active
    and profile_row.deleted_at is null;
  if actor_organization_id is null
    or actor_organization_id <> target_organization_id
    or not app_private.has_permission(target_organization_id, 'call.create')
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  if target_lead_id is not null then
    select * into lead_record
    from public.leads lead_row
    where lead_row.id = target_lead_id
      and lead_row.organization_id = target_organization_id
      and lead_row.deleted_at is null;
    if not found
      or not app_private.has_permission(target_organization_id, 'lead.view')
      or not app_private.can_access_record(
        lead_record.organization_id,
        lead_record.branch_id,
        lead_record.team_id,
        lead_record.assigned_user_id
      )
    then
      raise exception using errcode = '42501', message = 'CALL_LEAD_NOT_AUTHORIZED';
    end if;

    if target_branch_id is not null and target_branch_id <> lead_record.branch_id then
      raise exception using errcode = '22023', message = 'CALL_BRANCH_DOES_NOT_MATCH_LEAD';
    end if;
    if target_team_id is distinct from lead_record.team_id then
      raise exception using errcode = '22023', message = 'CALL_TEAM_DOES_NOT_MATCH_LEAD';
    end if;
    if target_customer_id is not null
      and lead_record.customer_id is not null
      and target_customer_id <> lead_record.customer_id
    then
      raise exception using errcode = '22023', message = 'CALL_CUSTOMER_DOES_NOT_MATCH_LEAD';
    end if;

    effective_branch_id := lead_record.branch_id;
    effective_team_id := lead_record.team_id;
    effective_customer_id := coalesce(target_customer_id, lead_record.customer_id);
  end if;

  if effective_branch_id is null
    or not exists (
      select 1 from public.branches branch_row
      where branch_row.organization_id = target_organization_id
        and branch_row.id = effective_branch_id
        and branch_row.active
        and branch_row.deleted_at is null
    )
  then
    raise exception using errcode = '22023', message = 'CALL_BRANCH_INVALID';
  end if;
  if effective_team_id is not null
    and not exists (
      select 1 from public.teams team_row
      where team_row.organization_id = target_organization_id
        and team_row.branch_id = effective_branch_id
        and team_row.id = effective_team_id
        and team_row.active
    )
  then
    raise exception using errcode = '22023', message = 'CALL_TEAM_INVALID';
  end if;
  if not app_private.can_access_record(
    target_organization_id,
    effective_branch_id,
    effective_team_id,
    auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'CALL_SCOPE_DENIED';
  end if;

  if effective_customer_id is not null
    and (
      not app_private.has_permission(target_organization_id, 'customer.view')
      or not exists (
        select 1 from public.customers customer_row
        where customer_row.organization_id = target_organization_id
          and customer_row.id = effective_customer_id
          and customer_row.deleted_at is null
      )
      or not app_private.can_access_customer(target_organization_id, effective_customer_id)
    )
  then
    raise exception using errcode = '42501', message = 'CALL_CUSTOMER_NOT_AUTHORIZED';
  end if;

  fingerprint := app_private.call_request_fingerprint(jsonb_build_object(
    'organization_id', target_organization_id,
    'branch_id', effective_branch_id,
    'team_id', effective_team_id,
    'lead_id', target_lead_id,
    'customer_id', effective_customer_id,
    'direction', normalized_direction,
    'started_at', target_started_at,
    'notes', normalized_notes
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      target_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
      0
    )
  );

  select audit_row.action, audit_row.metadata
    into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id;
  if previous_action is not null then
    if previous_action <> 'call.manual_created'
      or previous_metadata->>'fingerprint' is distinct from fingerprint
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  insert into public.calls (
    organization_id,
    branch_id,
    team_id,
    lead_id,
    customer_id,
    assigned_user_id,
    connection_id,
    provider_call_id,
    direction,
    call_source,
    started_at,
    outcome,
    status,
    notes
  ) values (
    target_organization_id,
    effective_branch_id,
    effective_team_id,
    target_lead_id,
    effective_customer_id,
    auth.uid(),
    null,
    null,
    normalized_direction,
    'PERSONAL_MANUAL',
    target_started_at,
    null,
    'PENDING',
    normalized_notes
  ) returning * into created_call;

  result := jsonb_build_object(
    'call_id', created_call.id,
    'version', created_call.version,
    'status', created_call.status,
    'replayed', false
  );

  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    branch_id,
    request_id,
    metadata
  ) values (
    target_organization_id,
    auth.uid(),
    'call.manual_created',
    'call',
    created_call.id::text,
    effective_branch_id,
    target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );

  insert into public.activities (
    organization_id,
    customer_id,
    lead_id,
    activity_type,
    actor_id,
    metadata,
    occurred_at
  ) values (
    target_organization_id,
    effective_customer_id,
    target_lead_id,
    'CALL_LOGGED',
    auth.uid(),
    jsonb_build_object(
      'call_id', created_call.id,
      'direction', normalized_direction,
      'call_source', 'PERSONAL_MANUAL'
    ),
    target_started_at
  );

  return result;
end;
$$;

revoke all on function public.create_manual_call(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.create_manual_call(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, uuid)
  to authenticated;

create or replace function public.finalize_manual_call(
  target_call_id uuid,
  expected_version bigint,
  target_ended_at timestamptz,
  target_outcome text,
  target_notes text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_record public.calls%rowtype;
  normalized_outcome text := upper(btrim(coalesce(target_outcome, '')));
  normalized_notes text := nullif(btrim(coalesce(target_notes, '')), '');
  calculated_duration integer;
  fingerprint text;
  previous_action text;
  previous_metadata jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_call_id is null or target_ended_at is null or target_request_id is null then
    raise exception using errcode = '22023', message = 'REQUIRED_CALL_FINALIZATION_FIELD_MISSING';
  end if;
  if expected_version is null or expected_version < 1 then
    raise exception using errcode = '22023', message = 'INVALID_EXPECTED_CALL_VERSION';
  end if;
  if normalized_outcome not in (
    'CONNECTED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF',
    'CALLBACK_REQUIRED', 'WRONG_NUMBER', 'OTHER'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CALL_OUTCOME';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 4000 then
    raise exception using errcode = '22023', message = 'CALL_NOTES_TOO_LONG';
  end if;

  select * into call_record
  from public.calls call_row
  where call_row.id = target_call_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CALL_NOT_FOUND';
  end if;
  if not app_private.has_permission(call_record.organization_id, 'call.update')
    or not app_private.can_access_record(
      call_record.organization_id,
      call_record.branch_id,
      call_record.team_id,
      call_record.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if call_record.call_source <> 'PERSONAL_MANUAL' then
    raise exception using errcode = '42501', message = 'PROVIDER_CALL_MUTATION_DENIED';
  end if;

  fingerprint := app_private.call_request_fingerprint(jsonb_build_object(
    'call_id', target_call_id,
    'expected_version', expected_version,
    'ended_at', target_ended_at,
    'outcome', normalized_outcome,
    'notes', normalized_notes
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      call_record.organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text,
      0
    )
  );

  select audit_row.action, audit_row.metadata
    into previous_action, previous_metadata
  from public.audit_logs audit_row
  where audit_row.organization_id = call_record.organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id;
  if previous_action is not null then
    if previous_action <> 'call.manual_finalized'
      or previous_metadata->>'fingerprint' is distinct from fingerprint
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return coalesce(previous_metadata->'result', '{}'::jsonb)
      || jsonb_build_object('replayed', true);
  end if;

  if call_record.version <> expected_version then
    raise exception using errcode = '40001', message = 'CALL_VERSION_CONFLICT';
  end if;
  if upper(call_record.status) <> 'PENDING' then
    raise exception using errcode = '22023', message = 'CALL_ALREADY_FINALIZED';
  end if;
  if target_ended_at < call_record.started_at
    or target_ended_at > now() + interval '5 minutes'
    or target_ended_at > call_record.started_at + interval '24 hours'
  then
    raise exception using errcode = '22023', message = 'CALL_END_TIME_OUT_OF_RANGE';
  end if;
  calculated_duration := floor(extract(epoch from target_ended_at - call_record.started_at))::integer;

  update public.calls call_row
  set ended_at = target_ended_at,
      duration_seconds = calculated_duration,
      outcome = normalized_outcome,
      status = 'COMPLETED',
      notes = coalesce(normalized_notes, call_row.notes),
      finalized_at = now(),
      finalized_by = auth.uid(),
      version = call_row.version + 1,
      updated_at = now()
  where call_row.id = target_call_id
    and call_row.organization_id = call_record.organization_id
    and call_row.version = expected_version
  returning * into call_record;
  if not found then
    raise exception using errcode = '40001', message = 'CALL_VERSION_CONFLICT';
  end if;

  result := jsonb_build_object(
    'call_id', call_record.id,
    'version', call_record.version,
    'status', call_record.status,
    'outcome', call_record.outcome,
    'duration_seconds', call_record.duration_seconds,
    'replayed', false
  );

  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    branch_id,
    request_id,
    metadata
  ) values (
    call_record.organization_id,
    auth.uid(),
    'call.manual_finalized',
    'call',
    call_record.id::text,
    call_record.branch_id,
    target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );

  insert into public.activities (
    organization_id,
    customer_id,
    lead_id,
    activity_type,
    actor_id,
    metadata,
    occurred_at
  ) values (
    call_record.organization_id,
    call_record.customer_id,
    call_record.lead_id,
    'CALL_FINALIZED',
    auth.uid(),
    jsonb_build_object(
      'call_id', call_record.id,
      'outcome', call_record.outcome,
      'duration_seconds', call_record.duration_seconds
    ),
    target_ended_at
  );

  return result;
end;
$$;

revoke all on function public.finalize_manual_call(uuid, bigint, timestamptz, text, text, uuid)
  from public, anon;
grant execute on function public.finalize_manual_call(uuid, bigint, timestamptz, text, text, uuid)
  to authenticated;

commit;
