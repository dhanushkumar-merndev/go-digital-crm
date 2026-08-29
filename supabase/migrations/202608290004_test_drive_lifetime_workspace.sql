-- Test Drives use the same work-queue language as Follow-ups; the operational
-- tabs are intentionally separate from an All tab that exposes the full,
-- lifetime history. The two existing list implementations are retained (the
-- Sales Consultant hot path and the scoped legacy path); patching their stored
-- definitions here preserves their existing authorization and query plans.

do $$
declare
  definition text;
begin
  select pg_get_functiondef(
    'app_private.get_sales_consultant_test_drive_workspace_page(uuid,uuid,uuid[],boolean,boolean,text,text,text,date,date,integer,integer,text,text)'::regprocedure
  ) into definition;

  if position('not in (''TODAY'', ''UPCOMING'', ''ACTIVE'', ''COMPLETED'', ''CANCELLED'')' in definition) = 0
    or definition !~ $pattern$when 'CANCELLED' then drive_row\.status = 'CANCELLED'[[:space:]]+else false$pattern$
  then
    raise exception 'TEST_DRIVE_WORKSPACE_SOURCE_UNEXPECTED';
  end if;

  definition := replace(
    definition,
    'not in (''TODAY'', ''UPCOMING'', ''ACTIVE'', ''COMPLETED'', ''CANCELLED'')',
    'not in (''ALL'', ''TODAY'', ''UPCOMING'', ''ACTIVE'', ''COMPLETED'', ''CANCELLED'')'
  );
  definition := regexp_replace(
    definition,
    $pattern$when 'CANCELLED' then drive_row\.status = 'CANCELLED'[[:space:]]+else false$pattern$,
    $replacement$when 'CANCELLED' then drive_row.status = 'CANCELLED'
        when 'ALL' then true
        else false$replacement$
  );
  definition := replace(
    definition,
    $needle$select
        count(*) filter ($needle$,
    $replacement$select
        count(*)::bigint as total,
        count(*) filter ($replacement$
  );
  definition := replace(
    definition,
    $needle$count(*) filter (where status = 'ACTIVE')::bigint as active,
        count(*) filter (
          where status = 'COMPLETED'$needle$,
    $replacement$count(*) filter (where status = 'ACTIVE')::bigint as active,
        count(*) filter (where status = 'COMPLETED')::bigint as completed,
        count(*) filter (
          where status = 'COMPLETED'$replacement$
  );
  definition := replace(
    definition,
    $needle$'kpis', jsonb_build_object(
        'today',$needle$,
    $replacement$'kpis', jsonb_build_object(
        'total', (select total from test_drive_authorized_stats),
        'today',$replacement$
  );
  definition := replace(
    definition,
    $needle$'active', (select active from test_drive_authorized_stats),
        'completed_this_month',$needle$,
    $replacement$'active', (select active from test_drive_authorized_stats),
        'completed', (select completed from test_drive_authorized_stats),
        'completed_this_month',$replacement$
  );
  execute definition;

  select pg_get_functiondef(
    'public.get_test_drive_workspace_page_legacy(text,text,text,date,date,integer,integer,text,text)'::regprocedure
  ) into definition;

  if position('not in (''TODAY'', ''UPCOMING'', ''ACTIVE'', ''COMPLETED'', ''CANCELLED'')' in definition) = 0
    or definition !~ $pattern$when 'CANCELLED' then authorized_row\.status = 'CANCELLED'[[:space:]]+else false$pattern$
  then
    raise exception 'TEST_DRIVE_WORKSPACE_LEGACY_SOURCE_UNEXPECTED';
  end if;

  definition := replace(
    definition,
    'not in (''TODAY'', ''UPCOMING'', ''ACTIVE'', ''COMPLETED'', ''CANCELLED'')',
    'not in (''ALL'', ''TODAY'', ''UPCOMING'', ''ACTIVE'', ''COMPLETED'', ''CANCELLED'')'
  );
  definition := regexp_replace(
    definition,
    $pattern$when 'CANCELLED' then authorized_row\.status = 'CANCELLED'[[:space:]]+else false$pattern$,
    $replacement$when 'CANCELLED' then authorized_row.status = 'CANCELLED'
      when 'ALL' then true
      else false$replacement$
  );
  definition := replace(
    definition,
    $needle$'kpis', jsonb_build_object(
      'today',$needle$,
    $replacement$'kpis', jsonb_build_object(
      'total', (select count(*) from authorized),
      'today',$replacement$
  );
  definition := replace(
    definition,
    $needle$'active', (select count(*) from authorized where status = 'ACTIVE'),
      'completed_this_month',$needle$,
    $replacement$'active', (select count(*) from authorized where status = 'ACTIVE'),
      'completed', (select count(*) from authorized where status = 'COMPLETED'),
      'completed_this_month',$replacement$
  );
  execute definition;
end;
$$;
