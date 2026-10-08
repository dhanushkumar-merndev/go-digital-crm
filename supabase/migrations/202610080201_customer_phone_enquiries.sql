-- Leads on one phone number were ending up under several customer records,
-- because the match dialog gave no context to choose a candidate by and Customer
-- 360 never mentioned enquiries outside its own customer_id. AGENTS.md rule 11
-- still holds -- nothing here links anything on its own:
--
-- 1. possible_customer_matches also returns each candidate's lead count and its
--    most recent enquiry, so the telecaller can recognise the customer.
-- 2. get_customer_phone_enquiries lists leads on the customer's phone numbers
--    that are not linked to that customer, within the caller's lead scope. The
--    page offers a Link action for the unlinked ones, which goes through
--    resolve_lead_customer and therefore keeps its reason + audit trail.

begin;

-- Body is pg_get_functiondef of the deployed function with the three new
-- columns added. The return type changes, so it has to be dropped first.
drop function public.possible_customer_matches(uuid);

create function public.possible_customer_matches(target_lead_id uuid)
 returns table(
   customer_id uuid,
   full_name text,
   masked_phone text,
   masked_email text,
   match_reason text,
   lead_count bigint,
   latest_interested_model text,
   latest_enquiry_at timestamptz
 )
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  lead_row public.leads%rowtype;
  lead_phone_digits text;
  lead_email_normalized text;
