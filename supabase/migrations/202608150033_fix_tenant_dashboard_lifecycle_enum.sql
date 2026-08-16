begin;

-- `leads.lifecycle_status` is a public.lead_lifecycle enum. PostgreSQL does
-- not implicitly coerce it to the text-only helper used by the dashboard.
-- Keep the text helper for other callers and add this exact overload so the
-- tenant dashboard can execute for every scoped lead-viewing role.
create or replace function app_private.dashboard_lifecycle_label(target_status public.lead_lifecycle)
returns text
language sql
immutable
set search_path = ''
as $$
  select app_private.dashboard_lifecycle_label(target_status::text);
$$;

revoke all on function app_private.dashboard_lifecycle_label(public.lead_lifecycle)
  from public, anon, authenticated;

commit;
