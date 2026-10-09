begin;

-- Return the original audience and legacy single-channel steps as well as
-- conditional steps. This lets the editor preserve existing campaign rules.
do $patch$
declare
  body text := pg_get_functiondef('public.get_marketing_drip_campaign(uuid)'::regprocedure);
  anchor text;
begin
  anchor := '''trigger_type'', campaign_row.trigger_type';
  if position(anchor in body)=0 then raise exception 'DRIP_DETAIL_AUDIENCE_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'''audience_filter'', campaign_row.audience_filter, ' || anchor);
  anchor := '''variable_map'', channel_row.variable_map';
  if position(anchor in body)=0 then raise exception 'DRIP_DETAIL_BODY_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,anchor || ', ''body'', coalesce((select t.content ->> ''body'' from public.templates t where t.id=channel_row.template_id and t.organization_id=current_organization_id),step_row.message_body)');
  anchor := '), ''[]''::jsonb)
      ) order by step_row.step_order)';
  if position(anchor in body)=0 then raise exception 'DRIP_DETAIL_LEGACY_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'), jsonb_build_array(jsonb_build_object(''channel'',step_row.channel,
        ''template_id'',step_row.template_id,''variable_map'',coalesce(step_row.template_variables,''{}''::jsonb),
        ''body'',step_row.message_body)))
      ) order by step_row.step_order)');
  execute body;

  body := pg_get_functiondef('public.set_marketing_drip_campaign_status(uuid,text,bigint)'::regprocedure);
  anchor := '    if campaign_row.trigger_type = ''AUDIENCE'' then
      raise exception using errcode = ''22023'', message = ''MARKETING_DRIP_CAMPAIGN_NOT_EDITABLE'';
    end if;';
  if position(anchor in body)=0 then raise exception 'DRIP_LEGACY_ACTIVATION_ANCHOR_MISSING'; end if;
  -- Audience campaigns now use the same template approval/provider checks.
  body := replace(body,anchor,'');
  execute body;

  body := pg_get_functiondef('public.claim_due_drip_messages(text,integer)'::regprocedure);
  anchor := 'when enrollment_row.occurrence_key is not null';
  if position(anchor in body)=0 then raise exception 'DRIP_PAUSE_CLAIM_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'when enrollment_row.source_campaign_id is not null');
  -- The bounded cancellation pass must not let a larger paused queue through.
  anchor := '-- AGENTS.md 9.7: HOT first, then WARM, then COLD, then by due time.';
  if position(anchor in body)=0 then raise exception 'DRIP_PAUSE_CANDIDATE_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'and (priority_enrollment.source_campaign_id is null
    or (email_campaign.status = ''ACTIVE'' and email_campaign.deleted_at is null))
    ' || anchor);
  execute body;
end;
$patch$;

create or replace function public.update_marketing_audience_drip_campaign(
  target_campaign_id uuid, target_expected_version bigint, target_branch_id uuid,
  target_payload jsonb, target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := app_private.current_tenant_organization();
  campaign public.marketing_drip_campaigns%rowtype;
  template public.templates%rowtype;
  step_value jsonb;
  channel_value jsonb;
  saved_step_id uuid;
  step_order_value integer := 0;
  channel_name text;
  body_value text;
  template_id_value uuid;
  variable_map_value jsonb;
  result jsonb;
begin
  if auth.uid() is null or org is null or not app_private.has_permission(org,'marketing.automation.manage') then
    raise exception using errcode='42501',message='MARKETING_AUTOMATION_MANAGE_PERMISSION_REQUIRED';
  end if;
  select * into campaign from public.marketing_drip_campaigns
    where id=target_campaign_id and organization_id=org and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='MARKETING_DRIP_CAMPAIGN_NOT_FOUND'; end if;
  if (campaign.branch_id is null and not app_private.has_organization_wide_scope(org))
    or (campaign.branch_id is not null and not app_private.can_access_branch(org,campaign.branch_id))
    or (target_branch_id is null and not app_private.has_organization_wide_scope(org))
    or (target_branch_id is not null and not app_private.can_access_branch(org,target_branch_id)) then
    raise exception using errcode='42501',message='MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;
  if target_branch_id is not null and not exists(select 1 from public.branches where id=target_branch_id and organization_id=org and active and deleted_at is null) then
    raise exception using errcode='42501',message='MARKETING_AUTOMATION_SCOPE_DENIED';
  end if;
  if target_request_id is null then raise exception using errcode='22023',message='INVALID_MARKETING_DRIP_CAMPAIGN'; end if;
  select (a.metadata->'result') || jsonb_build_object('replayed',true) into result
    from public.audit_logs a where a.organization_id=org and a.actor_id=auth.uid()
      and a.resource_id=target_campaign_id::text and a.action='marketing_automation.drip_updated'
      and a.request_id=target_request_id limit 1;
  if result is not null then return result; end if;
  if campaign.trigger_type<>'AUDIENCE' then raise exception using errcode='22023',message='INVALID_DRIP_TRIGGER'; end if;
  if campaign.status not in ('DRAFT','PAUSED') then raise exception using errcode='22023',message='MARKETING_DRIP_CAMPAIGN_ACTIVE'; end if;
  if target_expected_version is distinct from campaign.version then raise exception using errcode='PT409',message='MARKETING_DRIP_CAMPAIGN_VERSION_CONFLICT'; end if;
  if char_length(btrim(coalesce(target_payload->>'name',''))) not between 3 and 180
    or char_length(coalesce(target_payload->>'description',''))>2000
    or jsonb_typeof(target_payload->'audience_filter') is distinct from 'object'
    or octet_length((target_payload->'audience_filter')::text)>16384
    or jsonb_typeof(target_payload->'steps') is distinct from 'array'
    or jsonb_array_length(target_payload->'steps') not between 1 and 24 then
    raise exception using errcode='22023',message='INVALID_MARKETING_DRIP_CAMPAIGN';
  end if;
  for step_value in select value from jsonb_array_elements(target_payload->'steps') loop
    step_order_value := step_order_value+1;
    if jsonb_typeof(step_value->'delay_hours') is distinct from 'number'
      or (step_value->>'delay_hours')::numeric<>trunc((step_value->>'delay_hours')::numeric)
      or (step_value->>'delay_hours')::numeric not between 0 and 8760
      or jsonb_typeof(step_value->'channels') is distinct from 'array'
      or jsonb_array_length(step_value->'channels')<>1 then
      raise exception using errcode='22023',message='INVALID_DRIP_STEPS';
    end if;
    channel_value := step_value #> '{channels,0}';
    channel_name := channel_value->>'channel';
    template_id_value := nullif(channel_value->>'template_id','')::uuid;
    variable_map_value := coalesce(channel_value->'variable_map','{}'::jsonb);
    body_value := channel_value->>'body';
    if channel_name not in ('WHATSAPP','SMS','EMAIL') or channel_name is null
      or jsonb_typeof(variable_map_value)<>'object' then
      raise exception using errcode='22023',message='INVALID_DRIP_STEP_CHANNEL';
    end if;
    if template_id_value is null then
      -- A legacy free-text step can be preserved. New or changed copy must
      -- reference a new template draft, which cannot be activated prematurely.
      if not exists(select 1 from public.marketing_drip_steps s where s.campaign_id=campaign.id
        and s.organization_id=org and s.channel=channel_name and s.message_body=body_value
        and s.template_id is null and s.template_variables=variable_map_value and s.active) then
        raise exception using errcode='22023',message='DRIP_CHANGED_COPY_REQUIRES_TEMPLATE';
      end if;
    else
      select * into template from public.templates where id=template_id_value and organization_id=org and deleted_at is null;
      if not found or (case when template.channel='WHATSAPP_BUSINESS' then 'WHATSAPP' else template.channel end)<>channel_name then
        raise exception using errcode='22023',message='DRIP_TEMPLATE_CHANNEL_MISMATCH';
      end if;
      if exists(select 1 from jsonb_array_elements_text(template.placeholders) p where not variable_map_value ? p)
        or exists(select 1 from jsonb_each(variable_map_value) e where not template.placeholders ? e.key
          or jsonb_typeof(e.value)<>'string' or char_length(e.value #>> '{}') not between 1 and 500) then
        raise exception using errcode='22023',message='DRIP_TEMPLATE_VARIABLES_UNMAPPED';
      end if;
      body_value := coalesce(template.content->>'body',template.name);
    end if;
    insert into public.marketing_drip_steps(organization_id,campaign_id,step_order,delay_hours,channel,message_body,template_id,template_variables,active)
    values(org,campaign.id,step_order_value,(step_value->>'delay_hours')::integer,channel_name,body_value,template_id_value,variable_map_value,true)
    on conflict(campaign_id,step_order) do update set delay_hours=excluded.delay_hours,channel=excluded.channel,
      message_body=excluded.message_body,template_id=excluded.template_id,template_variables=excluded.template_variables,active=true,updated_at=now()
    returning id into saved_step_id;
    delete from public.marketing_drip_step_channels where step_id=saved_step_id;
    if template_id_value is not null then
      insert into public.marketing_drip_step_channels(organization_id,step_id,channel,template_id,variable_map)
        values(org,saved_step_id,channel_name,template_id_value,variable_map_value);
    end if;
  end loop;
  update public.marketing_drip_steps set active=false,updated_at=now() where campaign_id=campaign.id and step_order>step_order_value;
  update public.marketing_drip_campaigns set name=btrim(target_payload->>'name'),description=nullif(btrim(target_payload->>'description'),''),
    branch_id=target_branch_id,audience_filter=target_payload->'audience_filter',
    default_channel=target_payload #>> '{steps,0,channels,0,channel}',version=version+1,updated_at=now()
    where id=campaign.id returning jsonb_build_object('id',id,'status',status,'version',version,'replayed',false) into result;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,branch_id,request_id,metadata)
    values(org,auth.uid(),'marketing_automation.drip_updated','marketing_drip_campaign',campaign.id::text,target_branch_id,target_request_id,
      jsonb_build_object('trigger_type','AUDIENCE','audience_filter',target_payload->'audience_filter',
        'steps',step_order_value,'result',result));
  return result;
end;
$function$;
revoke all on function public.update_marketing_audience_drip_campaign(uuid,bigint,uuid,jsonb,uuid) from public,anon;
grant execute on function public.update_marketing_audience_drip_campaign(uuid,bigint,uuid,jsonb,uuid) to authenticated;

commit;
