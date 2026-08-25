begin;

-- Sales Consultant contact is a role-specific, auditable work-state. It does
-- not overwrite the canonical lifecycle that was set by the Telecaller/BDC.
create index if not exists activities_sales_contacted_lead_idx
  on public.activities (organization_id, lead_id, occurred_at desc)
  where activity_type = 'SALES_CONTACTED';

create or replace function public.record_sales_lead_contact(
  target_lead_id uuid,
  contact_channel text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  target_lead public.leads%rowtype;
  normalized_channel text := upper(btrim(coalesce(contact_channel, '')));
  contacted_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if normalized_channel not in ('CALL', 'WHATSAPP') then
    raise exception using errcode = '22023', message = 'INVALID_CONTACT_CHANNEL';
  end if;

  current_organization_id := app_private.current_tenant_organization();
  select lead_row.* into target_lead
  from public.leads lead_row
  where lead_row.organization_id = current_organization_id
    and lead_row.id = target_lead_id
    and lead_row.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  end if;
  if not app_private.has_permission(current_organization_id, 'lead.update')
    or not app_private.can_access_record(
      current_organization_id, target_lead.branch_id, target_lead.team_id, target_lead.assigned_user_id
    ) then
    raise exception using errcode = '42501', message = 'SCOPE_DENIED';
  end if;
  if not exists (
    select 1
    from public.user_role_assignments assignment_row
    join public.roles role_row
      on role_row.id = assignment_row.role_id
     and role_row.organization_id = assignment_row.organization_id
    where assignment_row.organization_id = current_organization_id
      and assignment_row.user_id = auth.uid()
      and assignment_row.active
      and role_row.role_key = 'sales_consultant'
  ) then
    raise exception using errcode = '42501', message = 'SALES_CONSULTANT_REQUIRED';
  end if;
  if target_lead.lifecycle_status = 'Lost' or not exists (
    select 1
    from public.lead_stage_history history_row
    where history_row.organization_id = current_organization_id
      and history_row.lead_id = target_lead_id
      and history_row.to_status = 'Transferred to Sales'
  ) then
    raise exception using errcode = '23514', message = 'SALES_HANDOFF_REQUIRED';
  end if;

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at
  ) values (
    current_organization_id,
    target_lead.customer_id,
    target_lead.id,
    'SALES_CONTACTED',
    auth.uid(),
    jsonb_build_object('channel', normalized_channel, 'source', 'lead_workspace_action'),
    contacted_at
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, metadata
  ) values (
    current_organization_id,
    auth.uid(),
    'lead.sales_contacted',
    'lead',
    target_lead.id::text,
    target_lead.branch_id,
    jsonb_build_object('channel', normalized_channel, 'contacted_at', contacted_at)
  );

  return jsonb_build_object('lead_id', target_lead.id, 'contacted_at', contacted_at);
end;
$$;

revoke all on function public.record_sales_lead_contact(uuid, text) from public, anon;
grant execute on function public.record_sales_lead_contact(uuid, text) to authenticated;

-- Extend the scoped lead RPC without duplicating it: this preserves every
-- non-Sales role and adds three Sales Consultant-only work views.
do $migration$
declare
  signature regprocedure :=
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure;
  definition text;
  updated_definition text;
  local_day_start text := E'pg_catalog.timezone(\n                ''Asia/Kolkata'',\n                date_trunc(''day'', pg_catalog.timezone(''Asia/Kolkata'', query_now))\n              )';
begin
  select pg_get_functiondef(signature) into definition;
  updated_definition := definition;

  updated_definition := replace(
    updated_definition,
    E'        ) as sales_handoff_at,\n',
    E'        ) as sales_handoff_at,\n        (\n          select max(activity_row.occurred_at)\n          from public.activities activity_row\n          where activity_row.organization_id = lead_row.organization_id\n            and activity_row.lead_id = lead_row.id\n            and activity_row.activity_type = ''SALES_CONTACTED''\n        ) as sales_contacted_at,\n'
  );
  updated_definition := replace(
    updated_definition,
    E'          when lead_row.has_test_drive then ''Test Drive''\n          else lead_row.lifecycle_status::text\n',
    E'          when lead_row.has_test_drive then ''Test Drive''\n          when actor_is_sales_consultant\n            and lead_row.lifecycle_status = ''Transferred to Sales''\n            and lead_row.sales_contacted_at >= lead_row.sales_handoff_at then ''Sales Contacted''\n          else lead_row.lifecycle_status::text\n'
  );
  updated_definition := replace(
    updated_definition,
    E'        or (target_status = ''sla-risk'' and lead_row.work_state = ''SLA_RISK'')',
    E'        or (target_status = ''sla-risk'' and lead_row.work_state = ''SLA_RISK'')\n        or (\n          target_status = ''sales-new''\n          and actor_is_sales_consultant\n          and lead_row.sales_handoff_at >= ' || local_day_start || E'\n          and lead_row.sales_handoff_at < ' || local_day_start || E' + interval ''1 day''\n          and (lead_row.sales_contacted_at is null or lead_row.sales_contacted_at < lead_row.sales_handoff_at)\n        )\n        or (\n          target_status = ''sales-pending''\n          and actor_is_sales_consultant\n          and lead_row.sales_handoff_at < ' || local_day_start || E'\n          and (lead_row.sales_contacted_at is null or lead_row.sales_contacted_at < lead_row.sales_handoff_at)\n        )\n        or (\n          target_status = ''sales-contacted''\n          and actor_is_sales_consultant\n          and lead_row.sales_contacted_at >= lead_row.sales_handoff_at\n        )'
  );
  updated_definition := replace(
    updated_definition,
    E'        count(*) filter (where lifecycle_status = ''Lost'')::bigint as lost_count',
    E'        count(*) filter (where lifecycle_status = ''Lost'')::bigint as lost_count,\n        count(*) filter (where actor_is_sales_consultant\n          and sales_handoff_at >= ' || local_day_start || E'\n          and sales_handoff_at < ' || local_day_start || E' + interval ''1 day''\n          and (sales_contacted_at is null or sales_contacted_at < sales_handoff_at))::bigint as sales_new_today,\n        count(*) filter (where actor_is_sales_consultant\n          and sales_handoff_at < ' || local_day_start || E'\n          and (sales_contacted_at is null or sales_contacted_at < sales_handoff_at))::bigint as sales_pending,\n        count(*) filter (where actor_is_sales_consultant\n          and sales_contacted_at >= sales_handoff_at)::bigint as sales_contacted'
  );

  if updated_definition = definition
    or position('sales_contacted_at' in updated_definition) = 0
    or position('sales-new' in updated_definition) = 0
    or position('sales_contacted' in updated_definition) = 0 then
    raise exception using errcode = 'P0001', message = 'SALES_CONTACTED_WORK_STATE_PATCH_TARGET_NOT_FOUND';
  end if;
  execute updated_definition;
end;
$migration$;

commit;
