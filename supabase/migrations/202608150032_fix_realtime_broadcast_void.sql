begin;

-- realtime.send returns void. Selecting its result into jsonb coerces the void
-- value through an empty string and raises SQLSTATE 22P02 on any trigger write.
-- Broadcasts are best-effort invalidations, so invoke the function directly.
create or replace function app_private.broadcast_tenant_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb;
  target_organization_id uuid;
  target_record_id text;
  target_topic text;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  row_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if coalesce(row_data->>'organization_id', '')
    !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  then
    return null;
  end if;
  target_organization_id := (row_data->>'organization_id')::uuid;
  target_record_id := coalesce(
    row_data->>'id',
    row_data->>'connected_account_id',
    row_data->>'user_id',
    'changed'
  );
  target_topic := 'organization:' || target_organization_id::text || ':' || tg_argv[0];
  perform realtime.send(
    jsonb_build_object(
      'resource', tg_argv[0],
      'operation', tg_op,
      'record_id', target_record_id
    ),
    lower(tg_op),
    target_topic,
    true
  );
  return null;
end;
$$;

create or replace function app_private.broadcast_platform_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb;
  target_record_id text;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  row_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  target_record_id := coalesce(row_data->>'id', 'changed');
  perform realtime.send(
    jsonb_build_object(
      'resource', tg_argv[0],
      'operation', tg_op,
      'record_id', target_record_id
    ),
    lower(tg_op),
    'platform:' || tg_argv[0],
    true
  );
  return null;
end;
$$;

revoke all on function app_private.broadcast_tenant_invalidation()
from public, anon, authenticated;
revoke all on function app_private.broadcast_platform_invalidation()
from public, anon, authenticated;

commit;
