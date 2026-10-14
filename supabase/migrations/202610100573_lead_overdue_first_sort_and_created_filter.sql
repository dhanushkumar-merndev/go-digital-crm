begin;

-- Two changes to the lead list, both asked for on the My Leads page.
--
-- 1. Overdue first. A lead whose follow-up is already due, and that is not
--    Lost, now sits above every other lead on every tab. Three sorts do it:
--      overdue:asc    overdue block, most overdue first; then latest activity
--      overdue:desc   overdue block, most recently missed first; then latest activity
--      followup:desc  overdue block, then the upcoming ones, both latest due first
--    (`followup:asc` already reads that way: the earliest due time is the most
--    overdue.) "Overdue" is decided against one query_now, in the windowed walk
--    and in the page alike, so the two can never disagree about a lead.
--
-- 2. Created date. `target_created_from` / `target_created_to` filter on the
--    Asia/Kolkata calendar day the lead was created, the same way the follow-up
--    date range does. Counters and tab badges are unaffected, as for every filter.
--
-- The functions are patched from their deployed text. Every edit states how
-- often its anchor must occur, so a moved anchor fails instead of no-opping.
-- The new arguments create a second overload; the old one is dropped and its
-- grants are re-applied.
create function pg_temp.patch_lead_list_function(
  target regprocedure,
  edits text[],
  grant_to text[]
)
returns void
language plpgsql
as $helper$
declare
  definition text := pg_get_functiondef(target);
  old_identity text := target::text;
  function_schema text;
  function_name text;
  existing_oids oid[];
  created_oids oid[];
  new_target regprocedure;
  occurrences integer;
  i integer;
begin
  select n.nspname, p.proname into function_schema, function_name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.oid = target;

  if cardinality(edits) % 3 <> 0 then
    raise exception 'PATCH_EDITS_MALFORMED for %', old_identity;
  end if;
  for i in 0 .. cardinality(edits) / 3 - 1 loop
    occurrences := (char_length(definition) - char_length(replace(definition, edits[i * 3 + 1], '')))
      / char_length(edits[i * 3 + 1]);
    if occurrences <> edits[i * 3 + 3]::integer then
      raise exception 'PATCH_ANCHOR_COUNT for % edit %: expected %, found %',
        old_identity, i + 1, edits[i * 3 + 3], occurrences;
    end if;
    definition := replace(definition, edits[i * 3 + 1], edits[i * 3 + 2]);
  end loop;
  select array_agg(p.oid) into existing_oids
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = function_schema and p.proname = function_name;
  execute definition;

  select coalesce(array_agg(p.oid), '{}') into created_oids
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = function_schema and p.proname = function_name
    and p.oid <> all(existing_oids);
  if cardinality(created_oids) <> 1 then
    raise exception 'PATCH_EXPECTED_ONE_NEW_OVERLOAD for %', old_identity;
  end if;
  new_target := created_oids[1]::regprocedure;
  for i in 0 .. cardinality(edits) / 3 - 1 loop
    if position(edits[i * 3 + 2] in pg_get_functiondef(new_target)) = 0 then
      raise exception 'PATCH_NOT_APPLIED for % edit %', old_identity, i + 1;
    end if;
  end loop;

  execute format('drop function %s', old_identity);
  execute format('revoke all on function %s from public, anon, authenticated', new_target);
  if cardinality(grant_to) > 0 then
    execute format('grant execute on function %s to %s', new_target, array_to_string(grant_to, ', '));
  end if;
end;
$helper$;

-- Lead list, sales roles.
select pg_temp.patch_lead_list_function(
  'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean,text)',
  array[
    $o$target_include_kpis boolean DEFAULT true, target_buyer_type text DEFAULT 'all'::text)$o$,
    $n$target_include_kpis boolean DEFAULT true, target_buyer_type text DEFAULT 'all'::text, target_created_from date DEFAULT NULL::date, target_created_to date DEFAULT NULL::date)$n$,
    '1',

    $o$  followup_to_exclusive_at timestamptz;
