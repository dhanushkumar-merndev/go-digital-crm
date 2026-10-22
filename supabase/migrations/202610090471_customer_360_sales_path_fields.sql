begin;
-- Customer 360 has two read paths: the eager `get_customer_360` (managers,
-- admins, operations) and the Sales Consultant hot path
-- (`get_sales_consultant_customer_360_core` + `..._section`). 202610090451
-- extended only the first. This brings the hot path to the same shape and moves
-- the per-opportunity extras into helpers both paths share:
--   * requirements, exchange case and exchange vehicle for the overview cards;
--   * the latest AI call summary for the "Previous call summary" card;
--   * the sales owner's phone, the customer's WhatsApp number, vehicle details
--     and each call's AI summary.

create or replace function app_private.customer_exchange_case_json(
  target_organization_id uuid,
  target_customer_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Valuation belongs to the Exchange team; only exchange.view holders see it.
  select case when app_private.has_permission(target_organization_id, 'exchange.view') then (
    select jsonb_build_object(
      'id', exchange_row.id,
      'status', exchange_row.status,
      'vehicle_id', exchange_row.vehicle_id,
      'customer_expected_value', exchange_row.customer_expected_value,
      'estimated_value', exchange_row.estimated_value,
      'accepted_value', exchange_row.accepted_value,
      'odometer_km', exchange_row.odometer_km,
      'fuel_type', exchange_row.fuel_type,
      'ownership', exchange_row.ownership,
      'updated_at', exchange_row.updated_at
    )
    from public.exchange_cases exchange_row
    where exchange_row.organization_id = target_organization_id
      and exchange_row.customer_id = target_customer_id
      and exchange_row.deleted_at is null
      and exchange_row.status <> 'CANCELLED'
    order by exchange_row.updated_at desc, exchange_row.id
    limit 1
  ) end;
$$;

create or replace function app_private.lead_exchange_vehicle_json(target_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', vehicle_row.id,
    'registration', vehicle_row.registration,
    'brand', vehicle_row.brand,
    'model', vehicle_row.model,
    'variant', vehicle_row.variant,
    'model_year', vehicle_row.model_year,
    'fuel_type', vehicle_row.fuel_type,
    'transmission', vehicle_row.transmission,
    'odometer_km', vehicle_row.odometer_km,
    'ownership', vehicle_row.ownership,
    'purchase_year', vehicle_row.purchase_year
  )
  from public.lead_requirements requirement_row
  join public.customer_vehicles vehicle_row
    on vehicle_row.id = requirement_row.exchange_vehicle_id
   and vehicle_row.organization_id = requirement_row.organization_id
  where requirement_row.lead_id = target_lead_id;
$$;

create or replace function app_private.lead_latest_call_summary_json(target_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'call_id', call_row.id,
    'summary', summary_row.summary,
    'started_at', call_row.started_at,
    'duration_seconds', call_row.duration_seconds,
    'caller_name', profile_row.full_name,
    'generated_at', summary_row.created_at
  )
  from public.calls call_row
  join lateral (
    select summary_source.summary, summary_source.created_at
    from public.ai_call_summaries summary_source
    where summary_source.organization_id = call_row.organization_id
      and summary_source.call_id = call_row.id
    order by summary_source.created_at desc, summary_source.id desc
    limit 1
  ) summary_row on true
  left join public.profiles profile_row
    on profile_row.organization_id = call_row.organization_id
   and profile_row.id = call_row.assigned_user_id
  where call_row.lead_id = target_lead_id
    and app_private.has_permission(call_row.organization_id, 'call.view')
    and app_private.can_access_call(call_row.organization_id, call_row.id)
  order by call_row.started_at desc, call_row.id desc
  limit 1;
$$;

revoke all on function app_private.customer_exchange_case_json(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.lead_exchange_vehicle_json(uuid) from public, anon, authenticated;
revoke all on function app_private.lead_latest_call_summary_json(uuid) from public, anon, authenticated;

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

-- Eager path: replace the inline exchange case from 202610090451 with the
-- shared helper and add the exchange vehicle and latest call summary.
select pg_temp.patch_function(
  'app_private.get_customer_360_legacy_20260824(uuid)',
  $old$          -- The latest live exchange for this customer; valuation is owned by
          -- the Exchange team, so only holders of exchange.view see it.
          'exchange_case', case
            when app_private.has_permission(lead_row.organization_id, 'exchange.view') then (
              select jsonb_build_object(
                'id', exchange_row.id,
                'status', exchange_row.status,
                'vehicle_id', exchange_row.vehicle_id,
                'customer_expected_value', exchange_row.customer_expected_value,
                'estimated_value', exchange_row.estimated_value,
                'accepted_value', exchange_row.accepted_value,
                'odometer_km', exchange_row.odometer_km,
                'fuel_type', exchange_row.fuel_type,
                'ownership', exchange_row.ownership,
                'updated_at', exchange_row.updated_at
              )
              from public.exchange_cases exchange_row
              where exchange_row.organization_id = lead_row.organization_id
                and exchange_row.customer_id = lead_row.customer_id
                and exchange_row.deleted_at is null
                and exchange_row.status <> 'CANCELLED'
              order by exchange_row.updated_at desc, exchange_row.id
              limit 1
            )
          end,
$old$,
  $new$          'exchange_case', app_private.customer_exchange_case_json(lead_row.organization_id, lead_row.customer_id),
          'exchange_vehicle', app_private.lead_exchange_vehicle_json(lead_row.id),
          'latest_call_summary', app_private.lead_latest_call_summary_json(lead_row.id),
$new$
);

-- Sales Consultant hot path: core.
select pg_temp.patch_function(
  'public.get_sales_consultant_customer_360_core(uuid)',
  $old$    'primary_email', customer_row.primary_email,
    'created_at', customer_row.created_at,$old$,
  $new$    'primary_email', customer_row.primary_email,
    'whatsapp_phone', customer_row.whatsapp_phone,
    'created_at', customer_row.created_at,$new$
);
select pg_temp.patch_function(
  'public.get_sales_consultant_customer_360_core(uuid)',
  $old$        profile_row.full_name as assigned_user_name,
        lead_row.created_at,$old$,
  $new$        profile_row.full_name as assigned_user_name,
        profile_row.phone as assigned_user_phone,
        app_private.lead_requirements_json(lead_row.id) as requirements,
        app_private.customer_exchange_case_json(lead_row.organization_id, lead_row.customer_id) as exchange_case,
        app_private.lead_exchange_vehicle_json(lead_row.id) as exchange_vehicle,
        app_private.lead_latest_call_summary_json(lead_row.id) as latest_call_summary,
        lead_row.created_at,$new$
);

-- Sales Consultant hot path: sections.
select pg_temp.patch_function(
  'public.get_sales_consultant_customer_360_section(uuid,text,integer,integer,timestamp with time zone,uuid)',
  $old$      'recording_status', recording_row.status,
      'transcript_status', transcript_row.status
    ) order by call_row.started_at desc, call_row.id desc), '[]'::jsonb)$old$,
  $new$      'recording_status', recording_row.status,
      'transcript_status', transcript_row.status,
      'ai_summary', (
        select summary_row.summary
        from public.ai_call_summaries summary_row
        where summary_row.organization_id = call_row.organization_id
          and summary_row.call_id = call_row.id
        order by summary_row.created_at desc, summary_row.id desc
        limit 1
      )
    ) order by call_row.started_at desc, call_row.id desc), '[]'::jsonb)$new$
);
select pg_temp.patch_function(
  'public.get_sales_consultant_customer_360_section(uuid,text,integer,integer,timestamp with time zone,uuid)',
  $old$      select vehicle_row.id, vehicle_row.registration, vehicle_row.brand,
        vehicle_row.model, vehicle_row.variant, vehicle_row.model_year,
        vehicle_row.created_at$old$,
  $new$      select vehicle_row.id, vehicle_row.registration, vehicle_row.brand,
        vehicle_row.model, vehicle_row.variant, vehicle_row.model_year,
        vehicle_row.fuel_type, vehicle_row.transmission, vehicle_row.odometer_km,
        vehicle_row.ownership, vehicle_row.purchase_year,
        vehicle_row.created_at$new$
);

commit;
