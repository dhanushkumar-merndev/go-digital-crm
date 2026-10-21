-- Quotation discount approval was hard-coded: save_quotation sent any quotation
-- whose discount exceeded 10% of the gross amount for approval. AGENTS.md 27
-- says approval limits are configuration, not code. This adds the rule the
-- Client Admin sets on Targets & Approval Rules -- one organization-wide limit,
-- optionally overridden per branch -- and makes save_quotation read it.
--
-- Until an administrator saves a rule the limit stays at the 10% the CRM has
-- always used, so applying the migration changes no quotation's outcome.
-- Rules are switched off, never deleted, and every save is audited.

begin;

create table public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  approval_type text not null default 'QUOTATION_DISCOUNT',
  branch_id uuid references public.branches(id),
  max_discount_percent numeric(5,2) not null,
  active boolean not null default true,
  version bigint not null default 1,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (approval_type in ('QUOTATION_DISCOUNT')),
  check (max_discount_percent >= 0 and max_discount_percent <= 100),
  check (version > 0)
);

-- One rule per organization, type and branch; the organization-wide rule is
-- the row with no branch.
create unique index approval_rules_scope_unique_idx
  on public.approval_rules (
    organization_id, approval_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

alter table public.approval_rules enable row level security;
revoke all on public.approval_rules from anon, authenticated;
-- Reads go through get_approval_rules; nothing reads the table directly.

-- The discount (as a percent of the gross amount) above which a quotation in
-- this branch needs approval: the branch rule, else the organization rule,
-- else the CRM's original 10%.
create or replace function app_private.quotation_discount_approval_percent(
  target_organization_id uuid,
  target_branch_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select rule_row.max_discount_percent
      from public.approval_rules rule_row
      where rule_row.organization_id = target_organization_id
        and rule_row.approval_type = 'QUOTATION_DISCOUNT'
        and rule_row.active
        and (rule_row.branch_id = target_branch_id or rule_row.branch_id is null)
      order by (rule_row.branch_id is null)
      limit 1
    ),
    10
  );
$$;
revoke all on function app_private.quotation_discount_approval_percent(uuid, uuid)
  from public, anon, authenticated;

-- Shared gate: an organization-wide, MFA-assured Client Admin with user.manage
-- (the same authority that configures targets). Business Owners may read.
create or replace function app_private.approval_rule_admin_allowed(
  target_organization_id uuid,
  allow_owner boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and target_organization_id is not null
    and app_private.mfa_policy_satisfied(target_organization_id)
    and app_private.has_organization_wide_scope(target_organization_id)
    and exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = target_organization_id
        and assignment_row.active
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        and (
          (role_row.role_key = 'client_admin'
            and app_private.has_permission(target_organization_id, 'user.manage'))
          or (allow_owner and role_row.role_key = 'business_owner')
        )
    );
$$;
revoke all on function app_private.approval_rule_admin_allowed(uuid, boolean)
  from public, anon, authenticated;

