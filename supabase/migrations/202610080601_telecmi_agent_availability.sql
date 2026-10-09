begin;

-- The same dealership app can have several branch-scoped connections. Reserve
-- an agent across the app, not just inside one connection's JSON mapping.
create or replace function app_private.telecmi_mapping_phone(value text)
returns text language sql immutable set search_path = '' as $$
  select case
    when length(digits) = 10 then '91' || digits
    when length(digits) = 11 and left(digits, 1) = '0' then '91' || substring(digits from 2)
    else digits
  end
  from (select regexp_replace(coalesce(value, ''), '\D', '', 'g') as digits) normalized;
$$;

create or replace function public.get_telecmi_agent_reservations(
  target_organization_id uuid,
  target_external_account_id text,
  excluded_connection_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', agent ->> 'user_id',
      'phone', app_private.telecmi_mapping_phone(agent ->> 'phone')
    )), '[]'::jsonb)
    from public.connected_accounts connection_row
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
        then connection_row.connection_config -> 'parallel_agents'
      else '[]'::jsonb end) agent
    where connection_row.organization_id = target_organization_id
      and connection_row.provider_key = 'telecmi'
      and connection_row.external_account_id = target_external_account_id
      and connection_row.deleted_at is null
      and connection_row.id is distinct from excluded_connection_id
  );
end;
$$;
revoke all on function public.get_telecmi_agent_reservations(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.get_telecmi_agent_reservations(uuid, text, uuid) to service_role;

create or replace function app_private.guard_telecmi_agent_reservations()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  mappings jsonb;
begin
  if new.provider_key <> 'telecmi' or new.deleted_at is not null then return new; end if;
  mappings := case when jsonb_typeof(new.connection_config -> 'parallel_agents') = 'array'
    then new.connection_config -> 'parallel_agents' else '[]'::jsonb end;
  -- Save and automatic invitation/linking both pass through this trigger.
  -- Serialise writes for this tenant/app so concurrent saves cannot double-book.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    new.organization_id::text || ':telecmi:' || coalesce(new.external_account_id, ''), 0
  ));
  if exists (
    select 1 from jsonb_array_elements(mappings) agent
    group by agent ->> 'user_id' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(mappings) agent
    group by app_private.telecmi_mapping_phone(agent ->> 'phone') having count(*) > 1
  ) or exists (
    select 1
    from public.connected_accounts connection_row
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
        then connection_row.connection_config -> 'parallel_agents'
      else '[]'::jsonb end) reserved
    cross join lateral jsonb_array_elements(mappings) candidate
    where connection_row.organization_id = new.organization_id
      and connection_row.provider_key = 'telecmi'
      and connection_row.external_account_id = new.external_account_id
      and connection_row.deleted_at is null
      and connection_row.id <> new.id
      and (reserved ->> 'user_id' = candidate ->> 'user_id'
        or app_private.telecmi_mapping_phone(reserved ->> 'phone') =
          app_private.telecmi_mapping_phone(candidate ->> 'phone'))
  ) then
    raise exception using errcode = '23505', message = 'TELECMI_AGENT_MAPPING_CONFLICT';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_telecmi_agent_reservations() from public, anon, authenticated;
drop trigger if exists guard_telecmi_agent_reservations on public.connected_accounts;
create trigger guard_telecmi_agent_reservations
  before insert or update of connection_config, external_account_id, provider_key, deleted_at
  on public.connected_accounts for each row execute function app_private.guard_telecmi_agent_reservations();

commit;
