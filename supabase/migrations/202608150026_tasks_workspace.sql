begin;

insert into public.permissions (permission_key, module, description) values
  ('task.view', 'appointments', 'View tasks within authorized data scope'),
  ('task.create', 'appointments', 'Create lead-linked tasks within authorized data scope'),
  ('task.update', 'appointments', 'Update open tasks within authorized data scope'),
  ('task.complete', 'appointments', 'Complete authorized tasks'),
  ('task.cancel', 'appointments', 'Cancel authorized tasks'),
  ('task.assign', 'appointments', 'Assign tasks within authorized data scope')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row on (
  role_row.organization_id is not null
  and role_row.system_role
  and (
    role_row.role_key in ('client_admin', 'system_administrator')
    or (
      role_row.role_key in ('telecaller_bdc', 'sales_consultant')
      and permission_row.permission_key in (
        'task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel'
      )
    )
    or (
      role_row.role_key in ('team_manager', 'showroom_manager')
      and permission_row.permission_key in (
        'task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel', 'task.assign'
      )
    )
  )
)
where permission_row.permission_key like 'task.%'
on conflict do nothing;

alter table public.tasks
  add column if not exists lead_id uuid,
  add column if not exists customer_id uuid,
  add column if not exists version bigint not null default 1,
  add column if not exists completed_at timestamptz,
  add column if not exists completion_note text,
  add column if not exists updated_by uuid,
  add column if not exists deleted_at timestamptz;

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks
  add constraint tasks_status_check
  check (status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')) not valid;
alter table public.tasks drop constraint if exists tasks_title_check;
alter table public.tasks
  add constraint tasks_title_check
  check (char_length(btrim(title)) between 1 and 160) not valid;
alter table public.tasks drop constraint if exists tasks_description_check;
alter table public.tasks
  add constraint tasks_description_check
  check (description is null or char_length(description) <= 2000) not valid;
alter table public.tasks drop constraint if exists tasks_completion_check;
alter table public.tasks
  add constraint tasks_completion_check
  check (
    (status = 'COMPLETED' and completed_at is not null)
    or (status <> 'COMPLETED' and completed_at is null)
  ) not valid;

create unique index if not exists tasks_org_id_unique_idx
  on public.tasks (organization_id, id);
create index if not exists tasks_org_owner_status_due_idx
  on public.tasks (organization_id, assigned_user_id, status, due_at, id)
  where deleted_at is null;
create index if not exists tasks_org_branch_status_due_idx
  on public.tasks (organization_id, branch_id, status, due_at, id)
  where deleted_at is null;
create index if not exists tasks_org_lead_idx
  on public.tasks (organization_id, lead_id, updated_at desc, id)
  where deleted_at is null and lead_id is not null;

alter table public.tasks drop constraint if exists tasks_branch_org_fk;
alter table public.tasks
  add constraint tasks_branch_org_fk foreign key (organization_id, branch_id)
  references public.branches (organization_id, id) not valid;
alter table public.tasks drop constraint if exists tasks_team_branch_org_fk;
alter table public.tasks
  add constraint tasks_team_branch_org_fk foreign key (organization_id, branch_id, team_id)
  references public.teams (organization_id, branch_id, id) not valid;
alter table public.tasks drop constraint if exists tasks_assignee_org_fk;
alter table public.tasks
  add constraint tasks_assignee_org_fk foreign key (organization_id, assigned_user_id)
  references public.profiles (organization_id, id) not valid;
alter table public.tasks drop constraint if exists tasks_lead_org_fk;
alter table public.tasks
  add constraint tasks_lead_org_fk foreign key (organization_id, lead_id)
  references public.leads (organization_id, id) not valid;
alter table public.tasks drop constraint if exists tasks_customer_org_fk;
alter table public.tasks
  add constraint tasks_customer_org_fk foreign key (organization_id, customer_id)
  references public.customers (organization_id, id) not valid;
alter table public.tasks drop constraint if exists tasks_updated_by_org_fk;
alter table public.tasks
  add constraint tasks_updated_by_org_fk foreign key (organization_id, updated_by)
  references public.profiles (organization_id, id) not valid;

drop policy if exists tenant_record_scope on public.tasks;
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks
for select to authenticated using (
  deleted_at is null
  and app_private.has_permission(organization_id, 'task.view')
  and app_private.can_access_record(
    organization_id, branch_id, team_id, assigned_user_id
  )
  and (lead_id is null or app_private.can_access_lead(lead_id))
);
revoke insert, update, delete on public.tasks from anon, authenticated;

create or replace function public.get_task_workspace_page(
  target_search text default '',
  target_status text default 'ALL',
  target_priority text default 'ALL',
  target_page integer default 1,
  target_page_size integer default 25,
  target_sort text default 'due:asc',
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  search_uuid uuid;
  day_start timestamptz;
  day_end timestamptz;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if char_length(normalized_search) > 160
    or target_status not in (
      'ALL', 'OPEN', 'IN_PROGRESS', 'OVERDUE', 'TODAY', 'UPCOMING', 'COMPLETED', 'CANCELLED'
    )
    or target_priority not in ('ALL', 'LOW', 'NORMAL', 'HIGH', 'URGENT')
    or target_page not between 1 and 1000000
    or target_page_size not in (25, 50, 100)
    or target_sort not in ('due:asc', 'due:desc', 'updated:desc', 'priority:desc', 'customer:asc')
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_QUERY';
  end if;
  begin
    perform now() at time zone target_timezone;
  exception when invalid_parameter_value then
    raise exception using errcode = '22023', message = 'INVALID_TIMEZONE';
  end;
  day_start := date_trunc('day', now() at time zone target_timezone)
    at time zone target_timezone;
  day_end := day_start + interval '1 day';
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.view')
  then
    raise exception using errcode = '42501', message = 'TASK_VIEW_PERMISSION_REQUIRED';
  end if;

  with authorized as materialized (
    select
      task_row.id,
      task_row.organization_id,
      task_row.branch_id,
      task_row.team_id,
      task_row.lead_id,
      task_row.customer_id,
      task_row.assigned_user_id,
      task_row.title,
      task_row.description,
      task_row.priority,
      task_row.status,
      task_row.due_at,
      task_row.completed_at,
      task_row.completion_note,
      task_row.version,
      task_row.created_at,
      task_row.updated_at,
      branch_row.name as branch_name,
      team_row.name as team_name,
      assignee_row.full_name as assigned_user_name,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model
    from public.tasks task_row
    join public.branches branch_row
      on branch_row.id = task_row.branch_id
     and branch_row.organization_id = task_row.organization_id
    left join public.teams team_row
      on team_row.id = task_row.team_id
     and team_row.organization_id = task_row.organization_id
    left join public.profiles assignee_row
      on assignee_row.id = task_row.assigned_user_id
     and assignee_row.organization_id = task_row.organization_id
    left join public.customers customer_row
      on customer_row.id = task_row.customer_id
     and customer_row.organization_id = task_row.organization_id
    left join public.leads lead_row
      on lead_row.id = task_row.lead_id
     and lead_row.organization_id = task_row.organization_id
    where task_row.organization_id = current_organization_id
      and task_row.deleted_at is null
      and app_private.can_access_record(
        task_row.organization_id, task_row.branch_id,
        task_row.team_id, task_row.assigned_user_id
      )
      and (task_row.lead_id is null or app_private.can_access_lead(task_row.lead_id))
      and (target_priority = 'ALL' or task_row.priority = target_priority)
      and (
        target_status = 'ALL'
        or (target_status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') and task_row.status = target_status)
        or (target_status = 'OVERDUE' and task_row.status in ('OPEN', 'IN_PROGRESS') and task_row.due_at < now())
        or (target_status = 'TODAY' and task_row.status in ('OPEN', 'IN_PROGRESS') and task_row.due_at >= day_start and task_row.due_at < day_end)
        or (target_status = 'UPCOMING' and task_row.status in ('OPEN', 'IN_PROGRESS') and task_row.due_at >= day_end)
      )
      and (
        normalized_search = ''
        or task_row.id = search_uuid
        or position(normalized_search in lower(task_row.title)) > 0
        or position(normalized_search in lower(coalesce(task_row.description, ''))) > 0
        or position(normalized_search in lower(coalesce(customer_row.full_name, ''))) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
  ), page_rows as (
    select authorized_row.*
    from authorized authorized_row
    order by
      case when target_sort = 'due:asc' then authorized_row.due_at end asc nulls last,
      case when target_sort = 'due:desc' then authorized_row.due_at end desc nulls last,
      case when target_sort = 'updated:desc' then authorized_row.updated_at end desc,
      case when target_sort = 'priority:desc' then case authorized_row.priority
        when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
      end desc,
      case when target_sort = 'customer:asc' then lower(authorized_row.customer_name) end asc,
      authorized_row.id asc
    limit target_page_size offset (target_page - 1) * target_page_size
  )
  select jsonb_build_object(
    'records', coalesce((select jsonb_agg(to_jsonb(page_row) order by
      case when target_sort = 'due:asc' then page_row.due_at end asc nulls last,
      case when target_sort = 'due:desc' then page_row.due_at end desc nulls last,
      case when target_sort = 'updated:desc' then page_row.updated_at end desc,
      case when target_sort = 'priority:desc' then case page_row.priority
        when 'URGENT' then 4 when 'HIGH' then 3 when 'NORMAL' then 2 else 1 end
      end desc,
      case when target_sort = 'customer:asc' then lower(page_row.customer_name) end asc,
      page_row.id asc
    ) from page_rows page_row), '[]'::jsonb),
    'total', (select count(*) from authorized),
    'kpis', jsonb_build_object(
      'overdue', (select count(*) from authorized where status in ('OPEN', 'IN_PROGRESS') and due_at < now()),
      'today', (select count(*) from authorized where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_start and due_at < day_end),
      'upcoming', (select count(*) from authorized where status in ('OPEN', 'IN_PROGRESS') and due_at >= day_end),
      'completed_today', (select count(*) from authorized where status = 'COMPLETED' and completed_at >= day_start and completed_at < day_end)
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.get_task_lead_options(
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
  normalized_search text := lower(btrim(coalesce(target_search, '')));
  result jsonb;
begin
  if char_length(normalized_search) > 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'INVALID_TASK_OPTION_QUERY';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.create')
  then
    raise exception using errcode = '42501', message = 'TASK_CREATE_PERMISSION_REQUIRED';
  end if;
  select coalesce(jsonb_agg(to_jsonb(option_row) order by option_row.updated_at desc), '[]'::jsonb)
  into result
  from (
    select
      lead_row.id as lead_id,
      lead_row.customer_id,
      lead_row.branch_id,
      lead_row.team_id,
      customer_row.full_name as customer_name,
      customer_row.primary_phone as phone,
      lead_row.interested_model,
      branch_row.name as branch_name,
      lead_row.updated_at
    from public.leads lead_row
    join public.customers customer_row
      on customer_row.id = lead_row.customer_id
     and customer_row.organization_id = lead_row.organization_id
     and customer_row.deleted_at is null
    join public.branches branch_row
      on branch_row.id = lead_row.branch_id
     and branch_row.organization_id = lead_row.organization_id
    where lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and lead_row.lifecycle_status <> 'Lost'
      and app_private.can_access_record(
        lead_row.organization_id, lead_row.branch_id,
        lead_row.team_id, lead_row.assigned_user_id
      )
      and (
        normalized_search = ''
        or position(normalized_search in lower(customer_row.full_name)) > 0
        or position(normalized_search in lower(coalesce(lead_row.interested_model, ''))) > 0
        or position(normalized_search in lower(lead_row.id::text)) > 0
        or (
          app_private.normalize_phone_digits(normalized_search) <> ''
          and app_private.normalize_phone_digits(customer_row.primary_phone)
            = app_private.normalize_phone_digits(normalized_search)
        )
      )
    order by lead_row.updated_at desc, lead_row.id desc
    limit target_limit
  ) option_row;
  return result;
end;
$$;

create or replace function public.create_task(
  target_lead_id uuid,
  task_title text,
  task_description text,
  task_priority text,
  task_due_at timestamptz,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_row public.leads%rowtype;
  new_task public.tasks%rowtype;
  normalized_title text := btrim(coalesce(task_title, ''));
  normalized_description text := nullif(btrim(coalesce(task_description, '')), '');
  normalized_priority text := upper(btrim(coalesce(task_priority, 'NORMAL')));
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.create')
  then
    raise exception using errcode = '42501', message = 'TASK_CREATE_PERMISSION_REQUIRED';
  end if;
  if target_lead_id is null or target_request_id is null
    or char_length(normalized_title) not between 1 and 160
    or char_length(coalesce(normalized_description, '')) > 2000
    or normalized_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    or task_due_at is null or task_due_at < now() - interval '5 minutes'
    or task_due_at > now() + interval '3 years'
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_INPUT';
  end if;
  select * into lead_row
  from public.leads source_row
  where source_row.id = target_lead_id
    and source_row.organization_id = current_organization_id
    and source_row.customer_id is not null
    and source_row.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK_LEAD_NOT_FOUND';
  end if;
  if not app_private.can_access_record(
    lead_row.organization_id, lead_row.branch_id, lead_row.team_id, lead_row.assigned_user_id
  ) or not app_private.can_access_record(
    lead_row.organization_id, lead_row.branch_id, lead_row.team_id, auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'TASK_SCOPE_DENIED';
  end if;
  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'lead_id', target_lead_id,
    'title', normalized_title,
    'description', normalized_description,
    'priority', normalized_priority,
    'due_at', task_due_at
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':task.created:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_work_request(
    current_organization_id, 'task.created', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;

  insert into public.tasks (
    organization_id, branch_id, team_id, assigned_user_id,
    resource_type, resource_id, lead_id, customer_id,
    title, description, priority, status, due_at, created_by, updated_by
  ) values (
    current_organization_id, lead_row.branch_id, lead_row.team_id, auth.uid(),
    'LEAD', lead_row.id, lead_row.id, lead_row.customer_id,
    normalized_title, normalized_description, normalized_priority,
    'OPEN', task_due_at, auth.uid(), auth.uid()
  ) returning * into new_task;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, new_task.customer_id, new_task.lead_id,
    'TASK_CREATED', auth.uid(),
    jsonb_build_object('task_id', new_task.id, 'title', new_task.title, 'due_at', new_task.due_at)
  );
  result := jsonb_build_object(
    'id', new_task.id, 'version', new_task.version,
    'status', new_task.status, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'task.created', 'task', new_task.id::text,
    new_task.branch_id, target_request_id,
    jsonb_build_object('request_fingerprint', request_fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.update_task(
  target_task_id uuid,
  expected_version bigint,
  task_patch jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  task_row public.tasks%rowtype;
  normalized_title text;
  normalized_description text;
  normalized_priority text;
  normalized_status text;
  normalized_due_at timestamptz;
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.update')
  then
    raise exception using errcode = '42501', message = 'TASK_UPDATE_PERMISSION_REQUIRED';
  end if;
  if target_task_id is null or expected_version is null or target_request_id is null
    or jsonb_typeof(task_patch) <> 'object'
    or task_patch = '{}'::jsonb
    or task_patch - array['title', 'description', 'priority', 'status', 'due_at']::text[] <> '{}'::jsonb
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_PATCH';
  end if;
  select * into task_row
  from public.tasks source_row
  where source_row.id = target_task_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK_NOT_FOUND';
  end if;
  if task_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TASK_VERSION_CONFLICT';
  end if;
  if task_row.status not in ('OPEN', 'IN_PROGRESS') then
    raise exception using errcode = '23514', message = 'TASK_TERMINAL';
  end if;
  if not app_private.can_access_record(
    task_row.organization_id, task_row.branch_id, task_row.team_id, task_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'TASK_SCOPE_DENIED';
  end if;
  normalized_title := case when task_patch ? 'title'
    then btrim(coalesce(task_patch->>'title', '')) else task_row.title end;
  normalized_description := case when task_patch ? 'description'
    then nullif(btrim(coalesce(task_patch->>'description', '')), '') else task_row.description end;
  normalized_priority := case when task_patch ? 'priority'
    then upper(btrim(coalesce(task_patch->>'priority', ''))) else task_row.priority end;
  normalized_status := case when task_patch ? 'status'
    then upper(btrim(coalesce(task_patch->>'status', ''))) else task_row.status end;
  begin
    normalized_due_at := case when task_patch ? 'due_at'
      then (task_patch->>'due_at')::timestamptz else task_row.due_at end;
  exception when invalid_datetime_format then
    raise exception using errcode = '22023', message = 'INVALID_TASK_DUE_AT';
  end;
  if char_length(normalized_title) not between 1 and 160
    or char_length(coalesce(normalized_description, '')) > 2000
    or normalized_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    or normalized_status not in ('OPEN', 'IN_PROGRESS')
    or normalized_due_at is null or normalized_due_at > now() + interval '3 years'
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_PATCH';
  end if;
  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'task_id', target_task_id, 'expected_version', expected_version,
    'patch', task_patch
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':task.updated:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_work_request(
    current_organization_id, 'task.updated', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  update public.tasks destination_row
  set title = normalized_title,
      description = normalized_description,
      priority = normalized_priority,
      status = normalized_status,
      due_at = normalized_due_at,
      updated_by = auth.uid(),
      updated_at = now(),
      version = destination_row.version + 1
  where destination_row.id = task_row.id
    and destination_row.organization_id = current_organization_id
    and destination_row.version = expected_version
  returning destination_row.* into task_row;
  if not found then
    raise exception using errcode = '40001', message = 'TASK_VERSION_CONFLICT';
  end if;
  result := jsonb_build_object(
    'id', task_row.id, 'version', task_row.version,
    'status', task_row.status, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'task.updated', 'task', task_row.id::text,
    task_row.branch_id, target_request_id,
    jsonb_build_object('request_fingerprint', request_fingerprint, 'result', result, 'patch', task_patch)
  );
  return result;
end;
$$;

create or replace function public.complete_task(
  target_task_id uuid,
  expected_version bigint,
  completion_note text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  task_row public.tasks%rowtype;
  normalized_note text := nullif(btrim(coalesce(completion_note, '')), '');
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.complete')
  then
    raise exception using errcode = '42501', message = 'TASK_COMPLETE_PERMISSION_REQUIRED';
  end if;
  if target_task_id is null or expected_version is null or target_request_id is null
    or char_length(coalesce(normalized_note, '')) > 2000
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_COMPLETION';
  end if;
  select * into task_row
  from public.tasks source_row
  where source_row.id = target_task_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TASK_NOT_FOUND'; end if;
  if task_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TASK_VERSION_CONFLICT';
  end if;
  if task_row.status not in ('OPEN', 'IN_PROGRESS') then
    raise exception using errcode = '23514', message = 'TASK_TERMINAL';
  end if;
  if not app_private.can_access_record(
    task_row.organization_id, task_row.branch_id, task_row.team_id, task_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'TASK_SCOPE_DENIED';
  end if;
  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'task_id', target_task_id, 'expected_version', expected_version, 'note', normalized_note
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':task.completed:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_work_request(
    current_organization_id, 'task.completed', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  update public.tasks destination_row
  set status = 'COMPLETED', completed_at = now(), completion_note = normalized_note,
      updated_by = auth.uid(), updated_at = now(), version = destination_row.version + 1
  where destination_row.id = task_row.id and destination_row.version = expected_version
  returning destination_row.* into task_row;
  if not found then raise exception using errcode = '40001', message = 'TASK_VERSION_CONFLICT'; end if;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, task_row.customer_id, task_row.lead_id,
    'TASK_COMPLETED', auth.uid(),
    jsonb_build_object('task_id', task_row.id, 'completion_note', normalized_note)
  );
  result := jsonb_build_object(
    'id', task_row.id, 'version', task_row.version,
    'status', task_row.status, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'task.completed', 'task', task_row.id::text,
    task_row.branch_id, target_request_id,
    jsonb_build_object('request_fingerprint', request_fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.cancel_task(
  target_task_id uuid,
  expected_version bigint,
  cancellation_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  task_row public.tasks%rowtype;
  normalized_reason text := btrim(coalesce(cancellation_reason, ''));
  request_fingerprint text;
  replay_result jsonb;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'task.cancel')
  then
    raise exception using errcode = '42501', message = 'TASK_CANCEL_PERMISSION_REQUIRED';
  end if;
  if target_task_id is null or expected_version is null or target_request_id is null
    or char_length(normalized_reason) not between 3 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_TASK_CANCELLATION';
  end if;
  select * into task_row
  from public.tasks source_row
  where source_row.id = target_task_id
    and source_row.organization_id = current_organization_id
    and source_row.deleted_at is null
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'TASK_NOT_FOUND'; end if;
  if task_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'TASK_VERSION_CONFLICT';
  end if;
  if task_row.status not in ('OPEN', 'IN_PROGRESS') then
    raise exception using errcode = '23514', message = 'TASK_TERMINAL';
  end if;
  if not app_private.can_access_record(
    task_row.organization_id, task_row.branch_id, task_row.team_id, task_row.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'TASK_SCOPE_DENIED';
  end if;
  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'task_id', target_task_id, 'expected_version', expected_version,
    'reason', normalized_reason
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':task.cancelled:' || target_request_id::text, 0
  ));
  replay_result := app_private.replay_work_request(
    current_organization_id, 'task.cancelled', target_request_id, request_fingerprint
  );
  if replay_result is not null then return replay_result; end if;
  update public.tasks destination_row
  set status = 'CANCELLED', completion_note = normalized_reason,
      updated_by = auth.uid(), updated_at = now(), version = destination_row.version + 1
  where destination_row.id = task_row.id and destination_row.version = expected_version
  returning destination_row.* into task_row;
  if not found then raise exception using errcode = '40001', message = 'TASK_VERSION_CONFLICT'; end if;
  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_organization_id, task_row.customer_id, task_row.lead_id,
    'TASK_CANCELLED', auth.uid(),
    jsonb_build_object('task_id', task_row.id, 'reason', normalized_reason)
  );
  result := jsonb_build_object(
    'id', task_row.id, 'version', task_row.version,
    'status', task_row.status, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'task.cancelled', 'task', task_row.id::text,
    task_row.branch_id, target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint, 'result', result,
      'reason', normalized_reason
    )
  );
  return result;
end;
$$;

drop trigger if exists realtime_tasks_invalidate on public.tasks;
create trigger realtime_tasks_invalidate
after insert or update on public.tasks
for each row execute function app_private.broadcast_tenant_invalidation('work');

revoke all on function public.get_task_workspace_page(text, text, text, integer, integer, text, text)
  from public, anon;
grant execute on function public.get_task_workspace_page(text, text, text, integer, integer, text, text)
  to authenticated;
revoke all on function public.get_task_lead_options(text, integer)
  from public, anon;
grant execute on function public.get_task_lead_options(text, integer)
  to authenticated;
revoke all on function public.create_task(uuid, text, text, text, timestamptz, uuid)
  from public, anon;
grant execute on function public.create_task(uuid, text, text, text, timestamptz, uuid)
  to authenticated;
revoke all on function public.update_task(uuid, bigint, jsonb, uuid)
  from public, anon;
grant execute on function public.update_task(uuid, bigint, jsonb, uuid)
  to authenticated;
revoke all on function public.complete_task(uuid, bigint, text, uuid)
  from public, anon;
grant execute on function public.complete_task(uuid, bigint, text, uuid)
  to authenticated;
revoke all on function public.cancel_task(uuid, bigint, text, uuid)
  from public, anon;
grant execute on function public.cancel_task(uuid, bigint, text, uuid)
  to authenticated;

commit;
