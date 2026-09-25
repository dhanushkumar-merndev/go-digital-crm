-- Row-level-security helpers were LANGUAGE sql functions. Before PostgreSQL 18,
-- SQL functions are re-planned on every call, and these helpers nest several
-- levels deep, so one can_access_record call re-planned a dozen queries.
-- Measured per call as a Sales Consultant: can_access_record 135 ms,
-- has_permission 73 ms, can_access_organization 36 ms. Policies call them per
-- row, so a 25-row list spent seconds in permission checks.
--
-- PL/pgSQL caches statement plans for the session. Each helper below keeps its
-- exact body, wrapped as `return (<body>)`, so the access decision is
-- unchanged. Measured after conversion: 6.0 ms, 2.9 ms and 1.9 ms.
--
-- Only SECURITY DEFINER or search_path-pinned functions are converted: the
-- planner could never inline those into a calling query, so nothing is lost.
-- The body is read from the deployed definition rather than re-emitted here,
-- so later changes to any helper are preserved.
do $convert$
declare
  fn record;
  def text;
  body text;
  new_def text;
begin
  for fn in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prolang = (select oid from pg_language where lanname = 'sql')
      and p.proname in (
        'is_platform_admin', 'session_policy_satisfied', 'requires_mfa', 'mfa_policy_satisfied',
        'has_active_approved_support_session', 'support_session_allows_permission',
        'can_access_organization', 'has_permission', 'actor_scope_includes_branch',
        'can_access_record', 'can_access_lead', 'can_access_customer', 'has_owned_lead',
        'current_tenant_organization', 'can_access_branch'
      )
      and p.prokind = 'f' and not p.proretset
      and (p.prosecdef or p.proconfig is not null)
  loop
    def := pg_get_functiondef(fn.oid);
    body := substring(def from '\$function\$(.*)\$function\$');
    body := regexp_replace(body, ';\s*$', '');
    new_def := regexp_replace(def, 'LANGUAGE sql', 'LANGUAGE plpgsql');
    new_def := replace(new_def, '$function$' || substring(def from '\$function\$(.*)\$function\$') || '$function$',
      '$function$ begin return (' || btrim(body) || '); end; $function$');
    execute new_def;
  end loop;
end
$convert$;
