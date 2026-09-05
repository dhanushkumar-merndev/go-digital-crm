begin;

-- Customer 360 manual calls are human TeleCMI calls. Automated AI voice calls
-- use the separate five-minute escalation queue and must not share this action.
drop function if exists public.get_customer_ai_call_options(uuid);

create or replace function public.get_customer_telecmi_call_options(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  lead_row record;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'customer.view')
    or not app_private.has_permission(current_organization_id, 'call.create')
    or not app_private.can_access_customer(current_organization_id, target_customer_id)
  then
    raise exception using errcode = '42501', message = 'TELECMI_CALL_PERMISSION_REQUIRED';
  end if;

  select lead_source.id, lead_source.branch_id, branch_row.name as branch_name
  into lead_row
  from public.leads lead_source
  join public.branches branch_row
    on branch_row.organization_id = lead_source.organization_id
   and branch_row.id = lead_source.branch_id
  where lead_source.organization_id = current_organization_id
    and lead_source.customer_id = target_customer_id
    and lead_source.deleted_at is null
    and app_private.can_access_record(
      lead_source.organization_id,
      lead_source.branch_id,
      lead_source.team_id,
      lead_source.assigned_user_id
    )
  order by lead_source.updated_at desc, lead_source.id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'lead_id', null,
      'branch_name', null,
      'connections', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'lead_id', lead_row.id,
    'branch_name', lead_row.branch_name,
    'connections', coalesce(jsonb_agg(jsonb_build_object(
      'id', connection_row.id,
      'display_name', connection_row.display_name,
      'caller_id_label', nullif(connection_row.connection_config->>'caller_id_label', ''),
      'scope_mode', connection_row.scope_mode
    ) order by connection_row.display_name, connection_row.id), '[]'::jsonb)
  )
  into result
  from public.connected_accounts connection_row
  where connection_row.organization_id = current_organization_id
    and connection_row.provider_key = 'telecmi'
    and connection_row.status = 'CONNECTED'
    and connection_row.deleted_at is null
    and connection_row.connection_config @> '{"capabilities":["IVR_CALLING"]}'::jsonb
    and (
      connection_row.scope_mode = 'ALL_BRANCHES'
      or exists (
        select 1
        from public.integration_branch_mappings mapping_row
        where mapping_row.organization_id = current_organization_id
          and mapping_row.connected_account_id = connection_row.id
          and mapping_row.external_resource_type = 'CONNECTION_SCOPE'
          and mapping_row.branch_id = lead_row.branch_id
          and mapping_row.deleted_at is null
      )
    )
    and exists (
      select 1
      from public.profiles actor_profile,
        jsonb_array_elements(
          case when jsonb_typeof(connection_row.connection_config -> 'parallel_agents') = 'array'
            then connection_row.connection_config -> 'parallel_agents' else '[]'::jsonb end
        ) agent_data
      where actor_profile.id = auth.uid()
        and actor_profile.organization_id = current_organization_id
        and actor_profile.active
        and actor_profile.deleted_at is null
        and actor_profile.normalized_phone is not null
        and app_private.normalize_phone_digits(agent_data ->> 'phone')
          = app_private.normalize_phone_digits(actor_profile.normalized_phone)
        and nullif(btrim(agent_data ->> 'user_id'), '') is not null
    );

  return result;
end;
$$;

revoke all on function public.get_customer_telecmi_call_options(uuid) from public, anon;
grant execute on function public.get_customer_telecmi_call_options(uuid) to authenticated;

commit;
