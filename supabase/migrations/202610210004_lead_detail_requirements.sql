-- Lead detail returns the lead's requirements (variant, budget, timeline,
-- finance, exchange, test drive, competitors) so the mobile Requirement card
-- can show what was captured, including fields approved from an AI call
-- review (202610210001). The function already checks access to the lead; the
-- helper only reads that lead's row.
-- Patched onto the live definition (see 202610171593), never re-emitted.

begin;

create or replace function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  occurrences integer := (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text);
begin
  if occurrences <> 1 then
    raise exception 'PATCH_ANCHOR_% for %: expected 1 occurrence, found %',
      md5(old_text), target, occurrences;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;

select pg_temp.patch_function(
  'public.get_lead_detail_workspace(uuid)',
  $old$    'call_language', lead_row.call_language,
$old$,
  $new$    'call_language', lead_row.call_language,
    'requirements', app_private.lead_requirements_json(lead_row.id),
$new$
);

commit;
