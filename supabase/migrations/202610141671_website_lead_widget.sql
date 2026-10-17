-- Website chat widget + secret-key Lead API.
--
-- Both public boundaries (website-chat-lead, lead-api) ingest through
-- ingest_website_lead, a service-role wrapper around ingest_provider_lead that
-- adds the enquiry's requirements in the same transaction. ingest_provider_lead
-- itself is untouched.

begin;

-- --- 1. Lead API keys ---------------------------------------------------------
-- The secret is shown once by integration-website-api-key; only its SHA-256
-- digest is stored. key_prefix is the public lookup half of the key.
create table public.lead_api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  connected_account_id uuid not null references public.connected_accounts (id),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  key_prefix text not null unique check (key_prefix ~ '^[A-Za-z0-9]{8,16}$'),
  key_hash text not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id)
);
create index lead_api_keys_connection_idx
  on public.lead_api_keys (organization_id, connected_account_id, created_at desc);

alter table public.lead_api_keys enable row level security;
create policy lead_api_keys_select on public.lead_api_keys
  for select to authenticated
  using (
    public.authorize_integration_connection_action(
      organization_id, connected_account_id, 'integration.view'
    )
  );
revoke all on public.lead_api_keys from anon, authenticated;
-- key_hash stays server-only even though it is a digest.
grant select (
  id, organization_id, connected_account_id, name, key_prefix, created_by,
  created_at, last_used_at, revoked_at, revoked_by
) on public.lead_api_keys to authenticated;

create or replace function public.revoke_lead_api_key(target_key_id uuid, target_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  key_row public.lead_api_keys%rowtype;
begin
  select * into key_row from public.lead_api_keys where id = target_key_id for update;
  if not found or not public.authorize_integration_connection_action(
    key_row.organization_id, key_row.connected_account_id, 'integration.manage'
  ) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if key_row.revoked_at is not null then
    return;
  end if;
  update public.lead_api_keys
  set revoked_at = now(), revoked_by = auth.uid()
  where id = target_key_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    key_row.organization_id, auth.uid(), 'integration.lead_api_key_revoked', 'lead_api_key',
    key_row.id::text, target_request_id,
    jsonb_build_object(
      'connection_id', key_row.connected_account_id,
      'key_prefix', key_row.key_prefix,
      'name', key_row.name
    )
  );
end;
$$;
revoke all on function public.revoke_lead_api_key(uuid, uuid) from public, anon;
grant execute on function public.revoke_lead_api_key(uuid, uuid) to authenticated;

-- --- 2. Public-boundary rate limit (fallback when Upstash is off) -------------
create unlogged table app_private.public_rate_limits (
  bucket text primary key,
  window_started_at timestamptz not null,
  hits integer not null
);

