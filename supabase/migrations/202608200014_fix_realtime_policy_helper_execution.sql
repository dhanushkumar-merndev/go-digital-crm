begin;

-- The realtime.messages broadcast policies call these two helpers, and a policy
-- expression is evaluated as the *calling* role -- SECURITY DEFINER changes the
-- body's privileges, never the caller's right to invoke the function itself.
-- 202608150013 revoked EXECUTE from authenticated alongside the two broadcast
-- trigger functions, but those two are only ever reached through a trigger
-- (owner context), whereas these two are reached through the policy. Every
-- authenticated subscribe therefore raised 42501 "permission denied for
-- function realtime_topic_organization", and the client retried on a ~4s loop,
-- so tenant realtime never delivered and the retry storm scaled with sessions.
--
-- Same class of defect as 202608150034 (directory policy helper). Both helpers
-- take no arguments, read only realtime.topic() from the current session, and
-- return the organization id / resource name parsed out of that topic string --
-- they expose nothing the subscriber has not already named in its own topic,
-- and the surrounding policy still gates on can_access_organization() plus the
-- per-resource has_permission() checks.
grant execute on function app_private.realtime_topic_organization() to authenticated;
grant execute on function app_private.realtime_topic_resource() to authenticated;

commit;
