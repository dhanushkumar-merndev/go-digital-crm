begin;

-- The Calls page was dead for every role except Sales Consultant: the shared
-- legacy query hit the 8s statement timeout and the workspace rendered its
-- GDM-CALLS-QUERY error card. Sales Consultant was fine because 202608220003
-- gave it a fast path that resolves the actor's scope once.
--
-- `scoped_calls` asked the same two questions over and over. Per call row it
-- called can_access_lead() four times and can_access_customer() four times --
-- once in each of the lead_id/customer_id/customer_name/phone/search_phone
-- CASE arms -- on top of the can_access_record() in the WHERE. Nine permission
-- lookups a row, and the planner cannot fold them away because the functions
-- are volatile-by-default plpgsql. With only 123 calls in the pilot org that
-- was already ~8s; the row count was never the problem.
--
-- Ask once per row through a lateral and reuse the two booleans. Identical
-- results and identical visibility rules -- the same predicates, evaluated
-- once instead of four times each.
do $migration$
declare
  signature regprocedure :=
    'public.get_call_workspace_page_legacy(text,integer,integer,text,text,text,text)'::regprocedure;
  definition text;
  updated_definition text;
  old_select constant text := '      case
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) then lead_row.id
        else null
      end as lead_id,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then customer_row.id
        else null
      end as customer_id,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then customer_row.full_name
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) then lead_row.customer_name
        else null
      end as customer_name,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then customer_row.primary_phone
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) then lead_row.phone
        else null
      end as phone,
      case
        when customer_access and customer_row.id is not null
          and app_private.can_access_customer(call_row.organization_id, customer_row.id)
          then app_private.normalize_phone_digits(customer_row.normalized_phone)
        when lead_access and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id)
          then app_private.normalize_phone_digits(lead_row.normalized_phone)
        else ''''
      end as search_phone,';
  new_select constant text := '      case
        when access_row.lead_ok then lead_row.id
        else null
      end as lead_id,
      case
        when access_row.customer_ok then customer_row.id
        else null
      end as customer_id,
      case
        when access_row.customer_ok then customer_row.full_name
        when access_row.lead_ok then lead_row.customer_name
        else null
      end as customer_name,
      case
        when access_row.customer_ok then customer_row.primary_phone
        when access_row.lead_ok then lead_row.phone
        else null
      end as phone,
      case
        when access_row.customer_ok
          then app_private.normalize_phone_digits(customer_row.normalized_phone)
        when access_row.lead_ok
          then app_private.normalize_phone_digits(lead_row.normalized_phone)
        else ''''
      end as search_phone,';
  old_join constant text := '    left join public.customers customer_row
      on customer_row.organization_id = call_row.organization_id
     and customer_row.id = coalesce(call_row.customer_id, lead_row.customer_id)
     and customer_row.deleted_at is null
    where call_row.organization_id = current_organization_id';
  new_join constant text := '    left join public.customers customer_row
      on customer_row.organization_id = call_row.organization_id
     and customer_row.id = coalesce(call_row.customer_id, lead_row.customer_id)
     and customer_row.deleted_at is null
    left join lateral (
      select
        lead_access
          and lead_row.id is not null
          and app_private.can_access_lead(lead_row.id) as lead_ok,
        customer_access
          and customer_row.id is not null
          and app_private.can_access_customer(
            call_row.organization_id,
            customer_row.id
          ) as customer_ok
    ) access_row on true
    where call_row.organization_id = current_organization_id';
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;

  if position('access_row.lead_ok' in definition) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'CALLS_SCOPE_DEDUPE_ALREADY_APPLIED';
  end if;
  if position(old_select in definition) = 0 or position(old_join in definition) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'CALLS_SCOPE_DEDUPE_TARGET_NOT_FOUND';
  end if;

  updated_definition := replace(definition, old_select, new_select);
  updated_definition := replace(updated_definition, old_join, new_join);

  if updated_definition = definition
    or position(new_select in updated_definition) = 0
    or position(new_join in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'CALLS_SCOPE_DEDUPE_PATCH_FAILED';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