$o$,
    $n$  followup_to_exclusive_at timestamptz;
  created_from_at timestamptz;
  created_to_exclusive_at timestamptz;
$n$,
    '1',

    $o$  window_last_followup timestamptz;
$o$,
    $n$  window_last_followup timestamptz;
  window_last_tier integer;
  -- Sorts that keep overdue follow-ups above every other lead.
  overdue_first boolean := coalesce(
    target_sort in ('overdue:asc', 'overdue:desc', 'followup:desc'),
    false
  );
$n$,
    '1',

    $o$      'customer:asc', 'customer:desc', 'followup:asc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)$o$,
    $n$      'customer:asc', 'customer:desc', 'followup:asc', 'followup:desc',
      'overdue:asc', 'overdue:desc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)
    or (target_created_from is not null and target_created_to is not null
      and target_created_from > target_created_to)$n$,
    '1',

    $o$      (target_followup_to + 1)::timestamp
    );
  end if;
$o$,
    $n$      (target_followup_to + 1)::timestamp
    );
  end if;
  if target_created_from is not null then
    created_from_at := pg_catalog.timezone(
      'Asia/Kolkata',
      target_created_from::timestamp
    );
  end if;
  if target_created_to is not null then
    created_to_exclusive_at := pg_catalog.timezone(
      'Asia/Kolkata',
      (target_created_to + 1)::timestamp
    );
  end if;
$n$,
    '1',

    $o$    and (target_sort <> 'followup:asc' or target_status = 'follow-up')$o$,
    $n$    and (target_sort not in ('followup:asc', 'followup:desc') or target_status = 'follow-up')$n$,
    '1',

    $o$      when 'followup:asc' then 'lead_row.next_followup_at asc, lead_row.id desc'
    end;$o$,
    $n$      when 'followup:asc' then 'lead_row.next_followup_at asc, lead_row.id desc'
      -- Overdue-first sorts: the order of the leads below the overdue block.
      when 'followup:desc' then 'lead_row.next_followup_at desc, lead_row.id desc'
      when 'overdue:asc' then 'lead_row.updated_at desc, lead_row.id desc'
      when 'overdue:desc' then 'lead_row.updated_at desc, lead_row.id desc'
    end;$n$,
    '1',

    $o$        then ' and lead_row.next_followup_at < ' || quote_literal(followup_to_exclusive_at::text) || '::timestamptz' else '' end
$o$,
    $n$        then ' and lead_row.next_followup_at < ' || quote_literal(followup_to_exclusive_at::text) || '::timestamptz' else '' end
      || case when created_from_at is not null
        then ' and lead_row.created_at >= ' || quote_literal(created_from_at::text) || '::timestamptz' else '' end
      || case when created_to_exclusive_at is not null
        then ' and lead_row.created_at < ' || quote_literal(created_to_exclusive_at::text) || '::timestamptz' else '' end
