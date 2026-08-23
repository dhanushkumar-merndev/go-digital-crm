-- Platform subscription-plan catalog. The current schema owns plans and their
-- module matrix, but deliberately does not model price or tenant subscription
-- terms; this workspace therefore never fabricates those values.

create unique index if not exists platform_subscription_plan_save_request_unique_idx
  on public.audit_logs (actor_id, request_id)
  where organization_id is null and action = 'platform_subscription_plan.saved';

create or replace function public.get_platform_subscription_plan_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_SUBSCRIPTION_PLAN_ACCESS_REQUIRED';
  end if;

  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'total_plans', (select count(*) from public.subscription_plans),
      'active_plans', (select count(*) from public.subscription_plans where active),
      'module_assignments', (select count(*) from public.plan_modules),
      'active_modules', (select count(*) from public.modules where active)
    ),
    'available_modules', coalesce((select jsonb_agg(jsonb_build_object(
      'id', module_row.id, 'module_key', module_row.module_key, 'name', module_row.name,
      'active', module_row.active
    ) order by module_row.active desc, module_row.name, module_row.id) from public.modules module_row), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object(
      'id', plan_row.id, 'name', plan_row.name, 'active', plan_row.active,
      'created_at', plan_row.created_at,
      'modules', coalesce((select jsonb_agg(jsonb_build_object(
        'id', module_row.id, 'module_key', module_row.module_key, 'name', module_row.name,
        'active', module_row.active, 'limits', plan_module_row.limits
      ) order by module_row.name, module_row.id)
        from public.plan_modules plan_module_row
        join public.modules module_row on module_row.id = plan_module_row.module_id
        where plan_module_row.plan_id = plan_row.id), '[]'::jsonb)
    ) order by plan_row.active desc, plan_row.name, plan_row.id) from public.subscription_plans plan_row), '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_platform_subscription_plan(
  target_plan_id uuid,
  target_name text,
  target_active boolean,
  target_module_ids uuid[],
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text;
  normalized_module_ids uuid[];
  saved_plan public.subscription_plans%rowtype;
  replayed_resource_id uuid;
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_SUBSCRIPTION_PLAN_MANAGE_REQUIRED';
  end if;
  normalized_name := left(btrim(coalesce(target_name, '')), 120);
  if char_length(normalized_name) < 2 or target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_SUBSCRIPTION_PLAN';
  end if;
  select coalesce(array_agg(distinct module_id), '{}'::uuid[]) into normalized_module_ids
  from unnest(coalesce(target_module_ids, '{}'::uuid[])) module_id;
  if cardinality(normalized_module_ids) > 100 or (select count(*) from public.modules
      where id = any(normalized_module_ids)) <> cardinality(normalized_module_ids) then
    raise exception using errcode = '22023', message = 'INVALID_PLATFORM_PLAN_MODULES';
  end if;
  select audit_row.resource_id::uuid into replayed_resource_id
  from public.audit_logs audit_row
  where audit_row.organization_id is null
    and audit_row.actor_id = auth.uid()
    and audit_row.request_id = target_request_id
    and audit_row.action = 'platform_subscription_plan.saved'
  limit 1;
  if found then
    select * into saved_plan from public.subscription_plans where id = replayed_resource_id;
    return jsonb_build_object('id', saved_plan.id, 'name', saved_plan.name, 'active', saved_plan.active, 'replayed', true);
  end if;

  if target_plan_id is null then
    insert into public.subscription_plans (name, active)
    values (normalized_name, target_active)
    returning * into saved_plan;
  else
    update public.subscription_plans
    set name = normalized_name, active = target_active
    where id = target_plan_id
    returning * into saved_plan;
    if not found then
      raise exception using errcode = 'P0002', message = 'PLATFORM_SUBSCRIPTION_PLAN_NOT_FOUND';
    end if;
  end if;

  delete from public.plan_modules where plan_id = saved_plan.id;
  insert into public.plan_modules (plan_id, module_id, limits)
  select saved_plan.id, module_id, '{}'::jsonb
  from unnest(normalized_module_ids) module_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    null, auth.uid(), 'platform_subscription_plan.saved', 'subscription_plan', saved_plan.id::text,
    target_request_id, jsonb_build_object(
      'name', saved_plan.name, 'active', saved_plan.active,
      'module_count', cardinality(normalized_module_ids),
      'safe_message', 'Platform subscription plan saved'
    )
  );
  return jsonb_build_object('id', saved_plan.id, 'name', saved_plan.name, 'active', saved_plan.active, 'replayed', false);
end;
$$;

revoke all on function public.get_platform_subscription_plan_workspace() from public, anon;
grant execute on function public.get_platform_subscription_plan_workspace() to authenticated;
revoke all on function public.save_platform_subscription_plan(uuid, text, boolean, uuid[], uuid) from public, anon;
grant execute on function public.save_platform_subscription_plan(uuid, text, boolean, uuid[], uuid) to authenticated;
