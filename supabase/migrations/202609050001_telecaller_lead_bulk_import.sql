begin;

create table public.lead_bulk_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null,
  requested_by uuid not null,
  request_id uuid not null,
  file_name text not null,
  source_rows jsonb not null,
  status text not null default 'QUEUED',
  total_rows integer not null,
  imported_rows integer not null default 0,
  rejected_rows integer not null default 0,
  row_errors jsonb not null default '[]'::jsonb,
  trigger_run_id text,
  attempt_count integer not null default 0,
  safe_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, request_id),
  unique (organization_id, id),
  constraint lead_bulk_imports_branch_org_fk
    foreign key (organization_id, branch_id)
    references public.branches (organization_id, id),
  constraint lead_bulk_imports_requester_org_fk
    foreign key (organization_id, requested_by)
    references public.profiles (organization_id, id),
  check (status in ('QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'RETRY', 'FAILED')),
  check (jsonb_typeof(source_rows) = 'array'),
  check (jsonb_typeof(row_errors) = 'array'),
  check (attempt_count between 0 and 5),
  check (total_rows between 1 and 250),
  check (imported_rows between 0 and total_rows),
  check (rejected_rows between 0 and total_rows),
  check (imported_rows + rejected_rows <= total_rows)
);

create index lead_bulk_imports_requester_recent_idx
  on public.lead_bulk_imports (organization_id, requested_by, created_at desc, id desc);
create index lead_bulk_imports_worker_idx
  on public.lead_bulk_imports (status, created_at, id)
  where status in ('QUEUED', 'RETRY', 'PROCESSING');

alter table public.lead_bulk_imports enable row level security;
alter table public.lead_bulk_imports force row level security;
revoke insert, update, delete on public.lead_bulk_imports from anon, authenticated;
grant select on public.lead_bulk_imports to authenticated;

create policy lead_bulk_imports_requester_read
on public.lead_bulk_imports
for select
to authenticated
using (
  requested_by = auth.uid()
  and organization_id = app_private.current_tenant_organization()
);

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
values ('lead_bulk_imports', 'DELETE', 641)
on conflict (table_name) do update
set disposition = excluded.disposition,
    delete_order = excluded.delete_order;

create or replace function public.request_lead_bulk_import(
  target_organization_id uuid,
  target_branch_id uuid,
  target_file_name text,
  target_rows jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  import_row public.lead_bulk_imports%rowtype;
  source_row jsonb;
  row_number integer := 0;
  normalized_source text;
  normalized_phone text;
  normalized_email text;
  fingerprint text;
  seen_fingerprints text[] := array[]::text[];
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_organization_id <> app_private.current_tenant_organization()
    or not app_private.has_permission(target_organization_id, 'lead.create')
    or not app_private.can_access_branch(target_organization_id, target_branch_id)
  then
    raise exception using errcode = '42501', message = 'BULK_IMPORT_SCOPE_DENIED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.organization_id = assignment_row.organization_id
     and role_row.id = assignment_row.role_id
    where assignment_row.organization_id = target_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'telecaller_bdc'
  ) then
    raise exception using errcode = '42501', message = 'TELECALLER_BULK_IMPORT_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'BULK_IMPORT_REQUEST_ID_REQUIRED';
  end if;
  if nullif(btrim(coalesce(target_file_name, '')), '') is null
    or char_length(target_file_name) > 255
    or target_file_name ~ '[\\/[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'BULK_IMPORT_FILE_NAME_INVALID';
  end if;
  if jsonb_typeof(target_rows) <> 'array'
    or jsonb_array_length(target_rows) not between 1 and 250
    or pg_column_size(target_rows) > 1048576
  then
    raise exception using errcode = '22023', message = 'BULK_IMPORT_SIZE_INVALID';
  end if;

  for source_row in select value from jsonb_array_elements(target_rows)
  loop
    row_number := row_number + 1;
    if jsonb_typeof(source_row) <> 'object'
      or source_row - array[
        'customer_name', 'phone', 'email', 'source', 'source_detail', 'campaign',
        'interested_model'
      ]::text[] <> '{}'::jsonb
    then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_COLUMNS_INVALID';
    end if;

    normalized_source := btrim(coalesce(source_row->>'source', ''));
    normalized_phone := regexp_replace(coalesce(source_row->>'phone', ''), '[^0-9+]', '', 'g');
    normalized_email := lower(btrim(coalesce(source_row->>'email', '')));

    if char_length(btrim(coalesce(source_row->>'customer_name', ''))) not between 2 and 160 then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_CUSTOMER_NAME_INVALID';
    end if;
    if char_length(coalesce(source_row->>'phone', '')) > 24
      or normalized_phone !~ '^[+]?[0-9]{7,15}$'
    then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_PHONE_INVALID';
    end if;
    if normalized_email <> '' and (
      char_length(normalized_email) > 320
      or normalized_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    ) then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_EMAIL_INVALID';
    end if;
    if normalized_source not in (
      'Facebook', 'Instagram', 'Google Ads', 'Website', 'WhatsApp Business',
      'CarWale', 'CarDekho', 'Justdial', 'IndiaMART', 'Manual', 'Other'
    ) then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_SOURCE_INVALID';
    end if;
    if char_length(coalesce(source_row->>'source_detail', '')) > 200
      or char_length(coalesce(source_row->>'campaign', '')) > 200
      or char_length(coalesce(source_row->>'interested_model', '')) > 160
    then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_FIELD_TOO_LONG';
    end if;

    fingerprint := md5(concat_ws(
      chr(31),
      lower(btrim(source_row->>'customer_name')),
      normalized_phone,
      normalized_email,
      normalized_source,
      lower(btrim(coalesce(source_row->>'source_detail', ''))),
      lower(btrim(coalesce(source_row->>'campaign', ''))),
      lower(btrim(coalesce(source_row->>'interested_model', '')))
    ));
    if fingerprint = any(seen_fingerprints) then
      raise exception using errcode = '22023',
        message = 'BULK_IMPORT_ROW_' || row_number || '_DUPLICATE';
    end if;
    seen_fingerprints := array_append(seen_fingerprints, fingerprint);
  end loop;

  insert into public.lead_bulk_imports (
    organization_id, branch_id, requested_by, request_id, file_name, source_rows, total_rows
  ) values (
    target_organization_id,
    target_branch_id,
    auth.uid(),
    target_request_id,
    btrim(target_file_name),
    target_rows,
    jsonb_array_length(target_rows)
  )
  on conflict (organization_id, request_id) do update
  set updated_at = public.lead_bulk_imports.updated_at
  returning * into import_row;

  if import_row.requested_by <> auth.uid()
    or import_row.branch_id <> target_branch_id
    or import_row.source_rows <> target_rows
  then
    raise exception using errcode = '22023', message = 'BULK_IMPORT_REQUEST_ID_REUSED';
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    target_organization_id,
    auth.uid(),
    'lead.bulk_import_requested',
    'lead_bulk_import',
    import_row.id::text,
    target_branch_id,
    target_request_id,
    jsonb_build_object(
      'file_name', import_row.file_name,
      'total_rows', import_row.total_rows,
      'status', import_row.status
    )
  );

  return jsonb_build_object(
    'id', import_row.id,
    'status', import_row.status,
    'total_rows', import_row.total_rows
  );
