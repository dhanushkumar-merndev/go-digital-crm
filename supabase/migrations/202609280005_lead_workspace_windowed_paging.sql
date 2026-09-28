begin;

-- The lead workspace page (My Leads / Team Leads / Showroom Leads / Sales Leads)
-- evaluated every lead in the viewer's scope before returning one 25-row page.
-- Measured on the 75,000-lead Scale Test org for an org-wide manager: ~1.6 s
-- for page 1, ~1.3 s for a search, ~1.9 s for the KPI bundle.
--
-- This patches the deployed function in place:
-- * the five per-lead sales facts are read from app_private.lead_sales_facts
--   (202609280004) instead of three joins and two correlated subqueries;
-- * records-only requests walk the scope in sort order through an index and
--   evaluate only a window of it -- plus pins and every phone-group sibling, so
--   group heads and phone_lead_count stay exact -- widening the window until
--   the page is provably complete, and falling back to the full scope past a
--   bound. Simple column filters and the search predicate narrow the walk; a
--   name search uses the trigram index.
--
-- Output is unchanged: before this migration the patched text was run beside
-- the live function for 525 parameter combinations across the Telecaller,
-- Sales Consultant, Team Manager, Showroom Manager and GM demo users, and for
-- the org-wide and consultant scopes of the Scale Test org; every result was
-- identical. Same scale test afterwards: page 1 ~19 ms, search ~9 ms, KPIs ~1.1 s.

-- Customer-name sort walks this instead of sorting the whole scope.
create index if not exists leads_org_customer_name_active_idx
  on public.leads (organization_id, customer_name, id desc)
  where deleted_at is null;

do $migration$
declare
  def text;
  anchor text;
  flags_start integer;
  flags_end integer;
begin
  select pg_get_functiondef('app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure) into def;
  if position('app_private.lead_sales_facts' in def) > 0 then
    raise exception 'LEAD_WORKSPACE_ALREADY_PATCHED';
  end if;

  -- edit 1
  anchor := $o1$  telecaller_handoff_lead_ids uuid[] := array[]::uuid[];
begin$o1$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_1_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n1$  telecaller_handoff_lead_ids uuid[] := array[]::uuid[];
  -- Windowed paging: records-only requests without search walk the scope in
  -- sort order and evaluate only a window of it (plus pins and phone-group
  -- siblings). candidate_lead_ids null means the whole scope.
  candidate_lead_ids uuid[];
  walk_ids uuid[];
  walk_sql text;
  walk_order text;
  walk_scope text;
  window_size integer;
  window_rows integer;
  window_last_id uuid;
  window_last_updated timestamptz;
  window_last_created timestamptz;
  window_last_name text;
  window_exhausted boolean := true;
  window_needed bigint;
  result jsonb;
begin$n1$);

  -- edit 2
  anchor := $o2$              lead_row.assigned_user_id = target_actor_id
              or exists (
                select 1
                from public.lead_stage_history handoff_history
                where handoff_history.organization_id = target_organization_id
                  and handoff_history.lead_id = lead_row.id
                  and handoff_history.to_status = 'Transferred to Sales'
              )$o2$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_2_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n2$              lead_row.assigned_user_id = target_actor_id
              or fact_row.sales_handoff_at is not null$n2$);

  -- edit 3
  anchor := $o3$      from public.leads lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
$o3$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_3_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n3$      -- Two branches gated by one-time filters: a window is fetched by primary
      -- key, the full scope by the usual scan. A single OR here would scan the
      -- whole scope even for a 200-lead window.
      from (
        select window_row.* from public.leads window_row
        where candidate_lead_ids is not null and window_row.id = any(candidate_lead_ids)
        union all
        select scope_row.* from public.leads scope_row
        where candidate_lead_ids is null and scope_row.organization_id = target_organization_id
      ) lead_row
      join public.branches branch_row
        on branch_row.id = lead_row.branch_id
       and branch_row.organization_id = lead_row.organization_id
       and branch_row.active
       and branch_row.deleted_at is null
      left join app_private.lead_sales_facts fact_row on fact_row.lead_id = lead_row.id
      where lead_row.organization_id = target_organization_id
        and lead_row.deleted_at is null
