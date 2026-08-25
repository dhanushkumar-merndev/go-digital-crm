begin;

-- Pins and stars are personal workspace preferences, not shared lead state.
-- The flags therefore remain private to the authenticated user while syncing
-- safely between that user's desktop and mobile sessions.
create table if not exists public.user_lead_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  pinned boolean not null default false,
  starred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, lead_id),
  check (pinned or starred)
);

create index if not exists user_lead_preferences_user_updated_idx
  on public.user_lead_preferences (organization_id, user_id, updated_at desc);

alter table public.user_lead_preferences enable row level security;
revoke all on public.user_lead_preferences from public, anon, authenticated;

create or replace function public.get_my_lead_preferences()
returns table (lead_id uuid, pinned boolean, starred boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM' or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'LEAD_PREFERENCE_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  return query
  select preference_row.lead_id, preference_row.pinned, preference_row.starred
  from public.user_lead_preferences preference_row
  where preference_row.organization_id = current_organization_id
    and preference_row.user_id = auth.uid()
    and app_private.can_access_lead(preference_row.lead_id)
  order by preference_row.updated_at desc;
end;
$$;

create or replace function public.set_my_lead_preference(
  target_lead_id uuid,
  target_pinned boolean,
  target_starred boolean
)
returns table (lead_id uuid, pinned boolean, starred boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  access_context := public.get_access_context();
  if access_context->>'destination' <> 'CRM' or access_context->>'organization_id' is null then
    raise exception using errcode = '42501', message = 'LEAD_PREFERENCE_ACCESS_REQUIRED';
  end if;
  current_organization_id := (access_context->>'organization_id')::uuid;

  if not exists (
    select 1
    from public.leads lead_row
    where lead_row.id = target_lead_id
      and lead_row.organization_id = current_organization_id
      and lead_row.deleted_at is null
      and app_private.can_access_lead(lead_row.id)
  ) then
    raise exception using errcode = '42501', message = 'LEAD_PREFERENCE_SCOPE_DENIED';
  end if;

  if not target_pinned and not target_starred then
    delete from public.user_lead_preferences preference_row
    where preference_row.organization_id = current_organization_id
      and preference_row.user_id = auth.uid()
      and preference_row.lead_id = target_lead_id;
  else
    insert into public.user_lead_preferences (
      organization_id, user_id, lead_id, pinned, starred, updated_at
    )
    values (
      current_organization_id, auth.uid(), target_lead_id,
      target_pinned, target_starred, now()
    )
    on conflict (organization_id, user_id, lead_id) do update
      set pinned = excluded.pinned,
          starred = excluded.starred,
          updated_at = excluded.updated_at;
  end if;

  return query select target_lead_id, target_pinned, target_starred;
end;
$$;

revoke all on function public.get_my_lead_preferences() from public, anon;
grant execute on function public.get_my_lead_preferences() to authenticated;
revoke all on function public.set_my_lead_preference(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_my_lead_preference(uuid, boolean, boolean) to authenticated;

commit;
