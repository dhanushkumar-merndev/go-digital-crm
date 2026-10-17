begin;

-- Lead detail shows and edits the lead's AI call language (202610171573).

do $patch$
declare
  target regprocedure := 'public.get_lead_detail_workspace(uuid)'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchor text := E'    ''temperature'', lead_row.temperature,\n    ''work_state'', case\n';
begin
  if position('''call_language''' in definition) > 0 then
    raise exception 'get_lead_detail_workspace already patched';
  end if;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'get_lead_detail_workspace anchor not found exactly once';
  end if;
  execute replace(definition, anchor,
    E'    ''temperature'', lead_row.temperature,\n    ''call_language'', lead_row.call_language,\n'
    || E'    ''work_state'', case\n');
  if position('''call_language''' in pg_get_functiondef(target)) = 0 then
    raise exception 'get_lead_detail_workspace patch did not land';
  end if;
end;
$patch$;

commit;
