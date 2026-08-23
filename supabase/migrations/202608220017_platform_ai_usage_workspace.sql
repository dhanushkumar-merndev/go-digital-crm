-- Platform-level AI credit analytics. Credit entries are immutable, so this
-- workspace only aggregates the ledger and never estimates unrecorded costs.

create index if not exists credit_ledger_ai_created_org_idx
  on public.credit_ledger (created_at desc, organization_id, feature)
  where ledger_kind = 'AI';

create or replace function public.get_platform_ai_usage_workspace(
  target_days integer default 7,
  target_page integer default 1,
  target_page_size integer default 25,
  target_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text;
  range_start timestamptz;
  result jsonb;
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_AI_USAGE_ACCESS_REQUIRED';
  end if;
  if target_days not in (7, 14, 30)
    or target_page < 1 or target_page > 100000
    or target_page_size not in (25, 50, 100)
  then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_AI_USAGE_QUERY';
  end if;
  normalized_search := nullif(left(btrim(coalesce(target_search, '')), 80), '');
  range_start := date_trunc('day', now()) - make_interval(days => target_days - 1);

  with period_ledger as materialized (
    select ledger_row.organization_id, ledger_row.feature, ledger_row.amount, ledger_row.created_at
    from public.credit_ledger ledger_row
    where ledger_row.ledger_kind = 'AI'
      and ledger_row.created_at >= range_start
  ), filtered_organizations as materialized (
    select organization_row.id, organization_row.name
    from public.organizations organization_row
    where organization_row.deleted_at is null
      and (normalized_search is null or organization_row.name ilike '%' || normalized_search || '%')
  ), paged_organizations as materialized (
    select organization_row.*
    from filtered_organizations organization_row
    order by organization_row.name, organization_row.id
    limit target_page_size offset ((target_page - 1) * target_page_size)
  )
  select jsonb_build_object(
    'days', target_days,
    'total', (select count(*) from filtered_organizations),
    'kpis', jsonb_build_object(
      'used_period', coalesce((select sum(-least(amount, 0)) from period_ledger), 0),
      'remaining', coalesce((select sum(amount) from public.credit_ledger where ledger_kind = 'AI'), 0),
      'allocated', coalesce((select sum(greatest(amount, 0)) from public.credit_ledger where ledger_kind = 'AI'), 0),
      'average_daily_usage', coalesce((select round(sum(-least(amount, 0))::numeric / target_days, 2) from period_ledger), 0)
    ),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'name', to_char(day_row.day, 'DD Mon'),
      'value', coalesce((select sum(-least(ledger_row.amount, 0)) from period_ledger ledger_row
        where ledger_row.created_at >= day_row.day and ledger_row.created_at < day_row.day + interval '1 day'), 0)
    ) order by day_row.day) from generate_series(range_start::date, current_date, interval '1 day') day_source(day)
      cross join lateral (select day_source.day::date as day) day_row), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(jsonb_build_object('name', feature_name, 'value', used)
      order by used desc, feature_name) from (
        select coalesce(nullif(btrim(ledger_row.feature), ''), 'Not specified') as feature_name,
          sum(-least(ledger_row.amount, 0))::bigint as used
        from period_ledger ledger_row
        group by 1 order by used desc, feature_name limit 8
      ) feature_row), '[]'::jsonb),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object(
      'id', organization_row.id,
      'name', organization_row.name,
      'used_period', coalesce((select sum(-least(ledger_row.amount, 0)) from period_ledger ledger_row
        where ledger_row.organization_id = organization_row.id), 0),
      'balance', coalesce((select sum(ledger_row.amount) from public.credit_ledger ledger_row
        where ledger_row.ledger_kind = 'AI' and ledger_row.organization_id = organization_row.id), 0),
      'daily_average', coalesce((select round(sum(-least(ledger_row.amount, 0))::numeric / target_days, 2)
        from period_ledger ledger_row where ledger_row.organization_id = organization_row.id), 0)
    ) order by organization_row.name, organization_row.id) from paged_organizations organization_row), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_platform_ai_usage_workspace(integer, integer, integer, text) from public, anon;
grant execute on function public.get_platform_ai_usage_workspace(integer, integer, integer, text) to authenticated;
