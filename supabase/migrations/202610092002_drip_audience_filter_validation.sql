begin;

create or replace function app_private.validate_drip_audience_filter(target_filter jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  filter_key text;
  permitted text[];
begin
  if jsonb_typeof(target_filter) is distinct from 'object' then return false; end if;
  foreach filter_key in array array['lifecycle_status','temperature','source'] loop
    if not target_filter ? filter_key then continue; end if;
    if jsonb_typeof(target_filter->filter_key) is distinct from 'array'
      or jsonb_array_length(target_filter->filter_key)>50 then return false; end if;
    permitted := case filter_key
      when 'lifecycle_status' then array['New','Contacted','Qualified','Appointment Scheduled','Transferred to Sales','Lost']
      when 'temperature' then array['HOT','WARM','COLD','DORMANT']
      else app_private.drip_lead_sources() end;
    if exists(select 1 from jsonb_array_elements(target_filter->filter_key) item
      where jsonb_typeof(item)<>'string' or (item #>> '{}')<>all(permitted)) then return false; end if;
  end loop;
  if target_filter ? 'created_within_days' then
    if jsonb_typeof(target_filter->'created_within_days') is distinct from 'number'
      or (target_filter->>'created_within_days')::numeric<>trunc((target_filter->>'created_within_days')::numeric)
      or (target_filter->>'created_within_days')::numeric not between 1 and 3650 then return false; end if;
  end if;
  return true;
end;
$function$;
revoke all on function app_private.validate_drip_audience_filter(jsonb) from public,anon,authenticated;

do $patch$
declare
  body text := pg_get_functiondef('public.update_marketing_audience_drip_campaign(uuid,bigint,uuid,jsonb,uuid)'::regprocedure);
  anchor text := 'or jsonb_typeof(target_payload->''audience_filter'') is distinct from ''object''';
begin
  if position(anchor in body)=0 then raise exception 'DRIP_AUDIENCE_VALIDATION_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'or not app_private.validate_drip_audience_filter(target_payload->''audience_filter'')');
  execute body;
end;
$patch$;

commit;
