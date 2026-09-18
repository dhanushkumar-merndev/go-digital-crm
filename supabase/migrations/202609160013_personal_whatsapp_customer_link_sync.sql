begin;

-- Follow an explicit lead/customer link, never infer a customer from a phone match.
create function app_private.sync_personal_whatsapp_lead_customer()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.customer_id is null and new.customer_id is not null then
    update public.personal_whatsapp_conversations c
      set customer_id = new.customer_id
      where c.organization_id = new.organization_id and c.lead_id = new.id
        and c.customer_id is null and c.deleted_at is null
        and app_private.personal_whatsapp_phone_equivalent(new.normalized_phone, c.normalized_contact);
  end if;
  return new;
end;
$$;
revoke all on function app_private.sync_personal_whatsapp_lead_customer() from public, anon, authenticated;
create trigger sync_personal_whatsapp_lead_customer
after update of customer_id on public.leads
for each row execute function app_private.sync_personal_whatsapp_lead_customer();

update public.personal_whatsapp_conversations c
set customer_id = l.customer_id
from public.leads l
where l.id = c.lead_id and l.organization_id = c.organization_id
  and l.customer_id is not null and c.customer_id is null
  and l.deleted_at is null and c.deleted_at is null
  and app_private.personal_whatsapp_phone_equivalent(l.normalized_phone, c.normalized_contact);

-- Claim assigns the provider ID atomically BEFORE attempting a send. A missing
-- ID proves these old "unknown" rows never reached WhatsApp; don't resend them.
update public.personal_whatsapp_messages
set delivery_status = 'FAILED', safe_error_code = 'PERSONAL_WHATSAPP_SEND_NOT_CLAIMED'
where origin = 'CRM' and delivery_status in ('UNKNOWN', 'UNCONFIRMED')
  and provider_message_id is null;

-- Release only pauses attributable to the rejected, unclaimed attempts.
update public.personal_whatsapp_sessions s set paused_until = null
where s.paused_until > now()
  and exists (select 1 from public.personal_whatsapp_messages m
    where m.connection_id = s.connection_id
      and m.safe_error_code = 'PERSONAL_WHATSAPP_SEND_NOT_CLAIMED'
      and m.failed_at > now() - interval '10 minutes')
  and not exists (select 1 from public.personal_whatsapp_messages m
    where m.connection_id = s.connection_id and m.provider_message_id is not null
      and m.failed_at > now() - interval '10 minutes');

commit;
