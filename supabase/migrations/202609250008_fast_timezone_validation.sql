-- Follow-up and appointment pages validated their timezone argument with
-- `exists (select 1 from pg_catalog.pg_timezone_names where name = tz)`.
-- pg_timezone_names reads the whole timezone database from disk on every call,
-- about 75 ms, and it was most of every Follow-ups / Appointments request (a
-- warm appointment summary took 77 ms, almost all of it this check).
--
-- Valid names are now kept in an indexed table filled from the same view, so a
-- normal lookup is a primary-key probe. A name missing from the table (a zone
-- added by a later timezone-database update, or an invalid value) still falls
-- back to the view, so the accepted set is exactly what it was.
-- Callers are patched from their deployed definitions; bodies are not re-emitted.

create table if not exists app_private.valid_timezones (
  name text primary key
);

insert into app_private.valid_timezones (name)
select timezone_row.name from pg_catalog.pg_timezone_names timezone_row
on conflict (name) do nothing;

revoke all on table app_private.valid_timezones from public, anon, authenticated;

create or replace function app_private.is_valid_timezone(target_timezone text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_timezone is null then
    return false;
  end if;
  return exists (
    select 1 from app_private.valid_timezones valid_row where valid_row.name = target_timezone
  ) or exists (
    select 1 from pg_catalog.pg_timezone_names timezone_row where timezone_row.name = target_timezone
  );
end;
$$;

revoke all on function app_private.is_valid_timezone(text) from public, anon;
grant execute on function app_private.is_valid_timezone(text) to authenticated, service_role;

do $patch$
declare
  function_row record;
  definition text;
  patched text;
  pattern constant text :=
    'exists\s*\(\s*select\s+1\s+from\s+pg_catalog\.pg_timezone_names(?:\s+(\w+))?\s+where\s+(?:\w+\.)?name\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)';
  patched_count integer := 0;
begin
  for function_row in
    select procedure_row.oid
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname in ('public', 'app_private')
      and procedure_row.prokind = 'f'
      and procedure_row.proname <> 'is_valid_timezone'
      and pg_catalog.pg_get_functiondef(procedure_row.oid) like '%pg_timezone_names%'
  loop
    definition := pg_catalog.pg_get_functiondef(function_row.oid);
    patched := regexp_replace(definition, pattern, 'app_private.is_valid_timezone(\2)', 'gi');
    if patched = definition or patched like '%pg_timezone_names%' then
      raise exception 'Unrecognised pg_timezone_names check in %',
        function_row.oid::regprocedure;
    end if;
    execute patched;
    patched_count := patched_count + 1;
  end loop;
  if patched_count = 0 then
    raise exception 'No timezone checks were patched';
  end if;
  raise notice 'Patched % functions to app_private.is_valid_timezone', patched_count;
end
$patch$;
