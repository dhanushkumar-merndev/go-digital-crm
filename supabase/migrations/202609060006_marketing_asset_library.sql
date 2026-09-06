-- A generated image landed in object_files bound to resource_type
-- 'ai_image_generation' and was reachable only from the generation that made it.
-- There was no way to name one, find it again, or reuse it in a campaign, so
-- every image was effectively single-use. The library below is that missing
-- layer: it does not copy the bytes, it points at the object_files row already
-- stored and adds the naming and tagging a person needs to find it later.

create table public.marketing_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  object_file_id uuid not null references public.object_files(id),
  name text not null,
  -- Provenance decides nothing at read time; it exists so a person can tell a
  -- generated asset from one somebody uploaded.
  source text not null default 'AI_GENERATED',
  -- Lowercased on write so search never has to case-fold at query time.
  tags text[] not null default '{}',
  generation_id uuid references public.ai_image_generations(id),
  created_by uuid not null references public.profiles(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- One library entry per stored file: two names for the same bytes would make
  -- "delete this asset" ambiguous.
  unique (object_file_id),
  check (char_length(btrim(name)) between 2 and 180),
  check (source in ('AI_GENERATED', 'UPLOADED')),
  check (cardinality(tags) <= 20)
);

alter table public.marketing_assets
  add constraint marketing_assets_branch_org_fk foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) not valid,
  add constraint marketing_assets_creator_org_fk foreign key (organization_id, created_by)
    references public.profiles (organization_id, id) not valid;

-- The listing's own order, so paging never sorts a whole tenant's library.
create index marketing_assets_library_idx
  on public.marketing_assets (organization_id, created_at desc, id desc)
  where deleted_at is null;
create index marketing_assets_tags_idx on public.marketing_assets using gin (tags)
  where deleted_at is null;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
values ('marketing_assets', 'DELETE', 784)
on conflict (table_name) do update
  set disposition = excluded.disposition, delete_order = excluded.delete_order;

alter table public.marketing_assets enable row level security;
alter table public.marketing_assets force row level security;
revoke insert, update, delete, truncate on public.marketing_assets from anon, authenticated;

create policy marketing_assets_read on public.marketing_assets
  for select to authenticated using (
    app_private.has_permission(organization_id, 'marketing.social.manage')
    and (branch_id is null or app_private.can_access_branch(organization_id, branch_id))
  );

-- Server-side pagination with an exact count. A tenant's library grows without
-- bound, so the client is never handed the whole table to slice.
create or replace function public.get_marketing_asset_library(
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default null,
  target_tag text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text := left(btrim(coalesce(target_search, '')), 100);
  normalized_tag text := lower(left(btrim(coalesce(target_tag, '')), 40));
  offset_rows integer;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_SOCIAL_PERMISSION_REQUIRED';
  end if;
  if target_page not between 1 and 100000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_ASSET_PAGE';
  end if;
  offset_rows := (target_page - 1) * target_page_size;

  return jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', asset_row.id,
        'name', asset_row.name,
        'source', asset_row.source,
        'tags', to_jsonb(asset_row.tags),
        'object_file_id', asset_row.object_file_id,
        'mime_type', file_row.mime_type,
        'size_bytes', file_row.size_bytes,
        'created_at', asset_row.created_at,
        'created_by_name', coalesce(profile_row.full_name, 'System')
      ) order by asset_row.created_at desc, asset_row.id desc)
      from (
        select * from public.marketing_assets
        where organization_id = current_organization_id and deleted_at is null
          and (branch_id is null
            or app_private.can_access_branch(current_organization_id, branch_id))
          and (normalized_search = '' or name ilike '%' || normalized_search || '%')
          and (normalized_tag = '' or tags @> array[normalized_tag])
        order by created_at desc, id desc
        limit target_page_size offset offset_rows
      ) asset_row
      join public.object_files file_row on file_row.id = asset_row.object_file_id
      left join public.profiles profile_row on profile_row.id = asset_row.created_by
    ), '[]'::jsonb),
    'total', (
      select count(*)::integer from public.marketing_assets
      where organization_id = current_organization_id and deleted_at is null
        and (branch_id is null
          or app_private.can_access_branch(current_organization_id, branch_id))
        and (normalized_search = '' or name ilike '%' || normalized_search || '%')
        and (normalized_tag = '' or tags @> array[normalized_tag])
    )
  );
