-- Platform AI credits are an immutable tenant balance. Only a platform Super
-- Admin with MFA can allocate them; ordinary tenant users can never grant,
-- adjust, or delete a credit entry.

-- This migration backfills immutable system-role permissions. The role
-- permission trigger intentionally accepts only a service-role claim for such
-- platform provisioning; this session-scoped setting is not exposed to app
-- clients and ends with the migration connection.
select set_config('request.jwt.claim.role', 'service_role', false);

-- Viewing credits and issuing credits are deliberately different permissions.
-- The allocation RPC below does not consult either tenant permission; it
-- accepts only a platform Super Admin with current MFA assurance.
insert into public.permissions (permission_key, module, description)
values ('credit.view', 'credits', 'View tenant AI and tracking credit balances')
on conflict (permission_key) do update
  set module = excluded.module,
      description = excluded.description;

-- Remove the historic tenant allocation grant before exposing the platform
-- allocation UI. This is safe to re-run and leaves immutable ledger history
-- intact.
delete from public.role_permissions role_permission_row
using public.roles role_row, public.permissions permission_row
where role_permission_row.role_id = role_row.id
  and role_permission_row.permission_id = permission_row.id
  and permission_row.permission_key = 'credit.allocate'
  and role_row.role_key <> 'super_admin';

delete from public.role_permissions role_permission_row
using public.permissions permission_row
where role_permission_row.permission_id = permission_row.id
  and permission_row.permission_key = 'credit.consume';

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
join public.permissions permission_row on permission_row.permission_key = 'credit.view'
where role_row.role_key = 'business_owner'
on conflict do nothing;

-- Preserve the Business Owner's read-only AI summary after the old allocation
-- permission is removed, and allow credit viewers to read their own ledger.
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
    or not app_private.has_permission(current_organization_id, 'credit.view')
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

drop policy if exists credit_ledger_read on public.credit_ledger;
create policy credit_ledger_read on public.credit_ledger
for select to authenticated using (
  app_private.can_access_organization(organization_id)
  and (
    app_private.has_permission(organization_id, 'credit.view')
  )
);

create index if not exists credit_ledger_ai_org_created_idx
  on public.credit_ledger (organization_id, created_at desc, id desc)
  where ledger_kind = 'AI';

