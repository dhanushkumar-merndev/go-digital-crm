-- The case-list overview showed "Workflow progress" by counting the statuses
-- of the 25 rows on the current page, so a desk with 300 cases read 4, 7, 2...
-- Return one GROUP BY over the actor's authorized cases instead, alongside the
-- existing KPI bundle, and add a DUE_TODAY view so the "Due today" KPI opens its
-- own list rather than the overdue one.
--
-- Patched in place on the live definition: later migrations (the phone-search
-- patch among them) already rewrote this function, and restating an old body
-- would silently undo them.

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
  'public.get_operational_case_workspace_page(text,text,text,date,date,integer,integer,text,text)',
  $old$normalized_status not in ('ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'COMPLETED')$old$,
  $new$normalized_status not in ('ALL', 'OPEN', 'DOCUMENTS', 'ACTION_DUE', 'DUE_TODAY', 'COMPLETED')$new$
);

select pg_temp.patch_function(
  'public.get_operational_case_workspace_page(text,text,text,date,date,integer,integer,text,text)',
  $old$      when 'COMPLETED' then authorized_row.terminal
$old$,
  $new$      when 'DUE_TODAY' then
        not authorized_row.terminal
        and authorized_row.due_at >= today_start
        and authorized_row.due_at < tomorrow_start
      when 'COMPLETED' then authorized_row.terminal
$new$
);

select pg_temp.patch_function(
  'public.get_operational_case_workspace_page(text,text,text,date,date,integer,integer,text,text)',
  $old$    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where not terminal),$old$,
  $new$    'status_counts', coalesce((
      select jsonb_object_agg(status_row.status, status_row.case_count)
      from (
        select status, count(*) as case_count
        from authorized
        group by status
      ) status_row
    ), '{}'::jsonb),
    'kpis', jsonb_build_object(
      'open', (select count(*) from authorized where not terminal),$new$
);

commit;
