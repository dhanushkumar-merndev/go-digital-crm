begin;

-- A Telecaller qualifies a lead, calls the customer, then hands the lead to a
-- Sales Consultant. transfer_lead_to_sales moves leads.assigned_user_id to the
-- consultant, and every customer gate keyed on "a lead assigned to me" then
-- stopped recognising the Telecaller: Customer 360 answered PERMISSION_DENIED
-- for the very customer they had just worked.
--
-- Two separate problems came out of that, and both are fixed here.
--
-- 1. Ownership was read as a present-tense fact. It is now read as "owns or has
--    owned", from the assignment records the handoff already writes.
-- 2. The header lookup and Customer 360 asked different questions. The lookup
--    used app_private.can_access_customer (no branch requirement); the page used
--    its own inline scope test (branch required). The lookup therefore listed
--    customers whose 360 page refused to open, which is the dead end users hit.
--    Both now go through app_private.customer_360_visible.

-- Has this user ever held this lead? assign_lead and transfer_lead_to_sales both
-- deactivate the previous lead_assignments row and write a lead_assignment_history
-- row naming the outgoing owner, so the two tables together answer this for any
-- lead that changed hands, however it was assigned in the first place.
create or replace function app_private.has_owned_lead(
  target_organization_id uuid,
  target_lead_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.lead_assignments assignment_row
    where assignment_row.organization_id = target_organization_id
      and assignment_row.lead_id = target_lead_id
      and assignment_row.assigned_user_id = auth.uid()
  ) or exists (
    select 1
    from public.lead_assignment_history history_row
    where history_row.organization_id = target_organization_id
      and history_row.lead_id = target_lead_id
      and (
        history_row.previous_owner_id = auth.uid()
        or history_row.new_owner_id = auth.uid()
      )
  );
$$;

revoke all on function app_private.has_owned_lead(uuid, uuid)
  from public, anon, authenticated;