create or replace function public.grant_platform_ai_credits(
  target_organization_id uuid,
  target_amount bigint,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_reason text := btrim(coalesce(target_reason, ''));
  fingerprint jsonb;
  prior_fingerprint jsonb;
  prior_result jsonb;
  ledger_id uuid;
  resulting_balance bigint;
  result jsonb;
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_MFA_REQUIRED';
  end if;
  if target_organization_id is null
    or target_request_id is null
    or target_amount not between 1 and 1000000
    or char_length(normalized_reason) not between 5 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_AI_CREDIT_ALLOCATION';
  end if;
  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = target_organization_id
      and organization_row.deleted_at is null
      and organization_row.status in ('ACTIVE', 'SUPPORT_MAINTENANCE')
  ) then
    raise exception using errcode = 'P0002', message = 'AI_CREDIT_ORGANIZATION_NOT_ACTIVE';
  end if;

  fingerprint := jsonb_build_object(
    'organization_id', target_organization_id,
    'amount', target_amount,
    'reason', normalized_reason
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_organization_id::text || ':AI:allocation:' || auth.uid()::text || ':' || target_request_id::text,
    0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into prior_fingerprint, prior_result
  from public.audit_logs audit_row
  where audit_row.organization_id = target_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'platform.ai_credits.allocated'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if prior_result is not null then
    if prior_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return prior_result || jsonb_build_object('replayed', true);
  end if;

  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature, source,
    reference_id, reason, created_by
  ) values (
    target_organization_id, 'AI', 'ALLOCATION', target_amount, 'ai_credit_allocation',
    'PLATFORM_SUPER_ADMIN', 'ai-credit-allocation:' || target_request_id::text,
    normalized_reason, auth.uid()
  ) returning id into ledger_id;

  select coalesce(sum(ledger_row.amount), 0) into resulting_balance
  from public.credit_ledger ledger_row
  where ledger_row.organization_id = target_organization_id
    and ledger_row.ledger_kind = 'AI';

  result := jsonb_build_object(
    'ledger_id', ledger_id,
    'organization_id', target_organization_id,
    'amount', target_amount,
    'balance', resulting_balance,
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    target_organization_id, auth.uid(), 'platform.ai_credits.allocated', 'credit_ledger',
    ledger_id::text, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

create or replace function public.get_platform_ai_credit_ledger(
  target_organization_id uuid,
  target_before_at timestamptz default null,
  target_before_id uuid default null,
  target_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  if auth.uid() is null
    or not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_MFA_REQUIRED';
  end if;
  if target_organization_id is null
    or target_page_size not in (25, 50, 100)
    or (target_before_at is null) <> (target_before_id is null)
  then
    raise exception using errcode = '22023', message = 'INVALID_AI_CREDIT_LEDGER_CURSOR';
  end if;
  if not exists (
    select 1 from public.organizations organization_row
    where organization_row.id = target_organization_id and organization_row.deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'AI_CREDIT_ORGANIZATION_NOT_FOUND';
  end if;
  with page_rows as materialized (
    select ledger_row.*, profile_row.full_name as created_by_name
    from public.credit_ledger ledger_row
    left join public.profiles profile_row on profile_row.id = ledger_row.created_by
    where ledger_row.organization_id = target_organization_id
      and ledger_row.ledger_kind = 'AI'
      and (
        target_before_at is null
        or (ledger_row.created_at, ledger_row.id) < (target_before_at, target_before_id)
      )
    order by ledger_row.created_at desc, ledger_row.id desc
    limit target_page_size + 1
  ), rows as materialized (
    select * from page_rows
    order by created_at desc, id desc
    limit target_page_size
  )
  select jsonb_build_object(
    'balance', (select coalesce(sum(ledger_row.amount), 0) from public.credit_ledger ledger_row
      where ledger_row.organization_id = target_organization_id and ledger_row.ledger_kind = 'AI'),
    'has_more', (select count(*) > target_page_size from page_rows),
    'next_cursor', (select jsonb_build_object('created_at', row.created_at, 'id', row.id)
      from rows row order by row.created_at asc, row.id asc limit 1),
    'entries', coalesce((select jsonb_agg(jsonb_build_object(
      'id', row.id,
      'transaction_type', row.transaction_type,
      'amount', row.amount,
      'feature', row.feature,
      'source', row.source,
      'reason', row.reason,
      'reference_id', row.reference_id,
      'created_by_name', coalesce(row.created_by_name, 'System'),
      'created_at', row.created_at
    ) order by row.created_at desc, row.id desc) from rows row), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.grant_platform_ai_credits(uuid, bigint, text, uuid)
  from public, anon;
grant execute on function public.grant_platform_ai_credits(uuid, bigint, text, uuid)
  to authenticated;
revoke all on function public.get_platform_ai_credit_ledger(uuid, timestamptz, uuid, integer)
  from public, anon;
grant execute on function public.get_platform_ai_credit_ledger(uuid, timestamptz, uuid, integer)
  to authenticated;

-- Future tenant provisioning must not reintroduce the retired allocation
-- permission. Platform Super Admin is a separate platform role, so it is not
-- part of this tenant-role preset function.
create or replace function public.provision_default_roles(target_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare inserted_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.organizations where id = target_organization_id and deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'ORGANIZATION_NOT_FOUND';
  end if;
  insert into public.roles (organization_id, name, role_key, authority_level, system_role, mfa_required)
  values
    (target_organization_id, 'Business Owner', 'business_owner', 900, true, true),
    (target_organization_id, 'Client Admin', 'client_admin', 850, true, true),
    (target_organization_id, 'System Administrator', 'system_administrator', 800, true, true),
    (target_organization_id, 'GM Sales Executive', 'gm_sales', 700, true, true),
    (target_organization_id, 'Showroom Manager', 'showroom_manager', 600, true, false),
    (target_organization_id, 'Team Manager', 'team_manager', 500, true, false),
    (target_organization_id, 'Sales Consultant', 'sales_consultant', 300, true, false),
    (target_organization_id, 'Telecaller / BDC Executive', 'telecaller_bdc', 300, true, false),
    (target_organization_id, 'Inventory Manager', 'inventory_manager', 450, true, false),
    (target_organization_id, 'Finance Manager', 'finance_manager', 450, true, false),
    (target_organization_id, 'Insurance Manager', 'insurance_manager', 450, true, false),
    (target_organization_id, 'RTO Manager', 'rto_manager', 450, true, false),
    (target_organization_id, 'Used Car / Exchange Manager', 'exchange_manager', 450, true, false),
    (target_organization_id, 'Delivery Manager', 'delivery_manager', 450, true, false),
    (target_organization_id, 'Customer Relationship Manager', 'customer_relationship_manager', 450, true, false),
    (target_organization_id, 'Digital Marketing Manager', 'digital_marketing_manager', 450, true, false)
  on conflict (organization_id, role_key) do update
    set name = excluded.name,
        authority_level = excluded.authority_level,
        mfa_required = excluded.mfa_required;
  get diagnostics inserted_count = row_count;

  insert into public.role_permissions (role_id, permission_id)
  select role_row.id, permission_row.id
  from public.roles role_row
  cross join public.permissions permission_row
  where role_row.organization_id = target_organization_id and (
    (role_row.role_key = 'client_admin' and permission_row.permission_key <> 'credit.allocate')
    or (role_row.role_key = 'system_administrator' and permission_row.permission_key not in ('credit.allocate', 'support.approve'))
    or (role_row.role_key = 'business_owner' and permission_row.permission_key in ('customer.view', 'quotation.view', 'booking.view', 'audit.view', 'credit.view', 'support.request', 'support.approve', 'user.manage', 'integration.view'))
    or (role_row.role_key = 'gm_sales' and permission_row.permission_key in ('customer.view', 'lead.view', 'quotation.view', 'booking.view', 'approval.decide', 'audit.view', 'document.download'))
    or (role_row.role_key = 'showroom_manager' and permission_row.permission_key in ('customer.view', 'customer.link', 'lead.view', 'lead.update', 'lead.assign', 'call.view', 'message.view', 'task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel', 'task.assign', 'test_drive.manage', 'quotation.view', 'quotation.manage', 'booking.view', 'booking.manage', 'approval.decide', 'document.download'))
    or (role_row.role_key = 'team_manager' and permission_row.permission_key in ('customer.view', 'customer.link', 'lead.view', 'lead.update', 'lead.assign', 'call.view', 'message.view', 'task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel', 'task.assign', 'test_drive.manage', 'quotation.view', 'quotation.manage', 'booking.view', 'booking.manage', 'document.download'))
    or (role_row.role_key = 'sales_consultant' and permission_row.permission_key in ('customer.view', 'customer.create', 'customer.link', 'lead.view', 'lead.create', 'lead.update', 'call.view', 'call.create', 'message.view', 'message.send', 'task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel', 'test_drive.manage', 'quotation.view', 'quotation.manage', 'booking.view', 'booking.manage', 'document.upload', 'document.download', 'email.send'))
    or (role_row.role_key = 'telecaller_bdc' and permission_row.permission_key in ('customer.view', 'customer.create', 'customer.link', 'lead.view', 'lead.create', 'lead.update', 'call.view', 'call.create', 'message.view', 'message.send', 'task.view', 'task.create', 'task.update', 'task.complete', 'task.cancel', 'document.upload', 'document.download', 'email.send'))
    or (role_row.role_key in ('inventory_manager', 'finance_manager', 'insurance_manager', 'rto_manager', 'exchange_manager', 'delivery_manager', 'customer_relationship_manager') and permission_row.permission_key in ('customer.view', 'document.upload', 'document.download', 'email.send'))
    or (role_row.role_key = 'digital_marketing_manager' and permission_row.permission_key in ('lead.view', 'document.upload', 'document.download', 'integration.view'))
  ) on conflict do nothing;

  insert into public.audit_logs (organization_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    target_organization_id,
    auth.uid(),
    'role_presets.provisioned',
    'organization',
    target_organization_id::text,
    jsonb_build_object('preset_count', inserted_count)
  );
  return inserted_count;
end;
$$;
revoke all on function public.provision_default_roles(uuid) from public, anon, authenticated;
grant execute on function public.provision_default_roles(uuid) to service_role;

-- Generic credit consumption is not a browser mutation boundary. Every real
-- AI operation reserves credits through a focused service-only RPC so a tenant
-- user cannot drain a balance by inventing a feature, amount, or reason.
revoke all on function public.consume_credits(
  uuid, public.credit_ledger_kind, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.consume_credits(
  uuid, public.credit_ledger_kind, bigint, text, text, text
) to service_role;
