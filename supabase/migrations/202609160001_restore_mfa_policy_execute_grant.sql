begin;

-- 202609010002_role_session_timeboxes revoked EXECUTE on the three session
-- helpers from `authenticated` together. That is correct for two of them:
-- `current_session_expires_at` and `session_policy_satisfied` are only ever
-- reached from inside `mfa_policy_satisfied`, which is SECURITY DEFINER, so
-- they run as the definer and never need the caller's privilege.
--
-- `mfa_policy_satisfied` is different. It is named directly in the restrictive
-- `require_privileged_mfa` policy on connected_accounts, roles,
-- user_role_assignments, credit_ledger, support_access_requests,
-- support_sessions, audit_logs, deletion_requests and purge_jobs, and in
-- `require_role_permission_mfa` on role_permissions. A policy expression is
-- evaluated as the querying role, so `authenticated` must be able to execute
-- it. Without the grant every read of those tables fails with
-- `42501 permission denied for function mfa_policy_satisfied` instead of
-- returning zero rows -- which is what made the Integrations workspace render
-- its "Integrations are unavailable" fallback for a fully authorized Client
-- Admin.
--
-- CREATE OR REPLACE FUNCTION does not restore privileges, so re-running the
-- earlier migrations does not undo the revoke. Granting to `authenticated`
-- alone is narrower than the PUBLIC default the function carried before.
grant execute on function app_private.mfa_policy_satisfied(uuid) to authenticated;

commit;
