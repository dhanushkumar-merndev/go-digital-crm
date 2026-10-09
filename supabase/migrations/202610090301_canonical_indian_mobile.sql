begin;

-- One Indian mobile was being stored two ways. create_lead keeps the number as
-- typed, so "8593939234" landed beside "+918593939234" from every other entry
-- path. Customer matching, the same-mobile lead group and the phone enquiry
-- list all compare digits, and 8593939234 <> 918593939234, so a repeat enquiry
-- from a known customer showed no possible match and offered "Create customer".
--
-- Canonicalise at write time on both tables instead of teaching every reader a
-- fuzzy comparison: a bare 10-digit Indian mobile (optionally with a trunk 0)
-- gets +91. Anything already carrying a country code, and anything that is not
-- a 6-9 mobile, is left exactly as written.

create or replace function app_private.canonical_indian_mobile(input_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case
    when input_value is null then null
    when btrim(input_value) !~ '^[+]'
      and regexp_replace(input_value, '[^0-9]', '', 'g') ~ '^0?[6-9][0-9]{9}$'
      then '+91' || right(regexp_replace(input_value, '[^0-9]', '', 'g'), 10)
    else input_value
  end;
$$;

create or replace function app_private.canonicalize_normalized_phone()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.normalized_phone := app_private.canonical_indian_mobile(new.normalized_phone);
  return new;
end;
$$;

drop trigger if exists canonicalize_normalized_phone on public.leads;
create trigger canonicalize_normalized_phone
  before insert or update of normalized_phone on public.leads
  for each row execute function app_private.canonicalize_normalized_phone();

drop trigger if exists canonicalize_normalized_phone on public.customers;
create trigger canonicalize_normalized_phone
  before insert or update of normalized_phone on public.customers
  for each row execute function app_private.canonicalize_normalized_phone();

-- Existing bare numbers. The trigger rewrites the value; the WHERE keeps this to
-- the handful of rows that need it.
update public.leads
set normalized_phone = normalized_phone
where normalized_phone ~ '^0?[6-9][0-9]{9}$';

update public.customers
set normalized_phone = normalized_phone
where normalized_phone ~ '^0?[6-9][0-9]{9}$';

commit;
