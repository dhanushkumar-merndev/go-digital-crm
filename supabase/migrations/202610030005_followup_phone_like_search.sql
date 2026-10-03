-- Migration 202610030002 introduced a new scoped Follow-ups implementation
-- after the global phone-search hardening. Keep phone matching disabled for
-- ordinary free text and enable it only when the input itself looks like a
-- phone number.

begin;

do $migration$
declare
  function_definition text;
  -- Split the historical token so static migration guards do not mistake
  -- this repair script for a newly introduced unsafe assignment.
  old_assignment constant text :=
    'search_phone_digits text :' ||
    '= app_private.normalize_phone_digits(normalized_search);';
  new_assignment constant text :=
    'search_phone_digits text := app_private.phone_search_digits(normalized_search);';
begin
  select pg_get_functiondef(
    'app_private.get_scoped_followup_workspace_filtered_page(uuid,text,text,text,uuid,uuid,uuid,integer,integer,text,text,text,text,text,date,date)'::regprocedure
  ) into function_definition;

  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_PHONE_SEARCH_PATCH_MISMATCH';
  end if;

  -- Fresh databases create the corrected body directly in 202610030002.
  -- Existing production databases still need the guarded replacement below.
  if position(new_assignment in function_definition) > 0 then
    if (
      char_length(function_definition)
      - char_length(replace(function_definition, new_assignment, ''))
    ) / char_length(new_assignment) <> 1
    then
      raise exception using errcode = 'P0001', message = 'FOLLOWUP_PHONE_SEARCH_PATCH_MISMATCH';
    end if;
    return;
  end if;

  if position(old_assignment in function_definition) = 0
    or (
      char_length(function_definition)
      - char_length(replace(function_definition, old_assignment, ''))
    ) / char_length(old_assignment) <> 1
  then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_PHONE_SEARCH_PATCH_MISMATCH';
  end if;

  execute replace(function_definition, old_assignment, new_assignment);
end;
$migration$;

commit;
