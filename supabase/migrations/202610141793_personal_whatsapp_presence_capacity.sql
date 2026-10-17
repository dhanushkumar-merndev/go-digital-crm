begin;

-- Personal WhatsApp capacity (owner decision, 2026-10-14): no fixed number cap.
--
-- The old pilot refused a sixth linked number across the whole deployment.
-- Linking is now open to every eligible user; the gateway's real limit is its
-- memory. The CRM reports who is online (personal_whatsapp_presence, pinged by
-- the open web app), so when the gateway is full an online user's socket
-- replaces the one whose owner has been away longest. That user is paused
-- (status IDLE), keeps their link, and reconnects when they come back --
-- WhatsApp delivers what arrived meanwhile. Only when every live socket belongs
-- to someone online is the new one refused: status BUSY, "server busy, try
-- again later".
--
-- Existing bodies are text-patched from the deployed pg_get_functiondef.

alter table public.personal_whatsapp_sessions
  add column if not exists owner_seen_at timestamptz default now();

-- IDLE: paused for someone online, link kept. BUSY: refused, server full.
alter table public.personal_whatsapp_sessions
  drop constraint if exists personal_whatsapp_sessions_status_check;
alter table public.personal_whatsapp_sessions
  add constraint personal_whatsapp_sessions_status_check check (status in (
    'CONNECTING', 'QR_READY', 'CONNECTED', 'RECONNECTING', 'DISCONNECTED', 'LOGGED_OUT',
    'ERROR', 'IDLE', 'BUSY'
  ));

do $patch$
declare
  body text;
  anchor text;
begin
  -- Linking: drop the five-account cap; linking or resuming counts as online.
  body := pg_get_functiondef('public.personal_whatsapp_link_authorize(uuid,uuid)'::regprocedure);
  anchor := '  if (select count(*) from public.personal_whatsapp_sessions where enabled
      and (linked_at is not null or requested_at>now()-interval ''2 minutes'')) >= 5 then
    raise exception ''PERSONAL_WHATSAPP_CAPACITY'';
  end if;
';
  if position(anchor in body) = 0 then raise exception 'LINK_CAP_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '');
  anchor := '  if s.enabled and (s.linked_at is not null or s.requested_at>now()-interval ''2 minutes'') then
    return jsonb_build_object(''connection_id'',cid,''generation'',s.generation);';
  if position(anchor in body) = 0 then raise exception 'LINK_RESUME_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '  if s.enabled and (s.linked_at is not null or s.requested_at>now()-interval ''2 minutes'') then
    update public.personal_whatsapp_sessions set owner_seen_at=now() where connection_id=cid;
    return jsonb_build_object(''connection_id'',cid,''generation'',s.generation);');
  anchor := 'requested_at=now(),linked_at=null,';
  if position(anchor in body) = 0 then raise exception 'LINK_RESET_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, 'requested_at=now(),owner_seen_at=now(),linked_at=null,');
  execute body;

  -- Gateway: a socket paused for an online user keeps its link and keys.
  body := pg_get_functiondef(
    'public.personal_whatsapp_gateway(uuid,uuid,uuid,text,jsonb)'::regprocedure
  );
  anchor := '  elsif target_operation=''release'' then';
  if position(anchor in body) = 0 then raise exception 'GATEWAY_RELEASE_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, '  elsif target_operation=''idle'' then
    update public.personal_whatsapp_sessions set lease_owner=null,lease_until=null,status=''IDLE'',safe_error_code=null where connection_id=s.connection_id;
' || anchor);
  execute body;

  -- Status: a refused socket blocks sending with the "server busy" reason.
  body := pg_get_functiondef('public.get_personal_whatsapp_status(uuid)'::regprocedure);
  anchor := '  reason:=case when not s.enabled or';
  if position(anchor in body) = 0 then raise exception 'STATUS_REASON_ANCHOR_MISSING'; end if;
  body := replace(body, anchor,
    '  reason:=case when s.enabled and s.status=''BUSY'' then ''PERSONAL_WHATSAPP_CAPACITY'' when not s.enabled or');
  execute body;
end;
$patch$;

-- The open CRM reports its user online; returns whether their socket is live,
-- so the app can ask for a reconnect after the user was paused.
create or replace function public.personal_whatsapp_presence()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.personal_whatsapp_sessions%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  select ps.* into s from public.personal_whatsapp_sessions ps
  where ps.owner_user_id = auth.uid() and ps.enabled
    and app_private.personal_whatsapp_owner(ps.organization_id, ps.owner_user_id)
  limit 1;
  if not found then
    return null;
  end if;
  -- One write a minute at most, however many tabs ping.
  if s.owner_seen_at is null or s.owner_seen_at < now() - interval '1 minute' then
    update public.personal_whatsapp_sessions set owner_seen_at = now()
    where connection_id = s.connection_id;
  end if;
  return jsonb_build_object(
    'connection_id', s.connection_id,
    'status', s.status,
    'linked', s.linked_at is not null,
    'live', s.status = 'CONNECTED' and s.lease_until > now()
  );
end;
$$;

revoke all on function public.personal_whatsapp_presence() from public, anon;
grant execute on function public.personal_whatsapp_presence() to authenticated;

-- The gateway could not open a socket: a new link is cancelled, an existing one
-- waits as BUSY until a socket frees up.
create or replace function public.personal_whatsapp_capacity_wait(
  target_connection_id uuid,
  target_generation uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.personal_whatsapp_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into s from public.personal_whatsapp_sessions
  where connection_id = target_connection_id for update;
  if not found or not s.enabled or s.generation <> target_generation
    or (s.lease_until is not null and s.lease_until > now()) then
    return null;
  end if;
  if s.linked_at is null then
    update public.personal_whatsapp_sessions set
      enabled = false, status = 'ERROR', safe_error_code = 'PERSONAL_WHATSAPP_CAPACITY'
    where connection_id = s.connection_id;
    delete from public.personal_whatsapp_qr_attempts where connection_id = s.connection_id;
    update public.connected_accounts set status = 'DISCONNECTED' where id = s.connection_id;
    return 'CANCELLED';
  end if;
  update public.personal_whatsapp_sessions set
    status = 'BUSY', safe_error_code = 'PERSONAL_WHATSAPP_CAPACITY'
  where connection_id = s.connection_id;
  return 'BUSY';
end;
$$;

revoke all on function public.personal_whatsapp_capacity_wait(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.personal_whatsapp_capacity_wait(uuid, uuid) to service_role;

commit;
