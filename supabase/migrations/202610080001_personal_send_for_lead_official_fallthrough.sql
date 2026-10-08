-- send-message tries the personal WhatsApp path first for every text reply and
-- falls through to the official WhatsApp path only on PERSONAL_WHATSAPP_NOT_FOUND.
-- For an official conversation there is no personal_whatsapp_conversations row,
-- so current_lead was NULL and any lead-linked official thread failed with
-- LEAD_CONTEXT_CHANGED before the official path ran. Report "not a personal
-- thread" instead; the official path re-checks the lead in its own trigger.
create or replace function public.personal_whatsapp_send_for_lead(
  target_conversation_id uuid,
  target_application_message_id uuid,
  target_body text,
  expected_lead_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare current_lead uuid;
begin
  if not exists(select 1 from app_private.accessible_inbox_threads where id=target_conversation_id) then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  select lead_id into current_lead from public.personal_whatsapp_conversations where id=target_conversation_id for update;
  if not found then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'; end if;
  if current_lead is distinct from expected_lead_id then raise exception 'LEAD_CONTEXT_CHANGED'; end if;
  return public.personal_whatsapp_send_prepare(target_conversation_id,target_application_message_id,target_body);
end;
$function$;
