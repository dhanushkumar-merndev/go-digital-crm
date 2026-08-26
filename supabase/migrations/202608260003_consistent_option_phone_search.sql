create or replace function app_private.phone_search_key(input_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select right(pg_catalog.regexp_replace(coalesce(input_value, ''), '[^0-9]', '', 'g'), 10);
$$;

revoke all on function app_private.phone_search_key(text) from public, anon;
-- Needed at index-maintenance time by scoped browser sessions that insert
-- leads and customers, the same grant `normalize_phone_digits` carries.
grant execute on function app_private.phone_search_key(text)
  to authenticated, service_role;

-- Index built outside the transaction so the option lists stay available while
-- it is created. `phone_search_key` is immutable, so it can back an index.
create index concurrently if not exists customers_org_phone_search_key_idx
  on public.customers (
    organization_id,
    app_private.phone_search_key(coalesce(normalized_phone, primary_phone))
    text_pattern_ops
  )
  where deleted_at is null
    and coalesce(normalized_phone, primary_phone) is not null;

begin;

-- Four dropdowns over the same kind of field matched a phone number four
-- different ways:
--
--   test drive / quotation / booking / task : digits(stored) = digits(typed)
--   appointments and follow-ups             : digits(stored) LIKE digits(typed)%
--
-- Under exact equality, a number stored as '+919800000002' matched only when
-- the consultant typed the country code too; typing the ten digits they read
-- off the customer's record returned nothing, and the dropdown showed an empty
-- popup with no explanation. Under the prefix rule the failure was the mirror
-- image: typing the local number could not match a stored '+91…'.
--
-- Both are the same mistake — comparing numbers that are written differently.
-- The last ten digits are the part that identifies an Indian subscriber
-- regardless of how the country code was entered, so that is what both sides
-- are reduced to before comparing. Prefix matching on that key keeps partial
-- numbers working and keeps the comparison index-backed.

do $migration$
declare
  target record;
  definition text;
  updated_definition text;
begin
  for target in
    select *
    from (
      values
        (
          'public.get_test_drive_lead_options(text,integer)',
          E'          app_private.normalize_phone_digits(normalized_search) <> ''''\n'
          || E'          and app_private.normalize_phone_digits(customer_row.normalized_phone)\n'
          || E'            = app_private.normalize_phone_digits(normalized_search)\n',
          E'          app_private.phone_search_key(normalized_search) <> ''''\n'
          || E'          and app_private.phone_search_key(customer_row.normalized_phone)\n'
          || E'            like app_private.phone_search_key(normalized_search) || ''%''\n'
        ),
        (
          'public.get_quotation_lead_options(text,integer)',
          E'          app_private.normalize_phone_digits(normalized_search) <> ''''\n'
          || E'          and app_private.normalize_phone_digits(customer_row.primary_phone)\n'
          || E'            = app_private.normalize_phone_digits(normalized_search)\n',
          E'          app_private.phone_search_key(normalized_search) <> ''''\n'
          || E'          and app_private.phone_search_key(customer_row.primary_phone)\n'
          || E'            like app_private.phone_search_key(normalized_search) || ''%''\n'
        ),
        (
          'public.get_booking_quotation_options(text,integer)',
          E'          app_private.normalize_phone_digits(normalized_search) <> ''''\n'
          || E'          and app_private.normalize_phone_digits(customer_row.primary_phone)\n'
          || E'            = app_private.normalize_phone_digits(normalized_search)\n',
          E'          app_private.phone_search_key(normalized_search) <> ''''\n'
          || E'          and app_private.phone_search_key(customer_row.primary_phone)\n'
          || E'            like app_private.phone_search_key(normalized_search) || ''%''\n'
        ),
        (
          'public.get_task_lead_options(text,integer)',
          E'          app_private.normalize_phone_digits(normalized_search) <> ''''\n'
          || E'          and app_private.normalize_phone_digits(customer_row.primary_phone)\n'
          || E'            = app_private.normalize_phone_digits(normalized_search)\n',
          E'          app_private.phone_search_key(normalized_search) <> ''''\n'
          || E'          and app_private.phone_search_key(customer_row.primary_phone)\n'
          || E'            like app_private.phone_search_key(normalized_search) || ''%''\n'
        ),
        (
          'public.get_work_create_options(text,text)',
          E'          search_phone_digits <> ''''\n'
          || E'          and app_private.normalize_phone_digits(\n'
          || E'            coalesce(customer_row.primary_phone, lead_row.phone)\n'
          || E'          ) like search_phone_digits || ''%''\n',
          E'          app_private.phone_search_key(normalized_search) <> ''''\n'
          || E'          and app_private.phone_search_key(\n'
          || E'            coalesce(customer_row.primary_phone, lead_row.phone)\n'
          || E'          ) like app_private.phone_search_key(normalized_search) || ''%''\n'
        )
    ) as source(signature, old_predicate, new_predicate)
  loop
    select pg_catalog.pg_get_functiondef(target.signature::regprocedure) into definition;

    -- Already converted: re-running this migration must not fail.
    if position(target.new_predicate in definition) > 0 then
      continue;
    end if;

    updated_definition := replace(definition, target.old_predicate, target.new_predicate);
    if updated_definition = definition then
      raise exception using
        errcode = 'P0001',
        message = 'PHONE_SEARCH_PATCH_TARGET_NOT_FOUND: ' || target.signature;
    end if;
    execute updated_definition;
  end loop;
end;
$migration$;

commit;