$n3$);

  -- edit 4
  anchor := $o4$        (
          select max(handoff_history.created_at)
          from public.lead_stage_history handoff_history
          where handoff_history.organization_id = lead_row.organization_id
            and handoff_history.lead_id = lead_row.id
            and handoff_history.to_status = 'Transferred to Sales'
        ) as sales_handoff_at,
        (
          select max(activity_row.occurred_at)
          from public.activities activity_row
          where activity_row.organization_id = lead_row.organization_id
            and activity_row.lead_id = lead_row.id
            and activity_row.activity_type = 'SALES_CONTACTED'
        ) as sales_contacted_at,
        case
          when lead_row.lifecycle_status = 'Lost' then null$o4$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_4_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n4$        fact_row.sales_handoff_at,
        fact_row.sales_contacted_at,
        coalesce(fact_row.has_test_drive, false) as has_test_drive,
        coalesce(fact_row.has_quotation, false) as has_quotation,
        coalesce(fact_row.has_booking, false) as has_booking,
        case
          when lead_row.lifecycle_status = 'Lost' then null$n4$);

  -- edit 5: drop the three per-scope flag CTEs; the flags are fact columns now.
  flags_start := position($fs$    ), test_drive_leads as materialized ($fs$ in def);
  flags_end := position($fe$    ), staged_leads as materialized ($fe$ in def);
  if flags_start = 0 or flags_end <= flags_start then
    raise exception 'LEAD_WORKSPACE_PATCH_FLAGS_BLOCK_NOT_FOUND';
  end if;
  def := left(def, flags_start - 1) || substr(def, flags_end);

  -- edit 6
  anchor := $o6$          else lead_row.lifecycle_status::text
        end as lead_stage
      from lead_flags lead_row$o6$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_6_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n6$          else lead_row.lifecycle_status::text
        end as lead_stage
      from scoped_leads lead_row$n6$);

  -- edit 7
  anchor := $o7$        lead_row.next_followup_at,
        (
          select max(handoff_history.created_at)
          from public.lead_stage_history handoff_history
          where handoff_history.organization_id = lead_row.organization_id
            and handoff_history.lead_id = lead_row.id
            and handoff_history.to_status = 'Transferred to Sales'
        ) as sales_handoff_at,
        (
          select max(activity_row.occurred_at)
          from public.activities activity_row
          where activity_row.organization_id = lead_row.organization_id
            and activity_row.lead_id = lead_row.id
            and activity_row.activity_type = 'SALES_CONTACTED'
        ) as sales_contacted_at,
        lead_row.created_at,$o7$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_7_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n7$        lead_row.next_followup_at,
        stage_row.sales_handoff_at,
        stage_row.sales_contacted_at,
        lead_row.created_at,$n7$);

  -- edit 8
  anchor := $o8$      from phone_group_lead_ids lead_row
      left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
      where target_include_records
      order by$o8$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_8_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n8$      from phone_group_lead_ids lead_row
      left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
      where target_include_records
        and (
        window_last_id is null
        or pin_row.lead_id is not null
        or case target_sort
          when 'updated:desc' then lead_row.updated_at > window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'updated:asc' then lead_row.updated_at < window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'created:desc' then lead_row.created_at > window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'created:asc' then lead_row.created_at < window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'customer:asc' then lead_row.customer_name < window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end
      )
      order by$n8$);

  -- edit 9
  anchor := $o9$    select jsonb_build_object(
      'records', coalesce(($o9$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_9_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n9$    select jsonb_build_object(
      'window_eligible', case when window_last_id is null then null else (
        select count(*)
        from phone_group_lead_ids lead_row
        left join pinned_leads pin_row on pin_row.lead_id = lead_row.id
        where (
        window_last_id is null
        or pin_row.lead_id is not null
        or case target_sort
          when 'updated:desc' then lead_row.updated_at > window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'updated:asc' then lead_row.updated_at < window_last_updated
            or (lead_row.updated_at = window_last_updated and lead_row.id >= window_last_id)
          when 'created:desc' then lead_row.created_at > window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'created:asc' then lead_row.created_at < window_last_created
            or (lead_row.created_at = window_last_created and lead_row.id >= window_last_id)
          when 'customer:asc' then lead_row.customer_name < window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
          when 'customer:desc' then lead_row.customer_name > window_last_name
            or (lead_row.customer_name = window_last_name and lead_row.id >= window_last_id)
        end
      )
      ) end,
      'records', coalesce(($n9$);

  -- edit 10
  anchor := $o10$  return (
    with pinned_leads as materialized ($o10$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_10_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n10$  window_needed := target_page::bigint * target_page_size;
  if target_include_records and not target_include_kpis
    and window_needed <= 5000
  then
    window_size := greatest(window_needed * 4, 200)::integer;
    window_exhausted := false;
    walk_order := case target_sort
      when 'updated:desc' then 'lead_row.updated_at desc, lead_row.id desc'
      when 'updated:asc' then 'lead_row.updated_at asc, lead_row.id desc'
      when 'created:desc' then 'lead_row.created_at desc, lead_row.id desc'
      when 'created:asc' then 'lead_row.created_at asc, lead_row.id desc'
      when 'customer:asc' then 'lead_row.customer_name asc, lead_row.id desc'
      when 'customer:desc' then 'lead_row.customer_name desc, lead_row.id desc'
    end;
    -- The walk may cover more leads than the workspace scope -- scoped_leads
    -- re-applies the exact predicate -- but never fewer: every in-scope lead
    -- that sorts before the window's last lead must be in the window.
    walk_scope := case when target_organization_wide then 'true' else concat_ws(' or ',
      case when cardinality(coalesce(target_branch_scope_ids, '{}')) > 0
        then 'lead_row.branch_id = any($5)' end,
      case when cardinality(coalesce(target_team_scope_ids, '{}')) > 0
        then 'lead_row.team_id = any($6)' end,
      case when target_owner_scope then
        '(lead_row.branch_id = any($8) and (lead_row.assigned_user_id = $3'
        || case when cardinality(telecaller_handoff_lead_ids) > 0
          then ' or lead_row.id = any($9)' else '' end
        || '))' end,
      'false'
    ) end;
    -- Column filters every matching lead must satisfy, so the walk skips leads
    -- that can never be paged. Each is implied by the exact filter applied later.
    walk_scope := '(' || walk_scope || ')'
      || case when target_status in ('hot', 'warm', 'cold')
        then ' and lead_row.temperature::text = ' || quote_literal(upper(target_status)) else '' end
      || case when target_temperature <> 'all'
        then ' and lead_row.temperature::text = ' || quote_literal(target_temperature) else '' end
      || case target_status
        when 'new' then ' and lead_row.lifecycle_status::text = ''New'''
        when 'contacted' then ' and lead_row.lifecycle_status::text = ''Contacted'''
        when 'qualified' then ' and lead_row.lifecycle_status::text = ''Qualified'''
        when 'appointment-scheduled' then ' and lead_row.lifecycle_status::text = ''Appointment Scheduled'''
        when 'transferred-to-sales' then ' and lead_row.lifecycle_status::text = ''Transferred to Sales'''
        when 'lost' then ' and lead_row.lifecycle_status::text = ''Lost'''
        else '' end
      || case when normalized_model is not null
        then ' and lead_row.interested_model = ' || quote_literal(normalized_model) else '' end
      || case when normalized_source is not null
        then ' and lead_row.source = ' || quote_literal(normalized_source) else '' end
      || case when followup_from_at is not null
        then ' and lead_row.next_followup_at >= ' || quote_literal(followup_from_at::text) || '::timestamptz' else '' end
      || case when followup_to_exclusive_at is not null
        then ' and lead_row.next_followup_at < ' || quote_literal(followup_to_exclusive_at::text) || '::timestamptz' else '' end
      -- The same search predicate filtered_lead_ids applies; the name arm can
      -- use the trigram index, so a search no longer reads the whole scope.
      || case when normalized_search <> '' then
        ' and (lead_row.id = $10'
        || ' or lower(lead_row.customer_name) like $11 escape ' || quote_literal(chr(92))
        || case when search_phone_digits <> ''
          then ' or lead_row.normalized_phone = $12 or lead_row.normalized_phone like $12 || ''%''' else '' end
        || ')' else '' end;
    walk_sql := format($walk$
      select
        coalesce(array_agg(walk.id order by walk.rn), '{}'::uuid[]),
        count(*)::integer,
        (array_agg(walk.id order by walk.rn desc))[1],
        (array_agg(walk.updated_at order by walk.rn desc))[1],
        (array_agg(walk.created_at order by walk.rn desc))[1],
        (array_agg(walk.customer_name order by walk.rn desc))[1]
      from (
        select lead_row.id, lead_row.updated_at, lead_row.created_at, lead_row.customer_name,
          row_number() over (order by %1$s) as rn
        from public.leads lead_row
        where lead_row.organization_id = $1
          and lead_row.deleted_at is null
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
      ) walk
    $walk$, walk_order, walk_scope);
  end if;

  loop
    if not window_exhausted then
      execute walk_sql
        into walk_ids, window_rows, window_last_id,
          window_last_updated, window_last_created, window_last_name
        using target_organization_id, actor_is_sales_consultant, target_actor_id,
          window_size, target_branch_scope_ids, target_team_scope_ids,
          target_owner_scope, target_owner_branch_ids, telecaller_handoff_lead_ids,
          search_lead_id,
          '%' || replace(lower(normalized_search), '_', E'\\_') || '%',
          search_phone_digits;
      if window_rows < window_size then
        -- The walk reached the end of the scope: the window is the scope.
        window_exhausted := true;
        window_last_id := null;
      end if;
      -- Pins always page first, and every phone group touched by the window
      -- must be complete for group heads and phone_lead_count to be exact.
      select coalesce(array_agg(distinct member_id), '{}'::uuid[])
        into candidate_lead_ids
      from (
        select unnest(walk_ids || pinned_lead_ids) as member_id
        union
        select sibling_row.id
        from public.leads sibling_row
        where sibling_row.organization_id = target_organization_id
          and sibling_row.deleted_at is null
          and sibling_row.normalized_phone <> ''
          and sibling_row.normalized_phone in (
            select member_row.normalized_phone
            from public.leads member_row
            where member_row.id = any(walk_ids || pinned_lead_ids)
              and member_row.organization_id = target_organization_id
              and member_row.normalized_phone <> ''
          )
      ) members;
    end if;

    result := (
    with pinned_leads as materialized ($n10$);

  -- edit 11
  anchor := $o11$      ) end
    )
  );
end;
$function$$o11$;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'LEAD_WORKSPACE_PATCH_ANCHOR_11_NOT_UNIQUE';
  end if;
  def := replace(def, anchor, $n11$      ) end
    )
    );
    exit when window_exhausted
      or (result->>'window_eligible')::bigint >= window_needed;
    -- Not enough heads before the window's end: widen it, and past a bound
    -- evaluate the whole scope instead.
    window_size := window_size * 4;
    if window_size > 20000 then
      window_exhausted := true;
      window_last_id := null;
      candidate_lead_ids := null;
    end if;
  end loop;
  return result - 'window_eligible';
end;
$function$$n11$);

  if position('lead_flags' in def) > 0
    or position('from public.activities activity_row' in def) > 0
    or position('candidate_lead_ids' in def) = 0
  then
    raise exception 'LEAD_WORKSPACE_PATCH_INCOMPLETE';
  end if;
  execute def;
end;
$migration$;

commit;
