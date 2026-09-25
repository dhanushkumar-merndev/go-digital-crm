-- Migration 0003 moved the core access helpers from LANGUAGE sql to PL/pgSQL
-- because, before PostgreSQL 18, a SQL function that the planner cannot inline
-- is re-planned on every call. SECURITY DEFINER and search_path-pinned
-- functions are never inlined, and about sixty of them were still SQL,
-- including the scope resolvers every list and dashboard RPC runs first.
-- Measured on a warm connection as the Telecaller:
-- resolve_dashboard_record_scope 70-100 ms per call, three calls per
-- dashboard live-items request.
--
-- The same conversion is applied to every remaining STABLE one. Each body is
-- read from the deployed definition and kept as is:
--   * scalar functions return `(<body>)`, as in 0003;
--   * set-returning functions `return query <body>`;
--   * `#variable_conflict use_column` keeps the SQL-function rule that a column
--     name wins over a parameter or OUT column of the same name.
-- Volatile functions, SQL-standard (BEGIN ATOMIC) bodies and scalar functions
-- returning a composite are left alone.
do $convert$
declare
  fn record;
  def text;
  old_body text;
  body text;
  new_def text;
  converted integer := 0;
begin
  for fn in
    select procedure_row.oid, procedure_row.proretset
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    join pg_catalog.pg_type return_type on return_type.oid = procedure_row.prorettype
    where namespace_row.nspname in ('public', 'app_private')
      and procedure_row.prolang = (select oid from pg_catalog.pg_language where lanname = 'sql')
      and procedure_row.prokind = 'f'
      and procedure_row.provolatile = 's'
      and procedure_row.prosqlbody is null
      and (procedure_row.prosecdef or procedure_row.proconfig is not null)
      and (procedure_row.proretset or return_type.typtype not in ('c', 'p'))
  loop
    def := pg_catalog.pg_get_functiondef(fn.oid);
    old_body := substring(def from '\$function\$(.*)\$function\$');
    if old_body is null then
      raise exception 'Unexpected definition quoting for %', fn.oid::regprocedure;
    end if;
    body := btrim(regexp_replace(old_body, ';\s*$', ''));
    if position(';' in body) > 0 then
      -- More than one statement; the last one would be the result. Not expected
      -- among these helpers, so stop rather than guess.
      raise exception 'Multi-statement SQL body in %', fn.oid::regprocedure;
    end if;
    new_def := regexp_replace(def, 'LANGUAGE sql', 'LANGUAGE plpgsql');
    new_def := replace(
      new_def,
      '$function$' || old_body || '$function$',
      '$function$' || E'\n#variable_conflict use_column\nbegin\n'
        || case when fn.proretset
          then 'return query ' || body || E';\nreturn;\n'
          else 'return (' || body || E');\n'
        end
        || 'end;' || E'\n$function$'
    );
    execute new_def;
    converted := converted + 1;
  end loop;
  raise notice 'Converted % SQL helpers to PL/pgSQL', converted;
end
$convert$;

-- PL/pgSQL still re-plans a statement with its actual arguments for the first
-- five calls on each connection before it settles on a cached plan, and the
-- REST pool spreads requests over many connections, so users kept paying the
-- planning cost. For the access and scope helpers the plan does not depend on
-- the argument values (they look up the caller's own roles, branches and teams
-- by id), so they use the cached generic plan from the first call. Measured:
-- resolve_dashboard_record_scope 100, 74, 72, 5 ms over its first four calls
-- -> 54 ms once, then 1.2 ms.
-- List RPCs are not changed: their optional filters (`x is null or col = x`)
-- need per-call plans to use the right index at scale.
do $generic$
declare
  fn record;
  tuned integer := 0;
begin
  for fn in
    select procedure_row.oid
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where procedure_row.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
      and (
        (namespace_row.nspname = 'public' and procedure_row.proname = 'get_access_context')
        or (namespace_row.nspname = 'app_private' and procedure_row.proname in (
          -- converted in 0003
          'is_platform_admin', 'session_policy_satisfied', 'requires_mfa', 'mfa_policy_satisfied',
          'has_active_approved_support_session', 'support_session_allows_permission',
          'can_access_organization', 'has_permission', 'actor_scope_includes_branch',
          'can_access_record', 'can_access_lead', 'can_access_customer', 'has_owned_lead',
          'current_tenant_organization', 'can_access_branch',
          -- converted above
          'resolve_dashboard_record_scope', 'resolve_permission_record_scope',
          'resolve_sales_lead_workspace_scope', 'resolve_self_assigned_lead_team',
          'actor_has_tenant_operation_context', 'crm_tenant_broadcast_read_allowed',
          'crm_platform_broadcast_read_allowed', 'can_access_sales_escalation',
          'tenant_user_mode_allowed', 'user_scope_includes_branch', 'user_can_receive_work',
          'sales_consultant_allowed_branches', 'sales_consultant_permissions',
          'customer_360_visible', 'permission_bound_active_branch_ids',
          'is_tenant_support_controller', 'operational_case_permission', 'actor_branch_scope',
          'user_has_team_member_role', 'has_organization_wide_scope', 'is_client_admin',
          'is_team_manager', 'current_session_expires_at', 'actor_can_administer_user',
          'can_access_team', 'can_access_conversation', 'can_access_test_drive',
          'can_access_quotation', 'can_access_booking', 'can_access_inventory_unit',
          'can_access_call', 'can_access_connection',
          -- resolved-scope helpers from 0006
          'resolve_customer_access_scope', 'actor_owned_lead_ids'
        ))
      )
  loop
    execute format('alter function %s set plan_cache_mode = force_generic_plan',
      fn.oid::regprocedure);
    tuned := tuned + 1;
  end loop;
  if tuned < 50 then
    raise exception 'Expected at least 50 helpers to tune, found %', tuned;
  end if;
  raise notice 'Pinned % helpers to cached generic plans', tuned;
end
$generic$;
