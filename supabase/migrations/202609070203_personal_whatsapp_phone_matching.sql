begin;

-- WhatsApp phone JIDs are E.164 digits without a leading plus. Existing Indian
-- CRM rows can contain either that representation or the local ten-digit form.
-- Keep this equivalence deliberately narrow; arbitrary suffix matching could
-- join contacts from different countries.
create or replace function app_private.personal_whatsapp_phone_equivalent(
  stored_number text,
  provider_number text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with normalized as (
    select
      regexp_replace(coalesce(stored_number, ''), '[^0-9]', '', 'g') as stored_digits,
      regexp_replace(coalesce(provider_number, ''), '[^0-9]', '', 'g') as provider_digits
  )
  select stored_digits <> '' and provider_digits <> '' and (
    stored_digits = provider_digits
    or (
      length(stored_digits) = 10
      and length(provider_digits) = 12
      and left(provider_digits, 2) = '91'
      and stored_digits = right(provider_digits, 10)
    )
    or (
      length(provider_digits) = 10
      and length(stored_digits) = 12
      and left(stored_digits, 2) = '91'
      and provider_digits = right(stored_digits, 10)
    )
  )
  from normalized;
$$;

create or replace function app_private.personal_whatsapp_contact_candidates(
  actor uuid,
  org uuid,
  contact_number text
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_agg(distinct identity_id)
  from (
    select coalesce(l.customer_id, l.id) as identity_id
    from public.leads l
    where l.organization_id = org
      and l.deleted_at is null
      and app_private.personal_whatsapp_phone_equivalent(l.normalized_phone, contact_number)
      and app_private.personal_whatsapp_actor_record(actor, org, l.id, null)
    union
    select c.id
    from public.customers c
    where c.organization_id = org
      and c.deleted_at is null
      and app_private.personal_whatsapp_phone_equivalent(c.normalized_phone, contact_number)
      and app_private.personal_whatsapp_actor_record(actor, org, null, c.id)
  ) matches;
$$;

revoke all on function app_private.personal_whatsapp_phone_equivalent(text, text)
  from public, anon, authenticated;
revoke all on function app_private.personal_whatsapp_contact_candidates(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function app_private.personal_whatsapp_phone_equivalent(text, text)
  to service_role;
grant execute on function app_private.personal_whatsapp_contact_candidates(uuid, uuid, text)
  to service_role;

commit;