$n$,
    '1',

    $o$        (array_agg(walk.next_followup_at order by walk.rn desc))[1]
      from ($o$,
    $n$        (array_agg(walk.next_followup_at order by walk.rn desc))[1],
        null::integer
      from ($n$,
    '1',

    $o$    $walk$, walk_order, walk_scope);
  end if;$o$,
    $n$    $walk$, walk_order, walk_scope);
    if overdue_first then
      -- Two index-ordered branches -- overdue follow-ups by due time, then every
      -- other lead in its usual order -- merged with the overdue block first.
      -- $13 is query_now, so the walk and the page agree on what is overdue.
      walk_sql := format($tier$
        select
          coalesce(array_agg(walk.id order by walk.tier, walk.rn), '{}'::uuid[]),
          count(*)::integer,
          (array_agg(walk.id order by walk.tier desc, walk.rn desc))[1],
          (array_agg(walk.updated_at order by walk.tier desc, walk.rn desc))[1],
          (array_agg(walk.created_at order by walk.tier desc, walk.rn desc))[1],
          (array_agg(walk.customer_name order by walk.tier desc, walk.rn desc))[1],
          (array_agg(walk.next_followup_at order by walk.tier desc, walk.rn desc))[1],
          (array_agg(walk.tier order by walk.tier desc, walk.rn desc))[1]
        from (
          select both_tiers.*
          from (
            (
              select lead_row.id, lead_row.updated_at, lead_row.created_at,
                lead_row.customer_name, lead_row.next_followup_at, 0 as tier,
                row_number() over (order by %3$s) as rn
              from public.leads lead_row
              where lead_row.organization_id = $1
                and lead_row.deleted_at is null
                and lead_row.next_followup_at < $13
                and lead_row.lifecycle_status <> 'Lost'
                and (%2$s)
                and (
                  not $2
                  or (
                    lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
                    and (
                      lead_row.assigned_user_id = $3
                      or exists (
                        select 1 from app_private.lead_sales_facts fact_row
                        where fact_row.lead_id = lead_row.id
                          and fact_row.sales_handoff_at is not null
                      )
                    )
                  )
                )
              order by %3$s
              limit $4
            )
            union all
            (
              select lead_row.id, lead_row.updated_at, lead_row.created_at,
                lead_row.customer_name, lead_row.next_followup_at, 1 as tier,
                row_number() over (order by %1$s) as rn
              from public.leads lead_row
              where lead_row.organization_id = $1
                and lead_row.deleted_at is null
                and (
                  lead_row.next_followup_at is null
                  or lead_row.next_followup_at >= $13
                  or lead_row.lifecycle_status = 'Lost'
                )
                and (%2$s)
                and (
                  not $2
                  or (
                    lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
                    and (
                      lead_row.assigned_user_id = $3
                      or exists (
                        select 1 from app_private.lead_sales_facts fact_row
                        where fact_row.lead_id = lead_row.id
                          and fact_row.sales_handoff_at is not null
                      )
                    )
                  )
                )
              order by %1$s
              limit $4
            )
          ) both_tiers
          order by both_tiers.tier, both_tiers.rn
          limit $4
        ) walk
      $tier$, walk_order, walk_scope,
        'lead_row.next_followup_at '
          || case when target_sort = 'overdue:asc' then 'asc' else 'desc' end
          || ', lead_row.id desc');
    end if;
  end if;$n$,
    '1',

    $o$          window_last_followup
        using$o$,
    $n$          window_last_followup, window_last_tier
        using$n$,
    '1',

    $o$          search_phone_digits;
      if window_rows < window_size then$o$,
    $n$          search_phone_digits,
          query_now;
      if window_rows < window_size then$n$,
    '1',

    $o$        lead_row.lifecycle_status,
        lead_row.next_followup_at
      from staged_leads lead_row$o$,
    $n$        lead_row.lifecycle_status,
        lead_row.next_followup_at,
        -- 0 = follow-up already due on a lead that is still open, 1 = everything else.
        case when lead_row.next_followup_at < query_now
          and lead_row.lifecycle_status <> 'Lost' then 0 else 1 end as overdue_tier
      from staged_leads lead_row$n$,
    '1',

    $o$      and (followup_from_at is null or lead_row.next_followup_at >= followup_from_at)
$o$,
    $n$      and (created_from_at is null or lead_row.created_at >= created_from_at)
      and (created_to_exclusive_at is null or lead_row.created_at < created_to_exclusive_at)
      and (followup_from_at is null or lead_row.next_followup_at >= followup_from_at)