create or replace function public.get_approval_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
begin
  if not app_private.approval_rule_admin_allowed(current_organization_id, true) then
    raise exception using errcode = '42501', message = 'APPROVAL_RULES_ACCESS_REQUIRED';
  end if;

  return jsonb_build_object(
    'default_percent', 10,
    'can_manage', app_private.approval_rule_admin_allowed(current_organization_id, false),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rule_row.id,
        'branch_id', rule_row.branch_id,
        'branch_name', branch_row.name,
        'max_discount_percent', rule_row.max_discount_percent,
        'active', rule_row.active,
        'version', rule_row.version,
        'updated_at', rule_row.updated_at,
        'updated_by_name', profile_row.full_name
      ) order by rule_row.branch_id is not null, branch_row.name)
      from public.approval_rules rule_row
      left join public.branches branch_row
        on branch_row.organization_id = rule_row.organization_id
       and branch_row.id = rule_row.branch_id
      left join public.profiles profile_row on profile_row.id = rule_row.updated_by
      where rule_row.organization_id = current_organization_id
        and rule_row.approval_type = 'QUOTATION_DISCOUNT'
    ), '[]'::jsonb),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', branch_row.id, 'name', branch_row.name)
        order by branch_row.name)
      from public.branches branch_row
      where branch_row.organization_id = current_organization_id
        and branch_row.active
        and branch_row.deleted_at is null
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_approval_rule(
  target_rule_id uuid,
  expected_version bigint,
  target_branch_id uuid,
  target_max_discount_percent numeric,
  target_active boolean,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.current_tenant_organization();
  saved public.approval_rules%rowtype;
  previous jsonb;
begin
  if target_max_discount_percent is null
    or target_max_discount_percent < 0
    or target_max_discount_percent > 100
    or target_active is null
    or target_request_id is null
  then
    raise exception using errcode = '22023', message = 'INVALID_APPROVAL_RULE';
  end if;
  if not app_private.approval_rule_admin_allowed(current_organization_id, false) then
    raise exception using errcode = '42501', message = 'APPROVAL_RULES_MANAGE_REQUIRED';
  end if;
  if target_branch_id is not null and not exists (
    select 1 from public.branches branch_row
    where branch_row.id = target_branch_id
      and branch_row.organization_id = current_organization_id
      and branch_row.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'APPROVAL_RULE_BRANCH_DENIED';
  end if;

  if target_rule_id is null then
    begin
      insert into public.approval_rules (
        organization_id, branch_id, max_discount_percent, active, updated_by
      ) values (
        current_organization_id, target_branch_id, round(target_max_discount_percent, 2),
        target_active, auth.uid()
      )
      returning * into saved;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'APPROVAL_RULE_ALREADY_EXISTS';
    end;
  else
    select to_jsonb(rule_row) into previous
    from public.approval_rules rule_row
    where rule_row.id = target_rule_id
      and rule_row.organization_id = current_organization_id
    for update;
    if previous is null then
      raise exception using errcode = 'P0002', message = 'APPROVAL_RULE_NOT_FOUND';
    end if;
    -- The branch is the rule's identity; changing it is a new rule.
    if (previous->>'branch_id')::uuid is distinct from target_branch_id then
      raise exception using errcode = '22023', message = 'APPROVAL_RULE_BRANCH_IMMUTABLE';
    end if;
    update public.approval_rules rule_row
    set max_discount_percent = round(target_max_discount_percent, 2),
        active = target_active,
        version = rule_row.version + 1,
        updated_by = auth.uid(),
        updated_at = now()
    where rule_row.id = target_rule_id
      and rule_row.organization_id = current_organization_id
      and rule_row.version = expected_version
    returning * into saved;
    if saved.id is null then
      raise exception using errcode = 'PT409', message = 'APPROVAL_RULE_VERSION_CONFLICT';
    end if;
  end if;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, branch_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'approval_rule.saved', 'approval_rule',
    saved.id::text, saved.branch_id, target_request_id,
    jsonb_build_object('before', previous, 'after', to_jsonb(saved))
  );

  return jsonb_build_object(
    'id', saved.id,
    'branch_id', saved.branch_id,
    'max_discount_percent', saved.max_discount_percent,
    'active', saved.active,
    'version', saved.version,
    'updated_at', saved.updated_at
  );
end;
$$;

revoke all on function public.get_approval_rules() from public, anon;
grant execute on function public.get_approval_rules() to authenticated;
revoke all on function public.save_approval_rule(uuid, bigint, uuid, numeric, boolean, uuid)
  from public, anon;
grant execute on function public.save_approval_rule(uuid, bigint, uuid, numeric, boolean, uuid)
  to authenticated;

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

select pg_temp.patch_function(
  'public.save_quotation(uuid,bigint,uuid,jsonb,uuid)',
  $old$requires_approval := discount_amount > gross_amount * 0.10;$old$,
  $new$requires_approval := discount_amount > gross_amount
    * app_private.quotation_discount_approval_percent(current_organization_id, lead_row.branch_id)
    / 100.0;$new$
);

commit;
