begin;

create or replace function public.get_sales_consultant_top_models(
  target_timezone text default 'Asia/Kolkata'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
begin
  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'organization_id' is null
    or access_context->>'role_key' <> 'sales-consultant'
  then
    raise exception using errcode = '42501', message = 'SALES_CONSULTANT_DASHBOARD_DENIED';
  end if;
  if target_timezone <> 'Asia/Kolkata' then
    raise exception using errcode = '22023', message = 'DASHBOARD_TIMEZONE_INVALID';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;

  return (
    with scoped_leads as (
      select lead_row.*
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and app_private.can_access_record(
          lead_row.organization_id,
          lead_row.branch_id,
          lead_row.team_id,
          lead_row.assigned_user_id
        )
    ),
    interest_counts as (
      select btrim(lead_row.interested_model) as model_name, count(*)::bigint as interest_count
      from scoped_leads lead_row
      where nullif(btrim(lead_row.interested_model), '') is not null
        and date_trunc('month', timezone(target_timezone, lead_row.created_at)) =
          date_trunc('month', timezone(target_timezone, now()))
      group by 1
    ),
    current_bookings as (
      select btrim(lead_row.interested_model) as model_name, count(*)::bigint as bookings
      from public.bookings booking_row
      join scoped_leads lead_row on lead_row.id = booking_row.lead_id
      where booking_row.organization_id = current_organization_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and nullif(btrim(lead_row.interested_model), '') is not null
        and date_trunc('month', timezone(target_timezone, booking_row.created_at)) =
          date_trunc('month', timezone(target_timezone, now()))
      group by 1
    ),
    previous_bookings as (
      select btrim(lead_row.interested_model) as model_name, count(*)::bigint as bookings
      from public.bookings booking_row
      join scoped_leads lead_row on lead_row.id = booking_row.lead_id
      where booking_row.organization_id = current_organization_id
        and booking_row.deleted_at is null
        and booking_row.status <> 'CANCELLED'
        and nullif(btrim(lead_row.interested_model), '') is not null
        and date_trunc('month', timezone(target_timezone, booking_row.created_at)) =
          date_trunc('month', timezone(target_timezone, now()) - interval '1 month')
      group by 1
    ),
    candidate_names as (
      select interest_row.model_name, interest_row.interest_count
      from interest_counts interest_row
      union all
      select booking_row.model_name, 0::bigint
      from current_bookings booking_row
      where not exists (
        select 1 from interest_counts interest_row
        where lower(interest_row.model_name) = lower(booking_row.model_name)
      )
      union all
      select model_row.name, 0::bigint
      from public.vehicle_models model_row
      where model_row.organization_id = current_organization_id
        and model_row.active
        and not exists (
          select 1 from interest_counts interest_row
          where lower(interest_row.model_name) = lower(model_row.name)
        )
        and not exists (
          select 1 from current_bookings booking_row
          where lower(booking_row.model_name) = lower(model_row.name)
        )
    ),
    model_rows as (
      select
        matched_model.id as model_id,
        candidate_row.model_name as name,
        coalesce(current_row.bookings, 0)::bigint as bookings,
        app_private.dashboard_percent_change(
          coalesce(current_row.bookings, 0),
          coalesce(previous_row.bookings, 0)
        ) as change,
        coalesce(stock_summary.available_stock, 0)::bigint as available_stock,
        stock_summary.image_object_file_id,
        candidate_row.interest_count
      from candidate_names candidate_row
      left join current_bookings current_row
        on lower(current_row.model_name) = lower(candidate_row.model_name)
      left join previous_bookings previous_row
        on lower(previous_row.model_name) = lower(candidate_row.model_name)
      left join lateral (
        select model_row.id
        from public.vehicle_models model_row
        where model_row.organization_id = current_organization_id
          and model_row.active
          and (
            lower(candidate_row.model_name) = lower(model_row.name)
            or lower(candidate_row.model_name) like '%' || lower(model_row.name) || '%'
          )
        order by
          (lower(candidate_row.model_name) = lower(model_row.name)) desc,
          char_length(model_row.name) desc,
          model_row.id
        limit 1
      ) matched_model on true
      left join lateral (
        select count(*)::bigint as available_stock,
          (array_agg(image_file.id order by stock_row.received_at desc nulls last, image_file.created_at desc)
            filter (where image_file.id is not null))[1] as image_object_file_id
        from public.vehicle_variants variant_row
        join public.stock_units stock_row
          on stock_row.organization_id = variant_row.organization_id
          and stock_row.variant_id = variant_row.id
          and stock_row.deleted_at is null
          and stock_row.status = 'AVAILABLE'
        left join lateral (
          select file_row.id, file_row.created_at
          from public.object_files file_row
          where file_row.organization_id = stock_row.organization_id
            and file_row.resource_type = 'stock_unit'
            and file_row.resource_id = stock_row.id
            and file_row.deleted_at is null
            and file_row.mime_type like 'image/%'
          order by file_row.created_at desc, file_row.id desc
          limit 1
        ) image_file on true
        where variant_row.organization_id = current_organization_id
          and variant_row.model_id = matched_model.id
          and app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)
      ) stock_summary on matched_model.id is not null
    ),
    top_rows as (
      select model_row.*
      from model_rows model_row
      order by
        model_row.bookings desc,
        model_row.interest_count desc,
        model_row.available_stock desc,
        model_row.name
      limit 3
    )
    select coalesce(
      jsonb_agg(to_jsonb(top_row) - 'interest_count' order by top_row.bookings desc, top_row.interest_count desc, top_row.name),
      '[]'::jsonb
    )
    from top_rows top_row
  );
end;
$$;

revoke all on function public.get_sales_consultant_top_models(text) from public, anon;
grant execute on function public.get_sales_consultant_top_models(text) to authenticated;

commit;