-- The single rule behind both Customer 360 and the header lookup. It keeps the
-- hardened shape: scope must come from an assignment that itself grants
-- customer.view, and it must reach one of this customer's leads on an active
-- branch. The own-records arm is the only thing that changed, and only to admit
-- a lead this user used to hold.
create or replace function app_private.customer_360_visible(
  target_organization_id uuid,
  target_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with customer_scope as (
    select *
    from app_private.resolve_permission_record_scope(
      target_organization_id,
      array['customer.view']::text[]
    )
  )
  -- bool_or over the single scope row, then coalesce: a NULL anywhere in the
  -- scope record, or no row at all, has to read as "not visible". The callers
  -- test this with `if not ...`, where a NULL would silently skip the raise.
  select coalesce(
    bool_or(
      coalesce(scope_row.granted, false)
      and coalesce(
        scope_row.organization_wide
        or exists (
          select 1
          from public.leads customer_lead_row
          join public.branches customer_branch_row
            on customer_branch_row.id = customer_lead_row.branch_id
           and customer_branch_row.organization_id = customer_lead_row.organization_id
           and customer_branch_row.active
           and customer_branch_row.deleted_at is null
          where customer_lead_row.organization_id = target_organization_id
            and customer_lead_row.customer_id = target_customer_id
            and customer_lead_row.deleted_at is null
            and (
              customer_lead_row.branch_id = any(scope_row.branch_scope_ids)
              or customer_lead_row.team_id = any(scope_row.team_scope_ids)
              or (
                scope_row.own_records
                and customer_lead_row.branch_id = any(
                  scope_row.own_record_branch_ids
                )
                and (
                  customer_lead_row.assigned_user_id = auth.uid()
                  or app_private.has_owned_lead(
                    target_organization_id,
                    customer_lead_row.id
                  )
                )
              )
            )
        ),
        false
      )
    ),
    false
  )
  from customer_scope scope_row;
$$;

revoke all on function app_private.customer_360_visible(uuid, uuid)
  from public, anon, authenticated;

-- can_access_customer guards the legacy Customer 360 body and the customer RLS
-- policies. The past-owner arm is added here too, or the wrapper above would
-- pass a Telecaller that the body it calls still rejects. This is purely
-- additive: no caller loses access it had before.
create or replace function app_private.can_access_customer(target_organization_id uuid, target_customer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.can_access_organization(target_organization_id)
    and exists (
      select 1 from public.customers customer_row
      where customer_row.id = target_customer_id
        and customer_row.organization_id = target_organization_id
        and customer_row.deleted_at is null
    )
    and (
      app_private.has_active_approved_support_session(target_organization_id)
      or exists (
        select 1
        from public.user_role_assignments assignment_row
        join public.roles role_row
          on role_row.id = assignment_row.role_id
         and role_row.organization_id = assignment_row.organization_id
        where assignment_row.user_id = auth.uid()
          and assignment_row.organization_id = target_organization_id
          and assignment_row.active
          and (
            assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
            or exists (
              select 1
              from public.leads lead_row
              where lead_row.organization_id = target_organization_id
                and lead_row.customer_id = target_customer_id
                and lead_row.deleted_at is null
                and (
                  (
                    assignment_row.data_scope = 'OWN_RECORDS'
                    and (
                      lead_row.assigned_user_id = auth.uid()
                      or app_private.has_owned_lead(target_organization_id, lead_row.id)
                    )
                  )
                  or (
                    assignment_row.data_scope = 'OWN_TEAM'
                    and lead_row.team_id in (
                      select member_row.team_id
                      from public.team_members member_row
                      where member_row.organization_id = target_organization_id
                        and member_row.user_id = auth.uid()
                        and member_row.active
                    )
                  )
                  or (assignment_row.data_scope = 'ONE_BRANCH' and lead_row.branch_id = assignment_row.scope_branch_id)
                  or (assignment_row.data_scope = 'SELECTED_BRANCHES' and lead_row.branch_id = any(assignment_row.selected_branch_ids))
                )
            )
          )
      )
    );
$$;

create or replace function public.get_customer_360(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  target_organization_id uuid;
  lead_scope record;
  followup_scope record;
  appointment_scope record;
  followup_access boolean := false;
  appointment_access boolean := false;
  filtered_followups jsonb := '[]'::jsonb;
  filtered_appointments jsonb := '[]'::jsonb;
begin
  select customer_row.organization_id
  into target_organization_id
  from public.customers customer_row
  where customer_row.id = target_customer_id
    and customer_row.deleted_at is null;

  if target_organization_id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  select * into lead_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['lead.view']::text[]
  );
  select * into followup_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['followup.view']::text[]
  );
  select * into appointment_scope
  from app_private.resolve_permission_record_scope(
    target_organization_id,
    array['appointment.view']::text[]
  );

  -- Customer visibility is resolved by app_private.customer_360_visible so
  -- that this page and the header lookup cannot answer the question
  -- differently. See that function for the rule itself.
  if not app_private.customer_360_visible(target_organization_id, target_customer_id) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  -- The private legacy function keeps the original JSON contract and its
  -- existing defense-in-depth checks. The wrapper then intersects each newly
  -- permissioned section with the matching permission-bound record scope.
  result := app_private.get_customer_360_legacy_20260824(target_customer_id);

  followup_access := coalesce(followup_scope.granted, false);
  appointment_access := coalesce(appointment_scope.granted, false);

  if followup_access then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into filtered_followups
    from jsonb_array_elements(coalesce(result->'followups', '[]'::jsonb))
      with ordinality item(value, ordinality)
    join public.followups followup_row
      on followup_row.organization_id = target_organization_id
     and followup_row.id = (item.value->>'id')::uuid
    left join public.leads lead_row
      on lead_row.organization_id = followup_row.organization_id
     and lead_row.id = followup_row.lead_id
     and lead_row.deleted_at is null
    where (
      followup_scope.organization_wide
      or followup_row.branch_id = any(followup_scope.branch_scope_ids)
      or followup_row.team_id = any(followup_scope.team_scope_ids)
      or (
        followup_scope.own_records
        and followup_row.assigned_user_id = auth.uid()
        and followup_row.branch_id = any(followup_scope.own_record_branch_ids)
      )
    )
      and (
        followup_row.lead_id is null
        or (
          lead_scope.granted
          and lead_row.id is not null
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
        )
      );
    result := jsonb_set(result, '{followups}', filtered_followups, true);
  end if;

  if appointment_access then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into filtered_appointments
    from jsonb_array_elements(coalesce(result->'appointments', '[]'::jsonb))
      with ordinality item(value, ordinality)
    join public.appointments appointment_row
      on appointment_row.organization_id = target_organization_id
     and appointment_row.id = (item.value->>'id')::uuid
    left join public.leads lead_row
      on lead_row.organization_id = appointment_row.organization_id
     and lead_row.id = appointment_row.lead_id
     and lead_row.deleted_at is null
    where (
      appointment_scope.organization_wide
      or appointment_row.branch_id = any(appointment_scope.branch_scope_ids)
      or appointment_row.team_id = any(appointment_scope.team_scope_ids)
      or (
        appointment_scope.own_records
        and appointment_row.assigned_user_id = auth.uid()
        and appointment_row.branch_id = any(appointment_scope.own_record_branch_ids)
      )
    )
      and (
        appointment_row.lead_id is null
        or (
          lead_scope.granted
          and lead_row.id is not null
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
        )
      );
    result := jsonb_set(result, '{appointments}', filtered_appointments, true);
  end if;

  result := jsonb_set(
    result,
    '{section_access,followups}',
    to_jsonb(followup_access),
    true
  );
  result := jsonb_set(
    result,
    '{section_access,appointments}',
    to_jsonb(appointment_access),
    true
  );

  if not followup_access then
    result := jsonb_set(result, '{followups}', '[]'::jsonb, true);
  end if;
  if not appointment_access then
    result := jsonb_set(result, '{appointments}', '[]'::jsonb, true);
  end if;

  return result;
end;
$$;

revoke all on function public.get_customer_360(uuid) from public, anon;
grant execute on function public.get_customer_360(uuid) to authenticated;

create or replace function public.search_authorized_customers(
  target_search text,
  target_page integer default 1,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_search text;
  search_phone_digits text;
  search_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_page not between 1 and 1000000 or target_page_size not in (25, 50, 100) then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;

  normalized_search := lower(btrim(coalesce(target_search, '')));
  if char_length(normalized_search) not between 2 and 160 then
    raise exception using errcode = '22023', message = 'GLOBAL_CUSTOMER_SEARCH_REQUIRES_2_TO_160_CHARACTERS';
  end if;
  search_phone_digits := app_private.normalize_phone_digits(normalized_search);
  if normalized_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    search_uuid := normalized_search::uuid;
  end if;

  select profile_row.organization_id
  into current_organization_id
  from public.profiles profile_row
  where profile_row.id = auth.uid()
    and profile_row.organization_id is not null
    and profile_row.active
    and profile_row.deleted_at is null;

  if current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_VIEW_PERMISSION_REQUIRED';
  end if;

  with matched_rows as materialized (
    select
      customer_row.id,
      customer_row.full_name,
      customer_row.primary_phone,
      customer_row.primary_email,
      customer_row.updated_at
    from public.customers customer_row
    where customer_row.organization_id = current_organization_id
      and customer_row.deleted_at is null
      and app_private.can_access_customer(customer_row.organization_id, customer_row.id)
      -- Listing a customer that Customer 360 will refuse to open is a dead
      -- end, so the lookup applies that page's own rule as well.
      and app_private.customer_360_visible(customer_row.organization_id, customer_row.id)
      and (
        customer_row.id = search_uuid
        or customer_row.normalized_name ilike '%' || normalized_search || '%'
        or customer_row.normalized_email = normalized_search
        or (
          search_phone_digits <> ''
          and app_private.normalize_phone_digits(customer_row.normalized_phone) = search_phone_digits
        )
      )
    order by customer_row.updated_at desc, customer_row.id desc
    limit target_page_size + 1
    offset (target_page - 1) * target_page_size
  ), page_rows as (
    select *
    from matched_rows
    order by updated_at desc, id desc
    limit target_page_size
  )
  select jsonb_build_object(
    'records', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'full_name', page_row.full_name,
            'primary_phone', page_row.primary_phone,
            'primary_email', page_row.primary_email,
            'updated_at', page_row.updated_at
          )
          order by page_row.updated_at desc, page_row.id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    'has_next', (select count(*) > target_page_size from matched_rows)
  ) into result;

  return result;
end;
$$;

revoke all on function public.search_authorized_customers(text, integer, integer) from public, anon;
grant execute on function public.search_authorized_customers(text, integer, integer) to authenticated;

commit;
