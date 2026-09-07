begin;

-- PostgreSQL checks every function referenced by an RLS expression, including
-- helpers in CASE/OR branches for other topics. Private helpers are deliberately
-- not browser-callable. Evaluate the existing authorization expressions inside
-- narrowly scoped SECURITY DEFINER functions instead of granting those helpers.
-- The topic, identity, tenant, permissions, session and MFA checks are preserved.
do $$
declare
  policy_row record;
  helper_name text;
begin
  for policy_row in
    select policyname, qual from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname in ('crm_tenant_broadcast_read', 'crm_platform_broadcast_read')
  loop
    helper_name := policy_row.policyname || '_allowed';
    execute format(
      'create or replace function app_private.%I(extension text)
       returns boolean language sql stable security definer set search_path = ''''
       as %L', helper_name, 'select ' || policy_row.qual
    );
    execute format('revoke all on function app_private.%I(text) from public, anon', helper_name);
    execute format('grant execute on function app_private.%I(text) to authenticated', helper_name);
    execute format(
      'alter policy %I on realtime.messages using (app_private.%I(extension))',
      policy_row.policyname, helper_name
    );
  end loop;
end;
$$;

commit;