begin
  select * into lead_row
  from public.leads
  where id = target_lead_id and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(lead_row.organization_id, 'customer.view')
    or not app_private.has_permission(lead_row.organization_id, 'customer.link')
    or not app_private.can_access_record(
      lead_row.organization_id,
      lead_row.branch_id,
      lead_row.team_id,
      lead_row.assigned_user_id
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  lead_phone_digits := app_private.normalize_phone_digits(lead_row.normalized_phone);
  lead_email_normalized := nullif(lower(btrim(coalesce(lead_row.email, ''))), '');

  return query
  select
    customer_row.id,
    customer_row.full_name,
    case
      when customer_row.primary_phone is null then null
      when char_length(customer_row.primary_phone) <= 5 then repeat('•', char_length(customer_row.primary_phone))
      else left(customer_row.primary_phone, 3)
        || repeat('•', greatest(char_length(customer_row.primary_phone) - 5, 3))
        || right(customer_row.primary_phone, 2)
    end,
    case
      when customer_row.primary_email is null then null
      else left(customer_row.primary_email, 2)
        || '•••@'
        || split_part(customer_row.primary_email, '@', 2)
    end,
    case
      when app_private.normalize_phone_digits(customer_row.normalized_phone) = lead_phone_digits
        and lead_email_normalized is not null
        and customer_row.normalized_email = lead_email_normalized
        then 'PHONE_AND_EMAIL'
      when app_private.normalize_phone_digits(customer_row.normalized_phone) = lead_phone_digits
        then 'PHONE'
      else 'EMAIL'
    end,
    coalesce(lead_summary.lead_count, 0),
    lead_summary.latest_interested_model,
    lead_summary.latest_enquiry_at
  from public.customers customer_row
  left join lateral (
    -- Uses leads_customer_updated_idx. A count and a model name, never the
    -- other leads' contact details.
    select
      count(*) as lead_count,
      (array_agg(linked_lead.interested_model order by linked_lead.created_at desc, linked_lead.id desc))[1]
        as latest_interested_model,
      max(linked_lead.created_at) as latest_enquiry_at
    from public.leads linked_lead
    where linked_lead.organization_id = customer_row.organization_id
      and linked_lead.customer_id = customer_row.id
      and linked_lead.deleted_at is null
  ) lead_summary on true
  where customer_row.organization_id = lead_row.organization_id
    and customer_row.deleted_at is null
    and (
      (
        lead_phone_digits <> ''
        and app_private.normalize_phone_digits(customer_row.normalized_phone) = lead_phone_digits
      )
      or (
        lead_email_normalized is not null
        and customer_row.normalized_email = lead_email_normalized
      )
    )
  order by customer_row.updated_at desc, customer_row.id
  limit 10;
end;
$function$;

revoke all on function public.possible_customer_matches(uuid) from public, anon;
grant execute on function public.possible_customer_matches(uuid) to authenticated, service_role;

create function public.get_customer_phone_enquiries(target_customer_id uuid)
 returns table(
   lead_id uuid,
   customer_name text,
   source text,
   interested_model text,
   lifecycle_status text,
   branch_name text,
   assigned_user_name text,
   created_at timestamptz,
   updated_at timestamptz,
   linked_customer_id uuid,
   linked_customer_name text,
   can_link boolean
 )
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  target_organization_id uuid;
  customer_phone_digits text[];
  lead_scope record;
  link_permission boolean;
begin
  select customer_row.organization_id
  into target_organization_id
  from public.customers customer_row
  where customer_row.id = target_customer_id
    and customer_row.deleted_at is null;
  if target_organization_id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;
  -- Same visibility rule as get_customer_360, so the section can never show on
  -- a page the caller could not open.
  if not app_private.customer_360_visible(target_organization_id, target_customer_id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  select * into lead_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['lead.view']::text[]
  );
  if not coalesce(lead_scope.granted, false) then
    return;
  end if;

  -- The primary phone plus any extra phone contacts on the customer.
  select coalesce(array_agg(distinct phone_digits), '{}'::text[])
  into customer_phone_digits
  from (
    select app_private.normalize_phone_digits(customer_row.normalized_phone) as phone_digits
    from public.customers customer_row
    where customer_row.id = target_customer_id
    union
    select app_private.normalize_phone_digits(contact_row.normalized_value)
    from public.customer_contacts contact_row
    where contact_row.organization_id = target_organization_id
      and contact_row.customer_id = target_customer_id
      and contact_row.type = 'PHONE'
  ) phones
  where phone_digits is not null and phone_digits <> '';
  if cardinality(customer_phone_digits) = 0 then
    return;
  end if;

  link_permission := app_private.has_permission(target_organization_id, 'customer.link');

  return query
  select
    lead_row.id,
    lead_row.customer_name,
    lead_row.source,
    lead_row.interested_model,
    lead_row.lifecycle_status::text,
    branch_row.name,
    owner_row.full_name,
    lead_row.created_at,
    lead_row.updated_at,
    lead_row.customer_id,
    linked_customer.full_name,
    -- resolve_lead_customer only links an unlinked lead, and re-checks all of
    -- this itself; the flag just decides whether the button is offered.
    (
      lead_row.customer_id is null
      and link_permission
      and app_private.can_access_record(
        lead_row.organization_id,
        lead_row.branch_id,
        lead_row.team_id,
        lead_row.assigned_user_id
      )
    )
  from public.leads lead_row
  left join public.branches branch_row
    on branch_row.id = lead_row.branch_id
  left join public.profiles owner_row
    on owner_row.id = lead_row.assigned_user_id
  left join public.customers linked_customer
    on linked_customer.id = lead_row.customer_id
   and linked_customer.deleted_at is null
  -- Uses leads_org_phone_digits_idx.
  where lead_row.organization_id = target_organization_id
    and lead_row.deleted_at is null
    and app_private.normalize_phone_digits(lead_row.normalized_phone) = any(customer_phone_digits)
    and lead_row.customer_id is distinct from target_customer_id
    and (
      lead_scope.organization_wide
      or lead_row.branch_id = any(lead_scope.branch_scope_ids)
      or lead_row.team_id = any(lead_scope.team_scope_ids)
      or (
        lead_scope.own_records
        and lead_row.assigned_user_id = auth.uid()
        and lead_row.branch_id = any(lead_scope.own_record_branch_ids)
      )
    )
  order by lead_row.created_at desc, lead_row.id desc
  limit 25;
end;
$function$;

revoke all on function public.get_customer_phone_enquiries(uuid) from public, anon;
grant execute on function public.get_customer_phone_enquiries(uuid) to authenticated, service_role;

commit;
