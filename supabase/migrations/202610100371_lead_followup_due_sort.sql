begin;

-- The Follow-up tab is a due-date queue, but the lead list could only be ordered
-- by updated, created or customer name, so the most overdue lead sat wherever
-- its last edit happened to put it. Add one sort, `followup:asc`: earliest
-- next_followup_at first, which puts overdue leads on top and upcoming ones
-- after them. Model, source, stage, temperature and follow-up date filters are
-- applied before ordering, exactly as for every other sort.
--
-- Both functions are patched from their deployed text; every edit asserts how
-- many times its anchor occurs, so a moved anchor fails instead of no-opping.
create function pg_temp.lead_sort_edit(
  definition text,
  old_part text,
  new_part text,
  expected integer
) returns text
language plpgsql
as $edit$
begin
  if (length(definition) - length(replace(definition, old_part, ''))) / length(old_part)
    <> expected
  then
    raise exception 'LEAD_FOLLOWUP_SORT_ANCHOR_CHANGED: %', left(old_part, 60);
  end if;
  return replace(definition, old_part, new_part);
end;
$edit$;

do $patch$
declare
  definition text;
begin
  definition := pg_get_functiondef(
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure
  );
  if position('followup:asc' in definition) > 0 then
    return;
  end if;
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$  window_last_name text;
$e$,
      $e$  window_last_name text;
  window_last_followup timestamptz;
$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$      'customer:asc', 'customer:desc'
    )$e$,
      $e$      'customer:asc', 'customer:desc', 'followup:asc'
    )$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$  if target_include_records and not target_include_kpis
    and window_needed <= 5000
  then$e$,
      $e$  if target_include_records and not target_include_kpis
    and window_needed <= 5000
    -- The due-date walk compares against the window's last follow-up time, so it
    -- needs every walked lead to carry one. Only the Follow-up queue guarantees
    -- that; elsewhere the sort evaluates the whole scope with nulls last.
    and (target_sort <> 'followup:asc' or target_status = 'follow-up')
  then$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$      when 'customer:desc' then 'lead_row.customer_name desc, lead_row.id desc'
    end;$e$,
      $e$      when 'customer:desc' then 'lead_row.customer_name desc, lead_row.id desc'
      when 'followup:asc' then 'lead_row.next_followup_at asc, lead_row.id desc'
    end;$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$        when 'lost' then ' and lead_row.lifecycle_status::text = ''Lost'''
        else '' end$e$,
      $e$        when 'lost' then ' and lead_row.lifecycle_status::text = ''Lost'''
        when 'follow-up' then ' and lead_row.next_followup_at is not null'
        else '' end$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$        (array_agg(walk.customer_name order by walk.rn desc))[1]
      from (
        select lead_row.id, lead_row.updated_at, lead_row.created_at, lead_row.customer_name,
$e$,
      $e$        (array_agg(walk.customer_name order by walk.rn desc))[1],
        (array_agg(walk.next_followup_at order by walk.rn desc))[1]
      from (
        select lead_row.id, lead_row.updated_at, lead_row.created_at, lead_row.customer_name,
          lead_row.next_followup_at,
$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$          window_last_updated, window_last_created, window_last_name
        using$e$,
      $e$          window_last_updated, window_last_created, window_last_name,
          window_last_followup
        using$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$        lead_row.normalized_phone,
        lead_row.lifecycle_status
      from staged_leads lead_row$e$,
      $e$        lead_row.normalized_phone,
        lead_row.lifecycle_status,
        lead_row.next_followup_at
      from staged_leads lead_row$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$        lead_row.normalized_phone,
        lead_row.lifecycle_status
      from filtered_lead_ids lead_row$e$,
      $e$        lead_row.normalized_phone,
        lead_row.lifecycle_status,
        lead_row.next_followup_at
      from filtered_lead_ids lead_row$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end$e$,
      $e$          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'followup:asc' then lead_row.next_followup_at < window_last_followup
            or (lead_row.next_followup_at = window_last_followup and lead_row.id >= window_last_id)
        end$e$,
      2
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        lead_row.id desc
      limit target_page_size$e$,
      $e$        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        case when target_sort = 'followup:asc' then lead_row.next_followup_at end asc nulls last,
        lead_row.id desc
      limit target_page_size$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          id desc
        )
        from page_rows$e$,
      $e$          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          case when target_sort = 'followup:asc' then next_followup_at end asc nulls last,
          id desc
        )
        from page_rows$e$,
      1
    );
  if (length(definition) - length(replace(definition, 'followup:asc', ''))) / length('followup:asc') <> 7 then
    raise exception 'LEAD_FOLLOWUP_SORT_PATCH_INCOMPLETE';
  end if;
  execute definition;
end;
$patch$;

do $patch$
declare
  definition text;
begin
  definition := pg_get_functiondef(
    'public.get_lead_workspace_page_v2_legacy(integer,integer,text,text,text,text,text,text,text,date,date)'::regprocedure
  );
  if position('followup:asc' in definition) > 0 then
    return;
  end if;
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$      'customer:asc', 'customer:desc'
    )$e$,
      $e$      'customer:asc', 'customer:desc', 'followup:asc'
    )$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        lead_row.id desc$e$,
      $e$        case when target_sort = 'customer:desc' then lead_row.customer_name end desc nulls last,
        case when target_sort = 'followup:asc' then lead_row.next_followup_at end asc nulls last,
        lead_row.id desc$e$,
      1
    );
    definition := pg_temp.lead_sort_edit(
      definition,
      $e$          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          id desc$e$,
      $e$          case when target_sort = 'customer:desc' then customer_name end desc nulls last,
          case when target_sort = 'followup:asc' then next_followup_at end asc nulls last,
          id desc$e$,
      1
    );
  if (length(definition) - length(replace(definition, 'followup:asc', ''))) / length('followup:asc') <> 3 then
    raise exception 'LEAD_FOLLOWUP_SORT_PATCH_INCOMPLETE';
  end if;
  execute definition;
end;
$patch$;

drop function pg_temp.lead_sort_edit(text, text, text, integer);

notify pgrst, 'reload schema';
commit;
