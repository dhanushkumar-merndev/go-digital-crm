begin;

-- Page-local searches also matched phone numbers, using the digits pulled out
-- of whatever was typed: normalize_phone_digits('Amal browser QA mul7wuiq')
-- is '7', so searching a name that happened to contain a digit also matched
-- every customer whose phone contains a 7. On the Sales Consultant Bookings
-- page that search returned 48 unrelated bookings and pushed the right one off
-- the first page; "Ravi 2" matched everyone with a 2 in their number.
--
-- A search is a phone search only when it looks like one -- digits with the
-- usual separators (+, spaces, dashes, brackets, dots). Anything with a letter
-- is matched as text only. Numeric searches behave exactly as before, and
-- normalize_phone_digits itself is untouched, because indexes and stored
-- values are built on it.
create or replace function app_private.phone_search_digits(search_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when coalesce(search_text, '') ~ '^[0-9+()\s.-]+$'
      then app_private.normalize_phone_digits(search_text)
    else ''
  end;
$$;
revoke all on function app_private.phone_search_digits(text) from public, anon, authenticated;

-- Every search RPC derives its phone term in one assignment of the form
--   <var> := app_private.normalize_phone_digits(<the search text>);
-- Those assignments, and only those, now use phone_search_digits. Patched in
-- place from the live definitions; comparisons against stored phones keep
-- normalize_phone_digits.
do $migration$
declare
  function_row record;
  current_definition text;
  patched_definition text;
  patched integer := 0;
  assignment_pattern constant text :=
    '(:=\s*)app_private\.normalize_phone_digits\((\s*(normalized_search|search_term|normalized_term|target_search|lower\(btrim\(coalesce\(target_search))';
begin
  for function_row in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and p.prokind = 'f'
      and p.proname <> 'phone_search_digits'
      and pg_get_functiondef(p.oid) ~ assignment_pattern
  loop
    current_definition := pg_get_functiondef(function_row.oid);
    patched_definition := regexp_replace(
      current_definition,
      assignment_pattern,
      '\1app_private.phone_search_digits(\2',
      'g'
    );
    if patched_definition = current_definition then
      raise exception 'PHONE_SEARCH_PATCH_DID_NOT_APPLY: %', function_row.oid::regprocedure;
    end if;
    execute patched_definition;
    patched := patched + 1;
  end loop;

  if patched < 30 then
    raise exception 'PHONE_SEARCH_PATCH_FOUND_TOO_FEW: %', patched;
  end if;
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) ~ assignment_pattern
  ) then
    raise exception 'PHONE_SEARCH_FREE_TEXT_DIGITS_STILL_USED';
  end if;
end;
$migration$;

commit;
