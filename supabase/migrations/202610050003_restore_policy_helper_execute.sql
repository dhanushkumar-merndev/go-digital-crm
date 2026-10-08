begin;

-- RLS policies call these helpers, and PostgreSQL checks EXECUTE on a function
-- even when a policy is what calls it. Without the grant, a read that reaches
-- the helper fails with 42501 instead of filtering rows.
--
-- 202608150034 granted can_administer_tenant_user for exactly this reason;
-- 202608240010 then re-ran a blanket revoke and undid it. A Super Admin has no
-- tenant, so the profiles/role/team policies always fall through to this
-- helper: the Dealerships page (organizations -> profiles) failed with
-- "permission denied for function can_administer_tenant_user".
--
-- The escalation and operational-case read policies call theirs
-- unconditionally, so any direct read of those tables hit the same error.
--
-- Each helper is SECURITY DEFINER with a pinned search_path and returns only a
-- boolean after checking the caller's own tenant, permission and scope.
grant execute on function app_private.can_administer_tenant_user(uuid, uuid, text)
  to authenticated;
grant execute on function app_private.can_access_sales_escalation(uuid, uuid)
  to authenticated;
grant execute on function app_private.operational_case_permission(uuid, text, text)
  to authenticated;

commit;
