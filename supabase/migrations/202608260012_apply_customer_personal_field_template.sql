begin;

-- `apply_customer_field_template` is the runtime path and is gated on
-- `auth.uid()` plus organization-wide `role.manage`, so it can only ever be run
-- by a signed-in client admin. Every existing tenant therefore had the template
-- defined and none had it applied: the Edit customer dialog offered "custom
-- information" and rendered an empty section, because `custom_field_values`
-- reads definitions that were never created.
--
-- The personal set is the one a dealership greets people on, so it is applied
-- here for existing organizations. CUSTOMER_FAMILY and CUSTOMER_FINANCE stay
-- opt-in through the Custom Fields admin screen -- they are commercially
-- sensitive and not every tenant wants them collected.
--
-- Idempotent: the NOT EXISTS guard mirrors the RPC's own skip behaviour, so a
-- tenant that already applied the template by hand keeps its definitions and
-- their edited labels untouched.
select set_config('request.jwt.claim.role', 'service_role', false);

insert into public.custom_field_definitions (
  organization_id, module, field_key, label, field_type, options, required, active
)
select
  organization_row.id,
  'CUSTOMERS',
  template_row.field_key,
  template_row.label,
  template_row.field_type,
  template_row.options,
  false,
  true
from public.organizations organization_row
cross join lateral app_private.customer_field_template('CUSTOMER_PERSONAL') template_row
where not exists (
  select 1
  from public.custom_field_definitions definition_row
  where definition_row.organization_id = organization_row.id
    and definition_row.module = 'CUSTOMERS'
    and definition_row.field_key = template_row.field_key
);

-- A silent no-op here would ship the same empty dialog, so prove the outcome
-- rather than the fact that a statement ran.
do $verify$
declare
  missing_count bigint;
begin
  select count(*)
  into missing_count
  from public.organizations organization_row
  cross join lateral app_private.customer_field_template('CUSTOMER_PERSONAL') template_row
  where not exists (
    select 1
    from public.custom_field_definitions definition_row
    where definition_row.organization_id = organization_row.id
      and definition_row.module = 'CUSTOMERS'
      and definition_row.field_key = template_row.field_key
  );
  if missing_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'CUSTOMER_PERSONAL_TEMPLATE_NOT_FULLY_APPLIED';
  end if;
end;
$verify$;

commit;