$n$,
    '1',

    $o$        lead_row.lifecycle_status,
        lead_row.next_followup_at
      from filtered_lead_ids lead_row$o$,
    $n$        lead_row.lifecycle_status,
        lead_row.next_followup_at,
        lead_row.overdue_tier
      from filtered_lead_ids lead_row$n$,
    '1',

    $o$          when 'followup:asc' then lead_row.next_followup_at < window_last_followup
            or (lead_row.next_followup_at = window_last_followup and lead_row.id >= window_last_id)
        end$o$,
    $n$          when 'followup:asc' then lead_row.next_followup_at < window_last_followup
            or (lead_row.next_followup_at = window_last_followup and lead_row.id >= window_last_id)
          when 'followup:desc' then lead_row.overdue_tier < window_last_tier
            or (lead_row.overdue_tier = window_last_tier and (
              lead_row.next_followup_at > window_last_followup
              or (lead_row.next_followup_at = window_last_followup and lead_row.id >= window_last_id)
            ))
          when 'overdue:asc' then lead_row.overdue_tier < window_last_tier
            or (lead_row.overdue_tier = window_last_tier and case lead_row.overdue_tier
              when 0 then lead_row.next_followup_at < window_last_followup
                or (lead_row.next_followup_at = window_last_followup and lead_row.id >= window_last_id)
              else lead_row.updated_at > window_last_updated
                or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
            end)
          when 'overdue:desc' then lead_row.overdue_tier < window_last_tier
            or (lead_row.overdue_tier = window_last_tier and case lead_row.overdue_tier
              when 0 then lead_row.next_followup_at > window_last_followup
                or (lead_row.next_followup_at = window_last_followup and lead_row.id >= window_last_id)
              else lead_row.updated_at > window_last_updated
                or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
            end)
        end$n$,
    '2',

    $o$        pin_row.pin_rank asc nulls last,
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,$o$,
    $n$        pin_row.pin_rank asc nulls last,
        case when overdue_first then lead_row.overdue_tier end asc nulls last,
        case when target_sort = 'overdue:asc' and lead_row.overdue_tier = 0
          then lead_row.next_followup_at end asc nulls last,
        case when target_sort = 'followup:desc'
          or (target_sort = 'overdue:desc' and lead_row.overdue_tier = 0)
          then lead_row.next_followup_at end desc nulls last,
        case when target_sort in ('overdue:asc', 'overdue:desc') and lead_row.overdue_tier = 1
          then lead_row.updated_at end desc nulls last,
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,$n$,
    '1',

    $o$            asc nulls last,
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,$o$,
    $n$            asc nulls last,
          case when overdue_first then
            case when next_followup_at < query_now and lifecycle_status <> 'Lost' then 0 else 1 end
          end asc nulls last,
          case when target_sort = 'overdue:asc'
            and next_followup_at < query_now and lifecycle_status <> 'Lost'
            then next_followup_at end asc nulls last,
          case when target_sort = 'followup:desc'
            or (target_sort = 'overdue:desc'
              and next_followup_at < query_now and lifecycle_status <> 'Lost')
            then next_followup_at end desc nulls last,
          case when target_sort in ('overdue:asc', 'overdue:desc')
            and not coalesce(next_followup_at < query_now and lifecycle_status <> 'Lost', false)
            then updated_at end desc nulls last,
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,$n$,
    '1'
  ],
  array[]::text[]
);

