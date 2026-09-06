-- Image prompt assembly lived in one hardcoded template literal inside
-- trigger/ai-image-generation.ts, so a tenant could not state how their posters
-- should look or what must never appear in one. The three fields below are the
-- parts a dealership actually needs to own: the standing instruction, the poster
-- layout guidance, and the policy the generator must not cross.

create table public.ai_image_prompt_settings (
  organization_id uuid primary key references public.organizations(id),
  -- Prepended to every generation as the standing instruction.
  system_prompt text not null default '',
  -- Layout and composition guidance, applied when the template is a poster or
  -- social format rather than a plain object render.
  poster_guide text not null default '',
  -- Stated as a prohibition list. Kept separate from the system prompt so it can
  -- be reviewed on its own and is never edited away by a prompt tweak.
  image_policy text not null default '',
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(system_prompt) <= 4000),
  check (char_length(poster_guide) <= 4000),
  check (char_length(image_policy) <= 4000)
);

alter table public.ai_image_prompt_settings enable row level security;
alter table public.ai_image_prompt_settings force row level security;
revoke insert, update, delete, truncate on public.ai_image_prompt_settings
  from anon, authenticated;

insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
values ('ai_image_prompt_settings', 'DELETE', 783)
on conflict (table_name) do update
  set disposition = excluded.disposition, delete_order = excluded.delete_order;

create or replace function public.get_ai_image_prompt_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  settings_row public.ai_image_prompt_settings%rowtype;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_SOCIAL_PERMISSION_REQUIRED';
  end if;
  select * into settings_row from public.ai_image_prompt_settings
  where organization_id = current_organization_id;
  return jsonb_build_object(
    'system_prompt', coalesce(settings_row.system_prompt, ''),
    'poster_guide', coalesce(settings_row.poster_guide, ''),
    'image_policy', coalesce(settings_row.image_policy, ''),
    'updated_at', settings_row.updated_at
  );
end;
$$;

create or replace function public.save_ai_image_prompt_settings(
  target_system_prompt text,
  target_poster_guide text,
  target_image_policy text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_system text := left(btrim(coalesce(target_system_prompt, '')), 4000);
  normalized_guide text := left(btrim(coalesce(target_poster_guide, '')), 4000);
  normalized_policy text := left(btrim(coalesce(target_image_policy, '')), 4000);
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then
    raise exception using errcode = '42501', message = 'MARKETING_SOCIAL_PERMISSION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_AI_IMAGE_PROMPT_INPUT';
  end if;

  insert into public.ai_image_prompt_settings as settings_row (
    organization_id, system_prompt, poster_guide, image_policy, updated_by
  ) values (
    current_organization_id, normalized_system, normalized_guide, normalized_policy, auth.uid()
  )
  on conflict (organization_id) do update set
    system_prompt = excluded.system_prompt,
    poster_guide = excluded.poster_guide,
    image_policy = excluded.image_policy,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'ai_image_prompt_settings.saved',
    'ai_image_prompt_settings', current_organization_id::text, target_request_id,
    jsonb_build_object(
      'system_prompt_length', char_length(normalized_system),
      'poster_guide_length', char_length(normalized_guide),
      'image_policy_length', char_length(normalized_policy)
    )
  );
  return jsonb_build_object(
    'system_prompt', normalized_system,
    'poster_guide', normalized_guide,
    'image_policy', normalized_policy
  );
end;
$$;

-- The worker reads the tenant's prompt parts alongside the job it claimed. They
-- are returned here rather than joined into claim_ai_image_generations so the
-- existing claim contract and its tests stay unchanged.
create or replace function public.get_ai_image_generation_prompt(target_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare settings_row public.ai_image_prompt_settings%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into settings_row from public.ai_image_prompt_settings
  where organization_id = target_organization_id;
  return jsonb_build_object(
    'system_prompt', coalesce(settings_row.system_prompt, ''),
    'poster_guide', coalesce(settings_row.poster_guide, ''),
    'image_policy', coalesce(settings_row.image_policy, '')
  );
end;
$$;

revoke all on function public.get_ai_image_prompt_settings() from public, anon;
grant execute on function public.get_ai_image_prompt_settings() to authenticated;
revoke all on function public.save_ai_image_prompt_settings(text, text, text, uuid)
  from public, anon;
grant execute on function public.save_ai_image_prompt_settings(text, text, text, uuid)
  to authenticated;
revoke all on function public.get_ai_image_generation_prompt(uuid)
  from public, anon, authenticated;
grant execute on function public.get_ai_image_generation_prompt(uuid) to service_role;
