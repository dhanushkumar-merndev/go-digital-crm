-- Image generation is queued at the Edge boundary and completed by Trigger.dev,
-- so provider latency never blocks the browser or an Edge Function request.

create table public.ai_image_generations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid references public.branches(id),
  connected_account_id uuid not null references public.connected_accounts(id),
  prompt text not null check (char_length(prompt) between 4 and 3000),
  template_key text not null check (template_key in ('SOCIAL_POST', 'BANNER', 'STORY_REEL', 'WHATSAPP_POST', 'A4_POSTER', 'CUSTOM')),
  object_type text not null check (object_type in ('CAR_EXTERIOR', 'CAR_INTERIOR', 'ACCESSORIES', 'PEOPLE', 'BACKGROUND', 'CUSTOM_OBJECT')),
  style_key text not null check (style_key in ('REALISTIC', 'CINEMATIC', 'PREMIUM', 'MINIMAL', 'SPORTY')),
  aspect_ratio text not null check (aspect_ratio in ('1:1', '16:9', '9:16', '4:5')),
  output_count smallint not null check (output_count between 1 and 4),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'ERROR')),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  lease_token text,
  next_attempt_at timestamptz not null default now(),
  safe_error_code text,
  requested_by uuid not null references public.profiles(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.ai_image_generation_outputs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  generation_id uuid not null references public.ai_image_generations(id) on delete cascade,
  object_file_id uuid not null references public.object_files(id),
  ordinal smallint not null check (ordinal between 1 and 4),
  created_at timestamptz not null default now(),
  unique (generation_id, ordinal),
  unique (object_file_id)
);

create index ai_image_generations_workspace_idx
  on public.ai_image_generations (organization_id, created_at desc, id);
create index ai_image_generations_worker_idx
  on public.ai_image_generations (status, next_attempt_at, created_at)
  where status in ('QUEUED', 'RUNNING');
create index ai_image_generation_outputs_generation_idx
  on public.ai_image_generation_outputs (generation_id, ordinal);

alter table public.ai_image_generations enable row level security;
alter table public.ai_image_generation_outputs enable row level security;

create or replace function public.get_ai_image_generation_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_organization_id uuid;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'marketing.social.manage')
  then raise exception using errcode = '42501', message = 'AI_IMAGE_GENERATION_PERMISSION_REQUIRED'; end if;
  return jsonb_build_object(
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', connection_row.id,
        'name', connection_row.display_name,
        'provider_key', connection_row.provider_key,
        'image_model', connection_row.connection_config -> 'models' ->> 'image_model'
      ) order by connection_row.display_name, connection_row.id)
      from public.connected_accounts connection_row
      where connection_row.organization_id = current_organization_id
        and connection_row.deleted_at is null
        and connection_row.status = 'CONNECTED'
        and connection_row.provider_key = 'openai'
        and connection_row.connection_config -> 'capabilities' ? 'IMAGE_GENERATION'
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', generation_row.id,
        'prompt', generation_row.prompt,
        'template_key', generation_row.template_key,
        'style_key', generation_row.style_key,
        'status', generation_row.status,
        'output_count', generation_row.output_count,
        'safe_error_code', generation_row.safe_error_code,
        'created_at', generation_row.created_at,
        'completed_at', generation_row.completed_at,
        'outputs', coalesce((select jsonb_agg(jsonb_build_object(
          'object_file_id', output_row.object_file_id,
          'ordinal', output_row.ordinal
        ) order by output_row.ordinal)
          from public.ai_image_generation_outputs output_row
          where output_row.generation_id = generation_row.id), '[]'::jsonb)
      ) order by generation_row.created_at desc, generation_row.id desc)
      from (select * from public.ai_image_generations
        where organization_id = current_organization_id order by created_at desc, id desc limit 12) generation_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.claim_ai_image_generations(
  target_worker_id text,
  target_batch_size integer default 4
)
returns table (
  id uuid, organization_id uuid, branch_id uuid, connected_account_id uuid, prompt text,
  template_key text, object_type text, style_key text, aspect_ratio text, output_count smallint,
  requested_by uuid, lease_token text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  if char_length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160
    or target_batch_size not between 1 and 10
  then raise exception using errcode = '22023', message = 'INVALID_IMAGE_WORKER_CLAIM'; end if;
  return query
  with candidates as (
    select generation_row.id
    from public.ai_image_generations generation_row
    where generation_row.status = 'QUEUED' and generation_row.next_attempt_at <= now()
    order by generation_row.created_at
    for update skip locked limit target_batch_size
  ), claimed as (
    update public.ai_image_generations generation_row
    set status = 'RUNNING', attempts = attempts + 1, started_at = now(),
      lease_token = target_worker_id || ':' || gen_random_uuid()::text
    from candidates where generation_row.id = candidates.id
    returning generation_row.*
  )
  select claimed.id, claimed.organization_id, claimed.branch_id, claimed.connected_account_id,
    claimed.prompt, claimed.template_key, claimed.object_type, claimed.style_key, claimed.aspect_ratio,
    claimed.output_count, claimed.requested_by, claimed.lease_token
  from claimed;
end;
$$;

create or replace function public.complete_ai_image_generation(
  target_generation_id uuid,
  target_lease_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  update public.ai_image_generations
  set status = 'COMPLETED', completed_at = now(), lease_token = null, safe_error_code = null
  where id = target_generation_id and status = 'RUNNING' and lease_token = target_lease_token;
  return found;
end;
$$;

create or replace function public.retry_ai_image_generation(
  target_generation_id uuid,
  target_lease_token text,
  target_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED'; end if;
  update public.ai_image_generations
  set status = case when attempts >= 3 then 'ERROR' else 'QUEUED' end,
    next_attempt_at = case when attempts >= 3 then now() else now() + make_interval(mins => attempts * 2) end,
    safe_error_code = left(btrim(coalesce(target_safe_error_code, 'AI_IMAGE_GENERATION_FAILED')), 100),
    lease_token = null,
    completed_at = case when attempts >= 3 then now() else null end
  where id = target_generation_id and status = 'RUNNING' and lease_token = target_lease_token;
  return found;
end;
$$;

revoke all on function public.get_ai_image_generation_workspace() from public, anon;
grant execute on function public.get_ai_image_generation_workspace() to authenticated;
revoke all on function public.claim_ai_image_generations(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_image_generations(text, integer) to service_role;
revoke all on function public.complete_ai_image_generation(uuid, text) from public, anon, authenticated;
grant execute on function public.complete_ai_image_generation(uuid, text) to service_role;
revoke all on function public.retry_ai_image_generation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.retry_ai_image_generation(uuid, text, text) to service_role;