end;
$$;

-- Promotes an image the tenant already generated into the reusable library. The
-- output is verified to belong to a completed generation in this organization,
-- so an id from elsewhere cannot pull another tenant's file into the library.
create or replace function public.save_ai_image_as_asset(
  target_object_file_id uuid,
  target_name text,
  target_tags text[],
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  output_row public.ai_image_generation_outputs%rowtype;
  generation_row public.ai_image_generations%rowtype;
  existing_id uuid;
  normalized_name text := left(btrim(coalesce(target_name, '')), 180);
  normalized_tags text[] := coalesce((
    select array_agg(distinct lower(btrim(tag)))
    from unnest(coalesce(target_tags, '{}')) as tag
    where char_length(btrim(tag)) between 1 and 40
  ), '{}');
  asset_id uuid := gen_random_uuid();
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_SOCIAL_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null or char_length(normalized_name) not between 2 and 180
    or cardinality(normalized_tags) > 20
  then
    raise exception using errcode = '22023', message = 'INVALID_ASSET_INPUT';
  end if;

  select * into output_row from public.ai_image_generation_outputs
  where object_file_id = target_object_file_id
    and organization_id = current_organization_id;
  if not found then
    raise exception using errcode = '22023', message = 'ASSET_SOURCE_NOT_FOUND';
  end if;
  select * into generation_row from public.ai_image_generations
  where id = output_row.generation_id and organization_id = current_organization_id;
  if not found or generation_row.status <> 'COMPLETED' then
    raise exception using errcode = '22023', message = 'ASSET_SOURCE_NOT_READY';
  end if;

  -- Saving the same image twice is a double click, not an error.
  select id into existing_id from public.marketing_assets
  where object_file_id = target_object_file_id and deleted_at is null;
  if existing_id is not null then
    return jsonb_build_object('id', existing_id, 'name', normalized_name, 'replayed', true);
  end if;

  insert into public.marketing_assets (
    id, organization_id, branch_id, object_file_id, name, source, tags,
    generation_id, created_by
  ) values (
    asset_id, current_organization_id, generation_row.branch_id, target_object_file_id,
    normalized_name, 'AI_GENERATED', normalized_tags, generation_row.id, auth.uid()
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'marketing_asset.saved', 'marketing_asset',
    asset_id::text, generation_row.branch_id, target_request_id,
    jsonb_build_object('generation_id', generation_row.id, 'tags', to_jsonb(normalized_tags))
  );
  return jsonb_build_object('id', asset_id, 'name', normalized_name, 'replayed', false);
end;
$$;

create or replace function public.archive_marketing_asset(target_asset_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_SOCIAL_PERMISSION_REQUIRED';
  end if;
  -- The stored file is deliberately left in place: a campaign that already used
  -- this asset must keep rendering after the asset is retired from the library.
  update public.marketing_assets set deleted_at = now(), updated_at = now()
  where id = target_asset_id and organization_id = current_organization_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'ASSET_NOT_FOUND';
  end if;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'marketing_asset.archived', 'marketing_asset',
    target_asset_id::text, '{}'::jsonb
  );
  return true;
end;
$$;

revoke all on function public.get_marketing_asset_library(integer, integer, text, text)
  from public, anon;
grant execute on function public.get_marketing_asset_library(integer, integer, text, text)
  to authenticated;
revoke all on function public.save_ai_image_as_asset(uuid, text, text[], uuid) from public, anon;
grant execute on function public.save_ai_image_as_asset(uuid, text, text[], uuid) to authenticated;
revoke all on function public.archive_marketing_asset(uuid) from public, anon;
grant execute on function public.archive_marketing_asset(uuid) to authenticated;
