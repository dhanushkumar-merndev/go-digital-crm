begin;

-- The profiles, role-assignment and team-member RLS policies call this helper.
-- PostgreSQL checks function EXECUTE even when it is evaluated from a policy;
-- the prior blanket revoke therefore turned an allowed profile lookup into a
-- 42501 error. The helper itself is SECURITY DEFINER and returns only a
-- boolean after enforcing the caller's active tenant, authority and scope.
grant execute on function app_private.can_administer_tenant_user(uuid, uuid, text)
  to authenticated;

commit;