end;
$$;

create or replace function public.mark_lead_bulk_import_enqueue_failed(
  target_import_id uuid,
  target_safe_error_code text default 'BULK_IMPORT_ENQUEUE_FAILED'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.lead_bulk_imports import_row
  set status = 'RETRY',
      safe_error_code = left(coalesce(nullif(btrim(target_safe_error_code), ''), 'BULK_IMPORT_ENQUEUE_FAILED'), 120),
      updated_at = now()
  where import_row.id = target_import_id
    and import_row.organization_id = app_private.current_tenant_organization()
    and import_row.requested_by = auth.uid()
    and import_row.status in ('QUEUED', 'RETRY');
  return found;
end;
$$;

create or replace function public.set_lead_bulk_import_trigger_run(
  target_import_id uuid,
  target_trigger_run_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.lead_bulk_imports import_row
  set trigger_run_id = left(nullif(btrim(target_trigger_run_id), ''), 200),
      status = case when import_row.status = 'RETRY' then 'QUEUED' else import_row.status end,
      safe_error_code = null,
      updated_at = now()
  where import_row.id = target_import_id
    and import_row.organization_id = app_private.current_tenant_organization()
    and import_row.requested_by = auth.uid()
    and import_row.status in ('QUEUED', 'RETRY');
  return found;
end;
$$;

create or replace function public.process_lead_bulk_import(target_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  import_row public.lead_bulk_imports%rowtype;
  source_row jsonb;
  row_number integer := 0;
  imported_count integer := 0;
  rejected_count integer := 0;
  errors jsonb := '[]'::jsonb;
  created_lead_id uuid;
  safe_code text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;

  select * into import_row
  from public.lead_bulk_imports
  where id = target_import_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_BULK_IMPORT_NOT_FOUND';
  end if;
  if import_row.status in ('COMPLETED', 'COMPLETED_WITH_ERRORS') then
    return jsonb_build_object(
      'id', import_row.id,
      'status', import_row.status,
      'imported_rows', import_row.imported_rows,
      'rejected_rows', import_row.rejected_rows,
      'replayed', true
    );
  end if;
  if import_row.status = 'FAILED' then
    raise exception using errcode = '23514', message = 'LEAD_BULK_IMPORT_FAILED';
  end if;

  update public.lead_bulk_imports
  set status = 'PROCESSING',
      attempt_count = least(attempt_count + 1, 5),
      started_at = coalesce(started_at, now()),
      safe_error_code = null,
      updated_at = now()
  where id = import_row.id;

  -- create_lead owns all business invariants. Set only the actor subject for
  -- this service-only transaction so its ordinary permissions, team routing,
  -- history and audit path execute as the requesting Telecaller.
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', import_row.requested_by, 'role', 'service_role')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', import_row.requested_by::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  for source_row in select value from jsonb_array_elements(import_row.source_rows)
  loop
    row_number := row_number + 1;
    begin
      created_lead_id := public.create_lead(
        import_row.organization_id,
        import_row.branch_id,
        null,
        source_row->>'source',
        source_row->>'customer_name',
        source_row->>'phone',
        nullif(btrim(coalesce(source_row->>'email', '')), ''),
        nullif(btrim(coalesce(source_row->>'source_detail', '')), ''),
        nullif(btrim(coalesce(source_row->>'campaign', '')), ''),
        nullif(btrim(coalesce(source_row->>'interested_model', '')), '')
      );
      imported_count := imported_count + 1;
    exception when others then
      rejected_count := rejected_count + 1;
      safe_code := case
        when sqlerrm in (
          'PERMISSION_DENIED', 'SCOPE_DENIED', 'INVALID_LEAD_SOURCE', 'INVALID_CUSTOMER_NAME',
          'INVALID_PHONE', 'INVALID_EMAIL', 'LEAD_FIELD_TOO_LONG',
          'SALES_CONSULTANT_TEAM_REQUIRED', 'ASSIGNED_LEAD_REQUIRES_TEAM',
          'LEAD_TEAM_NOT_IN_BRANCH', 'NO_ELIGIBLE_FRESH_ASSIGNEE',
          'FRESH_ASSIGNMENT_REQUIRES_TELECALLER'
        ) then sqlerrm
        else 'BULK_IMPORT_ROW_FAILED'
      end;
      if jsonb_array_length(errors) < 50 then
        errors := errors || jsonb_build_array(jsonb_build_object(
          'row_number', row_number + 1,
          'code', safe_code
        ));
      end if;
    end;
  end loop;

  update public.lead_bulk_imports
  set status = case when rejected_count = 0 then 'COMPLETED' else 'COMPLETED_WITH_ERRORS' end,
      imported_rows = imported_count,
      rejected_rows = rejected_count,
      row_errors = errors,
      completed_at = now(),
      updated_at = now()
  where id = import_row.id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    import_row.organization_id,
    import_row.requested_by,
    'lead.bulk_import_completed',
    'lead_bulk_import',
    import_row.id::text,
    import_row.branch_id,
    jsonb_build_object(
      'total_rows', import_row.total_rows,
      'imported_rows', imported_count,
      'rejected_rows', rejected_count
    )
  );

  return jsonb_build_object(
    'id', import_row.id,
    'status', case when rejected_count = 0 then 'COMPLETED' else 'COMPLETED_WITH_ERRORS' end,
    'imported_rows', imported_count,
    'rejected_rows', rejected_count,
    'replayed', false
  );
end;
$$;

create or replace function public.retry_lead_bulk_import(
  target_import_id uuid,
  target_safe_error_code text default 'BULK_IMPORT_PROCESSING_RETRY'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select attempt_count into attempts
  from public.lead_bulk_imports
  where id = target_import_id
    and status in ('QUEUED', 'PROCESSING', 'RETRY')
  for update;
  if not found then return false; end if;
  attempts := least(attempts + 1, 5);
  update public.lead_bulk_imports
  set attempt_count = attempts,
      status = case when attempts >= 5 then 'FAILED' else 'RETRY' end,
      safe_error_code = left(
        coalesce(nullif(btrim(target_safe_error_code), ''), 'BULK_IMPORT_PROCESSING_RETRY'),
        120
      ),
      completed_at = case when attempts >= 5 then now() else null end,
      updated_at = now()
  where id = target_import_id;
  return true;
end;
$$;

create or replace function public.get_lead_bulk_import(target_import_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  import_row public.lead_bulk_imports%rowtype;
begin
  select * into import_row
  from public.lead_bulk_imports
  where id = target_import_id
    and organization_id = app_private.current_tenant_organization()
    and requested_by = auth.uid();
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_BULK_IMPORT_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'id', import_row.id,
    'status', import_row.status,
    'file_name', import_row.file_name,
    'total_rows', import_row.total_rows,
    'imported_rows', import_row.imported_rows,
    'rejected_rows', import_row.rejected_rows,
    'row_errors', import_row.row_errors,
    'safe_error_code', import_row.safe_error_code,
    'created_at', import_row.created_at,
    'completed_at', import_row.completed_at
  );
end;
$$;

revoke all on function public.request_lead_bulk_import(uuid, uuid, text, jsonb, uuid)
  from public, anon;
revoke all on function public.mark_lead_bulk_import_enqueue_failed(uuid, text)
  from public, anon;
revoke all on function public.set_lead_bulk_import_trigger_run(uuid, text)
  from public, anon;
revoke all on function public.get_lead_bulk_import(uuid)
  from public, anon;
grant execute on function public.request_lead_bulk_import(uuid, uuid, text, jsonb, uuid)
  to authenticated;
grant execute on function public.mark_lead_bulk_import_enqueue_failed(uuid, text)
  to authenticated;
grant execute on function public.set_lead_bulk_import_trigger_run(uuid, text)
  to authenticated;
grant execute on function public.get_lead_bulk_import(uuid)
  to authenticated;

revoke all on function public.process_lead_bulk_import(uuid)
  from public, anon, authenticated;
revoke all on function public.retry_lead_bulk_import(uuid, text)
  from public, anon, authenticated;
grant execute on function public.process_lead_bulk_import(uuid)
  to service_role;
grant execute on function public.retry_lead_bulk_import(uuid, text)
  to service_role;

commit;
