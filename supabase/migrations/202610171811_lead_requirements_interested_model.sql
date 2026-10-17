-- The lead's interested model becomes editable from the Vehicle requirement
-- editor, and every requirements save says what changed on the lead timeline.
--
-- update_lead_requirements accepts an optional `interested_model` key. When the
-- key is present it updates leads.interested_model in the same transaction as
-- the requirements (lists, drips and routing read the model from the lead, so
-- it stays there rather than moving into lead_requirements). Callers that omit
-- the key keep today's behaviour.
--
-- The LEAD_REQUIREMENTS_UPDATED activity gains a `summary` ("Interested model:
-- Creta · Fuel Type: Petrol"), which get_lead_journey already shows as the
-- event detail, and the audit row records the after-state next to `before`.
--
-- Patched onto the live definition (see 202610090451 for the helper), never
-- re-emitted from an older migration body.

begin;

create function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  occurrences integer := (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text);
begin
  if occurrences <> 1 then
    raise exception 'PATCH_ANCHOR_% for %: expected 1 occurrence, found %',
      md5(old_text), target, occurrences;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;

select pg_temp.patch_function(
  'public.update_lead_requirements(uuid,bigint,jsonb,uuid)',
  $old$  before_json jsonb;
$old$,
  $new$  before_json jsonb;
  after_json jsonb;
  next_model text;
  changes text[] := '{}';
  change_summary text;
$new$
);

select pg_temp.patch_function(
  'public.update_lead_requirements(uuid,bigint,jsonb,uuid)',
  $old$    updated_at = excluded.updated_at;
$old$,
  $new$    updated_at = excluded.updated_at;

  -- The interested model lives on the lead; the editor changes it here so the
  -- model and the requirements move together and share one timeline entry.
  if target_payload ? 'interested_model' then
    next_model := nullif(left(btrim(coalesce(target_payload->>'interested_model', '')), 160), '');
    if next_model is distinct from lead_row.interested_model then
      update public.leads
      set interested_model = next_model, updated_at = now()
      where id = lead_row.id;
      changes := array['Interested model: ' || coalesce(next_model, 'cleared')];
    end if;
  end if;

  after_json := app_private.lead_requirements_json(lead_row.id);
  select changes || coalesce(array_agg(
      initcap(replace(after_entry.key, '_', ' ')) || ': ' ||
      case
        when after_entry.key = 'exchange_vehicle_id' then 'changed'
        when jsonb_typeof(after_entry.value) = 'null' then 'cleared'
        when jsonb_typeof(after_entry.value) = 'boolean' then
          case when after_entry.value::text = 'true' then 'Yes' else 'No' end
        when jsonb_typeof(after_entry.value) = 'array' then
          coalesce(nullif((
            select string_agg(item, ', ') from jsonb_array_elements_text(after_entry.value) item
          ), ''), 'cleared')
        else after_entry.value #>> '{}'
      end
      order by after_entry.key
    ), '{}')
  into changes
  from jsonb_each(after_json) after_entry
  where after_entry.key not in ('version', 'updated_at')
    and after_entry.value is distinct from coalesce(before_json -> after_entry.key, 'null'::jsonb)
    and not (
      jsonb_typeof(after_entry.value) = 'array'
      and jsonb_array_length(after_entry.value) = 0
      and coalesce(jsonb_array_length(before_json -> after_entry.key), 0) = 0
    );
  change_summary := nullif(left(array_to_string(changes, ' · '), 600), '');
$new$
);

select pg_temp.patch_function(
  'public.update_lead_requirements(uuid,bigint,jsonb,uuid)',
  $old$    jsonb_build_object('version', next_version)
$old$,
  $new$    jsonb_strip_nulls(jsonb_build_object('version', next_version, 'summary', change_summary))
$new$
);

select pg_temp.patch_function(
  'public.update_lead_requirements(uuid,bigint,jsonb,uuid)',
  $old$      'before', before_json,
$old$,
  $new$      'before', before_json,
      'after', after_json,
      'interested_model', jsonb_build_object(
        'before', lead_row.interested_model,
        'after', case when target_payload ? 'interested_model'
          then next_model else lead_row.interested_model end
      ),
$new$
);

commit;
