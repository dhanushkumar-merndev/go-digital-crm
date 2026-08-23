alter table public.templates add column if not exists deleted_at timestamptz;
create index if not exists templates_workspace_idx
  on public.templates (organization_id, updated_at desc, id)
  where deleted_at is null;
alter table public.templates enable row level security;

create or replace function public.get_template_workspace(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default null,
  target_channel text default 'ALL',
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
  normalized_search text := left(trim(coalesce(target_search, '')), 100);
  normalized_channel text := upper(trim(coalesce(target_channel, 'ALL')));
  normalized_status text := upper(trim(coalesce(target_status, 'ALL')));
  offset_rows integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_page not between 1 and 100000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_PAGE';
  end if;
  if normalized_channel not in ('ALL', 'EMAIL', 'SMS', 'WHATSAPP', 'WHATSAPP_BUSINESS')
    or normalized_status not in ('ALL', 'DRAFT', 'APPROVED', 'REJECTED', 'ARCHIVED') then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_FILTER';
  end if;
  offset_rows := (target_page - 1) * target_page_size;
  return jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', template_row.id, 'name', template_row.name, 'channel', template_row.channel,
        'content', template_row.content, 'provider_template_id', template_row.provider_template_id,
        'status', template_row.status, 'created_at', template_row.created_at,
        'updated_at', template_row.updated_at,
        'created_by_name', coalesce(profile_row.full_name, 'System')
      ) order by template_row.updated_at desc, template_row.id desc)
      from (
        select * from public.templates
        where organization_id = current_organization_id and deleted_at is null
          and (normalized_channel = 'ALL' or upper(channel) = normalized_channel)
          and (normalized_status = 'ALL' or upper(status) = normalized_status)
          and (normalized_search = '' or name ilike '%' || normalized_search || '%'
            or coalesce(provider_template_id, '') ilike '%' || normalized_search || '%')
        order by updated_at desc, id desc limit target_page_size offset offset_rows
      ) template_row
      left join public.profiles profile_row on profile_row.id = template_row.created_by
    ), '[]'::jsonb),
    'total', (select count(*)::integer from public.templates
      where organization_id = current_organization_id and deleted_at is null
        and (normalized_channel = 'ALL' or upper(channel) = normalized_channel)
        and (normalized_status = 'ALL' or upper(status) = normalized_status)
        and (normalized_search = '' or name ilike '%' || normalized_search || '%'
          or coalesce(provider_template_id, '') ilike '%' || normalized_search || '%')),
    'kpis', jsonb_build_object(
      'total', (select count(*)::integer from public.templates where organization_id = current_organization_id and deleted_at is null),
      'draft', (select count(*)::integer from public.templates where organization_id = current_organization_id and deleted_at is null and upper(status) = 'DRAFT'),
      'approved', (select count(*)::integer from public.templates where organization_id = current_organization_id and deleted_at is null and upper(status) = 'APPROVED'),
      'attention', (select count(*)::integer from public.templates where organization_id = current_organization_id and deleted_at is null and upper(status) = 'REJECTED')
    )
  );
end;
$$;

create or replace function public.create_draft_template(
  target_name text,
  target_channel text,
  target_body text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_name text := left(trim(coalesce(target_name, '')), 120);
  normalized_channel text := upper(trim(coalesce(target_channel, '')));
  normalized_body text := left(trim(coalesce(target_body, '')), 5000);
  template_id uuid := gen_random_uuid();
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or char_length(normalized_name) not between 2 and 120
    or normalized_channel not in ('EMAIL', 'SMS', 'WHATSAPP', 'WHATSAPP_BUSINESS')
    or char_length(normalized_body) not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_INPUT';
  end if;
  insert into public.templates (id, organization_id, channel, name, content, status, created_by)
    values (template_id, current_organization_id, normalized_channel, normalized_name,
      jsonb_build_object('body', normalized_body, 'format', 'TEXT'), 'DRAFT', auth.uid());
  result := jsonb_build_object('id', template_id, 'status', 'DRAFT');
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, request_id, metadata)
    values (current_organization_id, auth.uid(), 'template.draft_created', 'template', template_id::text,
      target_request_id, jsonb_build_object('channel', normalized_channel, 'result', result));
  return result;
end;
$$;

create or replace function public.archive_template(target_template_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  update public.templates set status = 'ARCHIVED', deleted_at = now(), updated_at = now()
    where id = target_template_id and organization_id = current_organization_id and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'TEMPLATE_NOT_FOUND'; end if;
  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
    values (current_organization_id, auth.uid(), 'template.archived', 'template', target_template_id::text, '{}'::jsonb);
  return true;
end;
$$;

revoke all on function public.get_template_workspace(integer, integer, text, text, text) from public, anon;
grant execute on function public.get_template_workspace(integer, integer, text, text, text) to authenticated;
revoke all on function public.create_draft_template(text, text, text, uuid) from public, anon;
grant execute on function public.create_draft_template(text, text, text, uuid) to authenticated;
revoke all on function public.archive_template(uuid) from public, anon;
grant execute on function public.archive_template(uuid) to authenticated;
