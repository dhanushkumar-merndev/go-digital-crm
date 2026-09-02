begin;

-- A phone number identifies a customer match candidate, not a lead. Keep every
-- opportunity, but page the workspace by phone so repeated enquiries do not
-- occupy several top-level rows. The newest matching opportunity represents
-- the group; its complete scoped history is loaded only when the row expands.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'        lead_row.customer_name\n      from staged_leads lead_row\n',
    E'        lead_row.customer_name,\n        lead_row.normalized_phone\n      from staged_leads lead_row\n'
  );

  updated_definition := replace(
    updated_definition,
    E'        lead_row.updated_at,\n        lead_row.next_followup_at,\n',
    E'        lead_row.updated_at,\n'
      || E'        count(*) over (partition by coalesce(\n'
      || E'          nullif(lead_row.normalized_phone, ''''),\n'
      || E'          lead_row.id::text\n'
      || E'        )) as phone_lead_count,\n'
      || E'        lead_row.next_followup_at,\n'
  );

  updated_definition := replace(
    updated_definition,
    E'    ), page_ids as materialized (\n      select lead_row.id\n      from filtered_lead_ids lead_row\n',
    E'    ), phone_group_lead_ids as materialized (\n'
      || E'      select distinct on (\n'
      || E'        coalesce(nullif(lead_row.normalized_phone, ''''), lead_row.id::text)\n'
      || E'      )\n'
      || E'        lead_row.id,\n'
      || E'        lead_row.updated_at,\n'
      || E'        lead_row.created_at,\n'
      || E'        lead_row.customer_name,\n'
      || E'        lead_row.normalized_phone\n'
      || E'      from filtered_lead_ids lead_row\n'
      || E'      order by\n'
      || E'        coalesce(nullif(lead_row.normalized_phone, ''''), lead_row.id::text),\n'
      || E'        lead_row.created_at desc,\n'
      || E'        lead_row.id desc\n'
      || E'    ), page_ids as materialized (\n'
      || E'      select lead_row.id\n'
      || E'      from phone_group_lead_ids lead_row\n'
  );

  updated_definition := replace(
    updated_definition,
    E'        profile_row.full_name as assigned_user_name\n',
    E'        profile_row.full_name as assigned_user_name,\n'
      || E'        stage_row.phone_lead_count\n'
  );

  updated_definition := replace(
    updated_definition,
    E'          ''assigned_user_name'', assigned_user_name,\n',
    E'          ''assigned_user_name'', assigned_user_name,\n'
      || E'          ''phone_lead_count'', phone_lead_count,\n'
  );

  updated_definition := replace(
    updated_definition,
    E'        when target_include_kpis then (select count(*) from filtered_lead_ids)\n',
    E'        when target_include_kpis then (select count(*) from phone_group_lead_ids)\n'
  );

  updated_definition := replace(
    updated_definition,
    E'      ''kpis'', case when target_include_kpis then (select to_jsonb(kpis) from kpis) else null end,\n',
    E'      ''lead_total'', case\n'
      || E'        when target_include_kpis then (select count(*) from filtered_lead_ids)\n'
      || E'        else null\n'
      || E'      end,\n'
      || E'      ''kpis'', case when target_include_kpis then (select to_jsonb(kpis) from kpis) else null end,\n'
  );

  if updated_definition = definition
    or position('phone_group_lead_ids as materialized' in updated_definition) = 0
    or position('phone_lead_count' in updated_definition) = 0
    or position('''lead_total''' in updated_definition) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'LEAD_PHONE_GROUP_PATCH_TARGET_NOT_FOUND';
  end if;

  execute updated_definition;
end;
$migration$;

-- Expansion uses the same organization/branch/team/owner scope as the list.
-- It intentionally ignores list filters so historical Lost and active leads
-- for the number are visible together. Results are bounded for UI safety.
create or replace function public.get_lead_phone_history(target_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  workspace_scope record;
  actor_is_sales_consultant boolean := false;
  anchor_phone text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM'
    or access_context->>'organization_id' is null
    or not (access_context->>'role_key' = any(array[
      'telecaller', 'sales-consultant', 'team-manager', 'showroom-manager', 'gm-sales'
    ]::text[]))
  then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;

  current_organization_id := (access_context->>'organization_id')::uuid;
  select * into workspace_scope
  from app_private.resolve_sales_lead_workspace_scope(current_organization_id);
  if not ('lead.view' = any(workspace_scope.permission_keys)) then
    raise exception using errcode = '42501', message = 'LEAD_WORKSPACE_ACCESS_REQUIRED';
  end if;
  actor_is_sales_consultant := access_context->>'role_key' = 'sales-consultant';

  select lead_row.normalized_phone into anchor_phone
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
    and (
      workspace_scope.organization_wide
      or lead_row.branch_id = any(workspace_scope.branch_scope_ids)
      or (lead_row.team_id is not null and lead_row.team_id = any(workspace_scope.team_scope_ids))
      or (
        workspace_scope.owner_scope
        and lead_row.assigned_user_id = auth.uid()
        and lead_row.branch_id = any(workspace_scope.owner_branch_ids)
      )
    )
    and (
      not actor_is_sales_consultant
      or (
        lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
        and (
          lead_row.assigned_user_id = auth.uid()
          or exists (
            select 1
            from public.lead_stage_history handoff_history
            where handoff_history.organization_id = current_organization_id
              and handoff_history.lead_id = lead_row.id
              and handoff_history.to_status = 'Transferred to Sales'
          )
        )
      )
    );
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;

  return (
    with scoped_phone_leads as materialized (
      select lead_row.*
      from public.leads lead_row
      where lead_row.organization_id = current_organization_id
        and lead_row.deleted_at is null
        and (
          (nullif(anchor_phone, '') is not null and lead_row.normalized_phone = anchor_phone)
          or lead_row.id = target_lead_id
        )
        and (
          workspace_scope.organization_wide
          or lead_row.branch_id = any(workspace_scope.branch_scope_ids)
          or (lead_row.team_id is not null and lead_row.team_id = any(workspace_scope.team_scope_ids))
          or (
            workspace_scope.owner_scope
            and lead_row.assigned_user_id = auth.uid()
            and lead_row.branch_id = any(workspace_scope.owner_branch_ids)
          )
        )
        and (
          not actor_is_sales_consultant
          or (
            lead_row.lifecycle_status in ('Transferred to Sales', 'Appointment Scheduled', 'Lost')
            and (
              lead_row.assigned_user_id = auth.uid()
              or exists (
                select 1
                from public.lead_stage_history handoff_history
                where handoff_history.organization_id = current_organization_id
                  and handoff_history.lead_id = lead_row.id
                  and handoff_history.to_status = 'Transferred to Sales'
              )
            )
          )
        )
    ), history_rows as (
      select
        lead_row.*,
        profile_row.full_name as assigned_user_name,
        case
          when lead_row.lifecycle_status = 'Lost' then 'Lost'
          when exists (
            select 1 from public.bookings booking_row
            where booking_row.organization_id = current_organization_id
              and booking_row.lead_id = lead_row.id
              and booking_row.deleted_at is null
              and booking_row.status <> 'CANCELLED'
          ) then 'Booking'
          when exists (
            select 1 from public.quotations quotation_row
            where quotation_row.organization_id = current_organization_id
              and quotation_row.lead_id = lead_row.id
              and quotation_row.deleted_at is null
          ) then 'Quotation'
          when exists (
            select 1 from public.test_drive_appointments drive_row
            where drive_row.organization_id = current_organization_id
              and drive_row.lead_id = lead_row.id
          ) then 'Test Drive'
          when actor_is_sales_consultant
            and lead_row.lifecycle_status = 'Transferred to Sales'
            and exists (
              select 1 from public.activities activity_row
              where activity_row.organization_id = current_organization_id
                and activity_row.lead_id = lead_row.id
                and activity_row.activity_type = 'SALES_CONTACTED'
            ) then 'Sales Contacted'
          else lead_row.lifecycle_status::text
        end as lead_stage,
        case
          when lead_row.lifecycle_status = 'Lost' then null
          when lead_row.first_contacted_at is null
            and lead_row.sla_due_at is not null
            and now() > lead_row.sla_due_at then 'SLA_RISK'
          when lead_row.first_contacted_at is null
            and now() >= lead_row.created_at + interval '24 hours' then 'PENDING'
          when lead_row.first_contacted_at is null then 'NEW_TODAY'
          else null
        end as work_state
      from scoped_phone_leads lead_row
      left join public.profiles profile_row
        on profile_row.id = lead_row.assigned_user_id
       and profile_row.organization_id = lead_row.organization_id
       and profile_row.active
       and profile_row.deleted_at is null
      order by lead_row.created_at desc, lead_row.id desc
      limit 100
    )
    select jsonb_build_object(
      'records', coalesce((
        select jsonb_agg(
          to_jsonb(history_row) - 'deleted_at' - 'connection_id' - 'external_lead_id'
          order by history_row.created_at desc, history_row.id desc
        )
        from history_rows history_row
      ), '[]'::jsonb),
      'total', (select count(*) from scoped_phone_leads)
    )
  );
end;
$$;

revoke all on function public.get_lead_phone_history(uuid) from public, anon;
grant execute on function public.get_lead_phone_history(uuid) to authenticated;

commit;
