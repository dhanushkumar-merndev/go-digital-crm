-- Owner-facing AI usage is an evidence view, not a synthetic recommendation engine.

create index if not exists credit_ledger_owner_ai_usage_idx
  on public.credit_ledger (organization_id, created_at desc, id)
  where ledger_kind = 'AI';
create index if not exists ai_call_summaries_owner_recent_idx
  on public.ai_call_summaries (organization_id, created_at desc, id);
create index if not exists ai_extraction_runs_owner_recent_idx
  on public.ai_extraction_runs (organization_id, created_at desc, id);

create or replace function public.get_owner_ai_business_summary(target_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  range_start date;
begin
  if target_days not in (7, 30, 90) then
    raise exception using errcode = '22023', message = 'INVALID_OWNER_AI_SUMMARY_PERIOD';
  end if;
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'credit.allocate')
  then
    raise exception using errcode = '42501', message = 'OWNER_AI_SUMMARY_PERMISSION_REQUIRED';
  end if;
  range_start := timezone('Asia/Kolkata', now())::date - (target_days - 1);

  return (
    with usage_rows as materialized (
      select ledger_row.*
      from public.credit_ledger ledger_row
      where ledger_row.organization_id = current_organization_id
        and ledger_row.ledger_kind = 'AI'
    ), daily_usage as materialized (
      select
        timezone('Asia/Kolkata', usage_row.created_at)::date as usage_date,
        coalesce(sum(-usage_row.amount) filter (where usage_row.transaction_type = 'CONSUMPTION'), 0)::bigint as credits_used
      from usage_rows usage_row
      where timezone('Asia/Kolkata', usage_row.created_at)::date >= range_start
      group by timezone('Asia/Kolkata', usage_row.created_at)::date
    ), feature_usage as materialized (
      select
        coalesce(nullif(usage_row.feature, ''), 'Unspecified') as feature,
        coalesce(sum(-usage_row.amount) filter (where usage_row.transaction_type = 'CONSUMPTION'), 0)::bigint as credits_used
      from usage_rows usage_row
      where timezone('Asia/Kolkata', usage_row.created_at)::date >= range_start
      group by coalesce(nullif(usage_row.feature, ''), 'Unspecified')
      having coalesce(sum(-usage_row.amount) filter (where usage_row.transaction_type = 'CONSUMPTION'), 0) > 0
    )
    select jsonb_build_object(
      'period_days', target_days,
      'kpis', jsonb_build_object(
        'credits_used', coalesce((select sum(credits_used) from daily_usage), 0),
        'credits_remaining', coalesce((select sum(amount) from usage_rows), 0),
        'summaries_generated', (select count(*) from public.ai_call_summaries summary_row
          where summary_row.organization_id = current_organization_id
            and timezone('Asia/Kolkata', summary_row.created_at)::date >= range_start),
        'extractions_completed', (select count(*) from public.ai_extraction_runs extraction_row
          where extraction_row.organization_id = current_organization_id
            and extraction_row.status = 'COMPLETED'
            and timezone('Asia/Kolkata', extraction_row.created_at)::date >= range_start),
        'reviews_pending', (select count(*) from public.ai_field_reviews review_row
          join public.ai_extraction_runs extraction_row on extraction_row.id = review_row.extraction_run_id
          where review_row.organization_id = current_organization_id
            and extraction_row.organization_id = current_organization_id
            and review_row.decision = 'PENDING')
      ),
      'daily_usage', coalesce((select jsonb_agg(jsonb_build_object(
        'date', day_row.usage_date,
        'credits_used', coalesce(daily_usage.credits_used, 0)
      ) order by day_row.usage_date)
      from generate_series(range_start, timezone('Asia/Kolkata', now())::date, interval '1 day')
        as day_row(usage_date)
      left join daily_usage on daily_usage.usage_date = day_row.usage_date::date), '[]'::jsonb),
      'feature_usage', coalesce((select jsonb_agg(jsonb_build_object(
        'name', feature_usage.feature, 'value', feature_usage.credits_used
      ) order by feature_usage.credits_used desc, feature_usage.feature) from feature_usage), '[]'::jsonb),
      'recent_summaries', coalesce((select jsonb_agg(jsonb_build_object(
        'id', recent_row.id,
        'summary', left(recent_row.summary, 480),
        'created_at', recent_row.created_at,
        'model_reference', recent_row.model_reference
      ) order by recent_row.created_at desc, recent_row.id desc)
      from (
        select summary_row.*
        from public.ai_call_summaries summary_row
        where summary_row.organization_id = current_organization_id
        order by summary_row.created_at desc, summary_row.id desc
        limit 5
      ) recent_row), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_owner_ai_business_summary(integer) from public, anon;
grant execute on function public.get_owner_ai_business_summary(integer) to authenticated;