-- Lead list, every other role.
select pg_temp.patch_lead_list_function(
  'public.get_lead_workspace_page_v2_legacy(integer,integer,text,text,text,text,text,text,text,date,date,text)',
  array[
    $o$target_followup_to date DEFAULT NULL::date, target_buyer_type text DEFAULT 'all'::text)$o$,
    $n$target_followup_to date DEFAULT NULL::date, target_buyer_type text DEFAULT 'all'::text, target_created_from date DEFAULT NULL::date, target_created_to date DEFAULT NULL::date)$n$,
    '1',

    $o$      'customer:asc', 'customer:desc', 'followup:asc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)$o$,
    $n$      'customer:asc', 'customer:desc', 'followup:asc', 'followup:desc',
      'overdue:asc', 'overdue:desc'
    )
    or (target_followup_from is not null and target_followup_to is not null
      and target_followup_from > target_followup_to)
    or (target_created_from is not null and target_created_to is not null
      and target_created_from > target_created_to)$n$,
    '1',

    $o$      and (
        target_followup_from is null
$o$,
    $n$      and (
        target_created_from is null
        or (lead_row.created_at at time zone 'Asia/Kolkata')::date >= target_created_from
      )
      and (
        target_created_to is null
        or (lead_row.created_at at time zone 'Asia/Kolkata')::date <= target_created_to
      )
      and (
        target_followup_from is null
$n$,
    '1',

    $o$      order by
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,$o$,
    $n$      order by
        case when target_sort in ('overdue:asc', 'overdue:desc', 'followup:desc')
          then case when lead_row.next_followup_at < now() and lead_row.lifecycle_status <> 'Lost' then 0 else 1 end end asc nulls last,
        case when target_sort = 'overdue:asc' and case when lead_row.next_followup_at < now() and lead_row.lifecycle_status <> 'Lost' then 0 else 1 end = 0
          then lead_row.next_followup_at end asc nulls last,
        case when target_sort = 'followup:desc'
          or (target_sort = 'overdue:desc' and case when lead_row.next_followup_at < now() and lead_row.lifecycle_status <> 'Lost' then 0 else 1 end = 0)
          then lead_row.next_followup_at end desc nulls last,
        case when target_sort in ('overdue:asc', 'overdue:desc') and case when lead_row.next_followup_at < now() and lead_row.lifecycle_status <> 'Lost' then 0 else 1 end = 1
          then lead_row.updated_at end desc nulls last,
        case when target_sort = 'updated:asc' then lead_row.updated_at end asc nulls last,$n$,
    '1',

    $o$        ) order by
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,$o$,
    $n$        ) order by
          case when target_sort in ('overdue:asc', 'overdue:desc', 'followup:desc')
            then case when next_followup_at < now() and lifecycle_status <> 'Lost' then 0 else 1 end end asc nulls last,
          case when target_sort = 'overdue:asc' and case when next_followup_at < now() and lifecycle_status <> 'Lost' then 0 else 1 end = 0
            then next_followup_at end asc nulls last,
          case when target_sort = 'followup:desc'
            or (target_sort = 'overdue:desc' and case when next_followup_at < now() and lifecycle_status <> 'Lost' then 0 else 1 end = 0)
            then next_followup_at end desc nulls last,
          case when target_sort in ('overdue:asc', 'overdue:desc') and case when next_followup_at < now() and lifecycle_status <> 'Lost' then 0 else 1 end = 1
            then updated_at end desc nulls last,
          case when target_sort = 'updated:asc' then updated_at end asc nulls last,$n$,
    '1'
  ],
  array['authenticated', 'service_role']::text[]
);

-- Lead list, public router. Patched last: it calls the two above by argument position.
select pg_temp.patch_lead_list_function(
  'public.get_lead_workspace_page_v2(integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean,text)',
  array[
    $o$target_include_kpis boolean DEFAULT true, target_buyer_type text DEFAULT 'all'::text)$o$,
    $n$target_include_kpis boolean DEFAULT true, target_buyer_type text DEFAULT 'all'::text, target_created_from date DEFAULT NULL::date, target_created_to date DEFAULT NULL::date)$n$,
    '1',

    $o$      target_include_kpis,
      target_buyer_type
    );$o$,
    $n$      target_include_kpis,
      target_buyer_type,
      target_created_from,
      target_created_to
    );$n$,
    '1',

    $o$    target_followup_to,
    target_buyer_type
  );$o$,
    $n$    target_followup_to,
    target_buyer_type,
    target_created_from,
    target_created_to
  );$n$,
    '1'
  ],
  array['authenticated', 'service_role']::text[]
);

drop function pg_temp.patch_lead_list_function(regprocedure, text[], text[]);

notify pgrst, 'reload schema';
commit;