create or replace function public.consume_public_rate_limit(
  target_bucket text,
  window_seconds integer,
  max_hits integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  bucket_row app_private.public_rate_limits%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(coalesce(target_bucket, '')) not between 1 and 200
    or window_seconds not between 1 and 86400
    or max_hits not between 1 and 100000
  then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT';
  end if;
  insert into app_private.public_rate_limits as existing (bucket, window_started_at, hits)
  values (target_bucket, now(), 1)
  on conflict (bucket) do update
    set hits = case
          when existing.window_started_at <= now() - make_interval(secs => window_seconds) then 1
          else existing.hits + 1
        end,
        window_started_at = case
          when existing.window_started_at <= now() - make_interval(secs => window_seconds) then now()
          else existing.window_started_at
        end
  returning * into bucket_row;
  return jsonb_build_object(
    'allowed', bucket_row.hits <= max_hits,
    'retry_after_ms', greatest(
      0,
      floor(extract(epoch from (
        bucket_row.window_started_at + make_interval(secs => window_seconds) - now()
      )) * 1000)
    )
  );
end;
$$;
revoke all on function public.consume_public_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_public_rate_limit(text, integer, integer) to service_role;

-- --- 3. Ingest wrapper --------------------------------------------------------
create or replace function public.ingest_website_lead(
  target_organization_id uuid,
  target_connection_id uuid,
  target_branch_id uuid,
  target_external_lead_id text,
  target_source_detail text,
  target_campaign text,
  target_customer_name text,
  target_phone text,
  target_normalized_phone text,
  target_email text,
  target_interested_model text,
  target_requirements jsonb,
  target_raw_payload jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  created_lead_id uuid;
  requirements jsonb := coalesce(target_requirements, '{}'::jsonb);
  connection_row public.connected_accounts%rowtype;
  routed_branch_id uuid := target_branch_id;
  routed_team_id uuid;
  default_team_branch_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into connection_row
  from public.connected_accounts
  where id = target_connection_id
    and organization_id = target_organization_id
    and provider_key = 'website';
  if not found then
    raise exception using errcode = '23503', message = 'ACTIVE_CONNECTION_NOT_FOUND';
  end if;

  -- ingest_provider_lead falls back to the connection's default team, which
  -- must sit in the lead's branch. A visitor may pick any showroom in scope, so
  -- route to a team of that showroom: the default team when it is there, else
  -- the showroom's first active team. A showroom with no team sends the lead to
  -- the default team's showroom rather than failing the enquiry.
  if connection_row.default_team_id is not null then
    select branch_id into default_team_branch_id
    from public.teams
    where id = connection_row.default_team_id and organization_id = target_organization_id;
  end if;
  if default_team_branch_id = target_branch_id then
    routed_team_id := connection_row.default_team_id;
  else
    select team_row.id into routed_team_id
    from public.teams team_row
    where team_row.organization_id = target_organization_id
      and team_row.branch_id = target_branch_id
      and team_row.active
    order by exists (
        select 1 from public.team_members member_row
        where member_row.team_id = team_row.id
          and member_row.active
          and member_row.eligible_for_fresh_leads
      ) desc,
      team_row.name,
      team_row.id
    limit 1;
    if routed_team_id is null and default_team_branch_id is not null then
      routed_branch_id := default_team_branch_id;
      routed_team_id := connection_row.default_team_id;
    end if;
  end if;

  result := public.ingest_provider_lead(
    target_organization_id, target_connection_id, routed_branch_id, routed_team_id,
    target_external_lead_id, 'Website', target_source_detail, target_campaign,
    target_customer_name, target_phone, target_normalized_phone, target_email,
    target_interested_model, target_raw_payload, target_request_id
  );
  if (result ->> 'duplicate')::boolean then
    return result;
  end if;
  created_lead_id := (result ->> 'lead_id')::uuid;

  if requirements <> '{}'::jsonb then
    insert into public.lead_requirements (
      lead_id, organization_id, variant, fuel_type, transmission, purchase_timeline,
      budget_min, budget_max, finance_required, exchange_required, test_drive_required
    ) values (
      created_lead_id, target_organization_id,
      nullif(left(btrim(requirements ->> 'variant'), 120), ''),
      nullif(left(btrim(requirements ->> 'fuel_type'), 40), ''),
      nullif(left(btrim(requirements ->> 'transmission'), 40), ''),
      nullif(left(btrim(requirements ->> 'purchase_timeline'), 60), ''),
      (requirements ->> 'budget_min')::numeric,
      (requirements ->> 'budget_max')::numeric,
      (requirements ->> 'finance_required')::boolean,
      (requirements ->> 'exchange_required')::boolean,
      (requirements ->> 'test_drive_required')::boolean
    );
  end if;

  insert into public.activities (organization_id, lead_id, activity_type, metadata)
  values (
    target_organization_id, created_lead_id, 'WEBSITE_LEAD_RECEIVED',
    jsonb_build_object(
      'connection_id', target_connection_id,
      'channel', coalesce(target_raw_payload ->> 'channel', 'WEBSITE')
    )
  );
  return result;
end;
$$;
revoke all on function public.ingest_website_lead(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.ingest_website_lead(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, jsonb, uuid
) to service_role;

-- --- 4. Chat answers on lead detail -------------------------------------------
create or replace function public.get_lead_website_answers(target_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  lead_row public.leads%rowtype;
begin
  select * into lead_row from public.leads where id = target_lead_id;
  if not found
    or not app_private.has_permission(lead_row.organization_id, 'lead.view')
    or not app_private.can_access_lead(target_lead_id)
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if lead_row.source <> 'Website' or lead_row.raw_payload is null then
    return '[]'::jsonb;
  end if;
  return coalesce(lead_row.raw_payload -> 'answers', '[]'::jsonb);
end;
$$;
revoke all on function public.get_lead_website_answers(uuid) from public, anon;
grant execute on function public.get_lead_website_answers(uuid) to authenticated;

commit;
