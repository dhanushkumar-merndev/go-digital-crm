begin;

-- `returns table (lead_id uuid, ...)` declares an OUT variable named lead_id,
-- which collides with the column of the same name in the ON CONFLICT inference
-- list: plpgsql resolves it to the variable and every write raised
-- `column reference "lead_id" is ambiguous`. Pin and star writes have failed
-- since the feature was introduced. Naming the primary key constraint outright
-- removes the inference list, so no column name is resolved by name at all.
drop function if exists public.set_my_lead_preference(uuid, boolean, boolean);

create function public.set_my_lead_preference(
  target_lead_id uuid,
  target_pinned boolean,
  target_starred boolean
)
returns table (lead_id uuid, pinned boolean, starred boolean, pinned_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  access_context jsonb;
  current_organization_id uuid;
  existing_pinned_at timestamptz;
  next_pinned_at timestamptz;
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

    return query select target_lead_id, false, false, null::timestamptz;
    return;
  end if;

  select preference_row.pinned_at into existing_pinned_at
  from public.user_lead_preferences preference_row
  where preference_row.organization_id = current_organization_id
    and preference_row.user_id = auth.uid()
    and preference_row.lead_id = target_lead_id
    and preference_row.pinned;

  -- A fresh pin stamps now() and jumps to the top; toggling the star on an
  -- already pinned lead must not reshuffle it, so the stamp is preserved.
  if target_pinned then
    next_pinned_at := coalesce(existing_pinned_at, now());
  else
    next_pinned_at := null;
  end if;

  insert into public.user_lead_preferences (
    organization_id, user_id, lead_id, pinned, starred, pinned_at, updated_at
  )
  values (
    current_organization_id, auth.uid(), target_lead_id,
    target_pinned, target_starred, next_pinned_at, now()
  )
  on conflict on constraint user_lead_preferences_pkey do update
    set pinned = excluded.pinned,
        starred = excluded.starred,
        pinned_at = excluded.pinned_at,
        updated_at = excluded.updated_at;

  return query select target_lead_id, target_pinned, target_starred, next_pinned_at;
end;
$$;

revoke all on function public.set_my_lead_preference(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_my_lead_preference(uuid, boolean, boolean) to authenticated;

commit;
