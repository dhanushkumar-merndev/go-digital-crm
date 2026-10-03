begin;

-- Privileged/MFA-bound accounts receive a shorter absolute session. The
-- decision remains centralized in requires_mfa(), so role, explicit profile
-- policy and sensitive all-branch authority cannot drift between clients.
create or replace function app_private.current_session_expires_at(
  target_organization_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select session_row.created_at + case
    when app_private.requires_mfa(target_organization_id) then interval '3 hours'
    else interval '7 days'
  end
  from auth.sessions session_row
  where session_row.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    and session_row.user_id = auth.uid()
  limit 1;
$$;

-- Keep the original access decision in the private schema and expose the new
-- policy name through the public RPC without duplicating its authorization
-- logic. The underlying deadline above is the security boundary.
alter function public.get_access_context() set schema app_private;
alter function app_private.get_access_context() rename to get_access_context_with_legacy_policy;

revoke all on function app_private.get_access_context_with_legacy_policy()
  from public, anon, authenticated;

create function public.get_access_context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with access_context as materialized (
    select app_private.get_access_context_with_legacy_policy() as value
  )
  select case
    when value ->> 'session_policy' = 'SENSITIVE_5_HOURS'
      then pg_catalog.jsonb_set(
        value,
        '{session_policy}',
        pg_catalog.to_jsonb('SENSITIVE_3_HOURS'::text)
      )
    else value
  end
  from access_context;
$$;

revoke all on function app_private.current_session_expires_at(uuid)
  from public, anon, authenticated;
revoke all on function public.get_access_context() from public, anon;
grant execute on function public.get_access_context() to authenticated;

commit;
