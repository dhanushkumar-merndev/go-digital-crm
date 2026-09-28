begin;

-- Optimistic-lock conflicts (`*_VERSION_CONFLICT`) were raised with SQLSTATE
-- 40001, serialization_failure. The request path treats 40001 as transient and
-- re-runs the whole call, and an application version check fails identically
-- every time, so a stale save never returned: it spun on the database until the
-- API gateway gave up after ~125 s. Reproduced on 2026-09-28 with
-- transition_quotation_status and quick_book_lead against a stale version.
--
-- PT409 is PostgREST's custom-status SQLSTATE: it is returned at once as HTTP
-- 409 Conflict with code "PT409" and the same message, and nothing retries it.
-- The web client accepts both codes (src/lib/supabase/version-conflict.ts).
--
-- These functions are maintained by patching their deployed definitions, so
-- this rewrites the live text of every function that raises 40001 and then
-- asserts that none is left.
do $migration$
declare
  function_row record;
  current_definition text;
  patched integer := 0;
begin
  for function_row in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) ~ 'errcode\s*=\s*''40001'''
  loop
    current_definition := pg_get_functiondef(function_row.oid);
    execute regexp_replace(
      current_definition, 'errcode\s*=\s*''40001''', 'errcode = ''PT409''', 'g'
    );
    patched := patched + 1;
  end loop;

  if patched = 0 then
    raise exception 'VERSION_CONFLICT_PATCH_FOUND_NOTHING';
  end if;
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) ~ '40001|serialization_failure'
  ) then
    raise exception 'VERSION_CONFLICT_40001_STILL_RAISED';
  end if;
end;
$migration$;

commit;
