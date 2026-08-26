begin;

-- Adding "date of birth" to a CRM has never been the hard part. Naming it the
-- same way twice is. Left to free-form creation, one branch gets `dob` as TEXT,
-- another `birthday` as DATE, and a birthday greeting can no longer be built
-- from either. A template creates the whole set at once, server-side, so the
-- key, the type and the label are fixed by the definition below rather than by
-- whoever typed them first.
--
-- Templates are additive and re-runnable: a key that already exists in the
-- organization is left exactly as it is, including a deactivated one, because
-- reactivating a field an administrator deliberately switched off is not
-- something a template should decide.
create or replace function app_private.customer_field_template(target_template_key text)
returns table (field_key text, label text, field_type text, options jsonb, sort_order integer)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select entry.field_key, entry.label, entry.field_type, entry.options, entry.sort_order
  from (
    values
      -- The dates a dealership actually greets people on, plus the two facts
      -- that change how a consultant speaks to them.
      ('CUSTOMER_PERSONAL', 'date_of_birth', 'Date of birth', 'DATE', '[]'::jsonb, 1),
      ('CUSTOMER_PERSONAL', 'wedding_anniversary', 'Wedding anniversary', 'DATE', '[]'::jsonb, 2),
      ('CUSTOMER_PERSONAL', 'spouse_name', 'Spouse name', 'TEXT', '[]'::jsonb, 3),
      ('CUSTOMER_PERSONAL', 'occupation', 'Occupation', 'TEXT', '[]'::jsonb, 4),
      (
        'CUSTOMER_PERSONAL', 'preferred_language', 'Preferred language', 'SELECT',
        '["English","Hindi","Kannada","Tamil","Telugu","Malayalam","Marathi"]'::jsonb, 5
      ),
      (
        'CUSTOMER_PERSONAL', 'preferred_contact_time', 'Best time to call', 'SELECT',
        '["Morning","Afternoon","Evening","Weekend only"]'::jsonb, 6
      ),

      ('CUSTOMER_FAMILY', 'family_size', 'Family size', 'NUMBER', '[]'::jsonb, 1),
      ('CUSTOMER_FAMILY', 'children_count', 'Children', 'NUMBER', '[]'::jsonb, 2),
      ('CUSTOMER_FAMILY', 'household_vehicles', 'Vehicles in household', 'NUMBER', '[]'::jsonb, 3),
      (
        'CUSTOMER_FAMILY', 'primary_use', 'Primary use', 'SELECT',
        '["Family","Personal commute","Business","Commercial"]'::jsonb, 4
      ),

      (
        'CUSTOMER_FINANCE', 'income_band', 'Annual income band', 'SELECT',
        '["Under 5L","5L - 10L","10L - 20L","20L - 50L","Above 50L"]'::jsonb, 1
      ),
      ('CUSTOMER_FINANCE', 'preferred_bank', 'Preferred bank', 'TEXT', '[]'::jsonb, 2),
      ('CUSTOMER_FINANCE', 'existing_loan', 'Has an existing vehicle loan', 'BOOLEAN', '[]'::jsonb, 3),
      ('CUSTOMER_FINANCE', 'gst_number', 'GST number', 'TEXT', '[]'::jsonb, 4)
  ) as entry(template_key, field_key, label, field_type, options, sort_order)
  where entry.template_key = upper(btrim(coalesce(target_template_key, '')));
$$;

revoke all on function app_private.customer_field_template(text) from public, anon;

create or replace function public.apply_customer_field_template(
  target_template_key text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  normalized_template text := upper(btrim(coalesce(target_template_key, '')));
  fingerprint jsonb;
  replay_fingerprint jsonb;
  replay_result jsonb;
  created_keys text[] := array[]::text[];
  skipped_keys text[] := array[]::text[];
  template_row record;
  new_definition_id uuid;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null
    or normalized_template not in ('CUSTOMER_PERSONAL', 'CUSTOMER_FAMILY', 'CUSTOMER_FINANCE')
  then
    raise exception using errcode = '22023', message = 'INVALID_CUSTOM_FIELD_TEMPLATE';
  end if;

  -- Definitions are organization configuration, so this carries the same
  -- ceiling as creating one by hand: organization-wide scope and role.manage.
  current_organization_id := app_private.current_tenant_organization();
  if current_organization_id is null
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not app_private.has_permission(current_organization_id, 'role.manage')
  then
    raise exception using errcode = '42501', message = 'CUSTOM_FIELD_MANAGE_PERMISSION_REQUIRED';
  end if;

  fingerprint := jsonb_build_object('template', normalized_template, 'module', 'CUSTOMERS');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    current_organization_id::text || ':' || auth.uid()::text || ':' || target_request_id::text, 0
  ));
  select audit_row.metadata -> 'fingerprint', audit_row.metadata -> 'result'
    into replay_fingerprint, replay_result
  from public.audit_logs audit_row
  where audit_row.organization_id = current_organization_id
    and audit_row.actor_id = auth.uid()
    and audit_row.action = 'custom_field.template_applied'
    and audit_row.request_id = target_request_id
  order by audit_row.id desc
  limit 1;
  if replay_result is not null then
    if replay_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
    end if;
    return replay_result || jsonb_build_object('replayed', true);
  end if;

  for template_row in
    select * from app_private.customer_field_template(normalized_template) order by sort_order
  loop
    if exists (
      select 1
      from public.custom_field_definitions definition_row
      where definition_row.organization_id = current_organization_id
        and definition_row.module = 'CUSTOMERS'
        and definition_row.field_key = template_row.field_key
    ) then
      skipped_keys := skipped_keys || template_row.field_key;
      continue;
    end if;

    new_definition_id := gen_random_uuid();
    insert into public.custom_field_definitions (
      id, organization_id, module, field_key, label,
      field_type, options, required, active, version
    ) values (
      new_definition_id, current_organization_id, 'CUSTOMERS', template_row.field_key,
      template_row.label, template_row.field_type, template_row.options, false, true, 1
    );
    created_keys := created_keys || template_row.field_key;

    insert into public.audit_logs (
      organization_id, actor_id, action, resource_type, resource_id, metadata
    ) values (
      current_organization_id, auth.uid(), 'custom_field.created', 'custom_field_definition',
      new_definition_id::text,
      jsonb_build_object('template', normalized_template, 'field_key', template_row.field_key)
    );
  end loop;

  result := jsonb_build_object(
    'template', normalized_template,
    'created', to_jsonb(created_keys),
    'skipped', to_jsonb(skipped_keys),
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'custom_field.template_applied', 'custom_field_definition',
    normalized_template, target_request_id,
    jsonb_build_object('fingerprint', fingerprint, 'result', result)
  );
  return result;
end;
$$;

revoke all on function public.apply_customer_field_template(text, uuid) from public, anon;
grant execute on function public.apply_customer_field_template(text, uuid) to authenticated;

commit;
