-- Personal WhatsApp replies no longer wait a fixed 5 seconds between sends.
-- The inbox now queues replies like WhatsApp does (typed offline, sent in
-- order on reconnect), and the gap made every queued message wait, while the
-- status RPC reported RATE_LIMITED for 5 seconds after each send and hid the
-- composer. Sends stay serialised by the one-in-flight rule
-- (PERSONAL_WHATSAPP_SEND_UNRESOLVED), and the 10 per 10 minutes, 50 per day
-- and 20 per recipient limits are unchanged.
--
-- Both functions are patched from their live definitions, not re-emitted.
do $patch$
declare
  def text;
  old_prepare constant text :=
    'if last_send>now()-interval ''5 seconds'' or ten>=10 or day_count>=50';
  new_prepare constant text := 'if ten>=10 or day_count>=50';
  old_status constant text := 'greatest(max(created_at)+interval ''5 seconds'',';
  new_status constant text := 'greatest(';
begin
  def := pg_get_functiondef(
    'public.personal_whatsapp_send_prepare(uuid,uuid,text)'::regprocedure
  );
  if position(old_prepare in def) = 0 then
    raise exception 'personal_whatsapp_send_prepare: send-gap target not found';
  end if;
  def := replace(def, old_prepare, new_prepare);
  if position('5 seconds' in def) > 0 then
    raise exception 'personal_whatsapp_send_prepare: send-gap patch did not apply';
  end if;
  execute def;

  def := pg_get_functiondef('public.get_personal_whatsapp_status(uuid)'::regprocedure);
  if position(old_status in def) = 0 then
    raise exception 'get_personal_whatsapp_status: send-gap target not found';
  end if;
  def := replace(def, old_status, new_status);
  if position('5 seconds' in def) > 0 then
    raise exception 'get_personal_whatsapp_status: send-gap patch did not apply';
  end if;
  execute def;
end;
$patch$;
