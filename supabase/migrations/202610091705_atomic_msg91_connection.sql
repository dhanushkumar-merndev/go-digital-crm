begin;

-- Save MSG91 credentials, branch mappings and audit atomically.
create or replace function public.save_msg91_integration_connection(
  target_organization_id uuid, target_actor_id uuid, target_connection_id uuid,
  target_display_name text, target_scope_mode text, target_branch_ids uuid[],
  target_encrypted_payload bytea, target_tested_at timestamptz,
  target_sender_id text, target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  connection_id uuid := coalesce(target_connection_id, gen_random_uuid());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (select 1 from public.profiles where id = target_actor_id
    and organization_id = target_organization_id and active and deleted_at is null) then
    raise exception using errcode = '42501', message = 'INTEGRATION_ACTOR_DENIED';
  end if;
  if target_request_id is null or target_encrypted_payload is null
    or char_length(btrim(coalesce(target_display_name, ''))) not between 2 and 120
    or target_scope_mode is null or target_scope_mode not in ('ONE_BRANCH','SELECTED_BRANCHES','ALL_BRANCHES')
    or (target_sender_id is not null and target_sender_id !~ '^[A-Za-z]{6}$')
    or target_branch_ids is null
    or (target_scope_mode = 'ONE_BRANCH' and cardinality(target_branch_ids) <> 1)
    or (target_scope_mode = 'SELECTED_BRANCHES' and cardinality(target_branch_ids) not between 1 and 100)
    or (target_scope_mode = 'ALL_BRANCHES' and cardinality(target_branch_ids) <> 0)
    or cardinality(target_branch_ids) <> (select count(distinct branch_id) from unnest(target_branch_ids) branch_id)
    or exists (select 1 from unnest(target_branch_ids) branch_id where not exists (
      select 1 from public.branches where id = branch_id and organization_id = target_organization_id
        and active and deleted_at is null
    )) then
    raise exception using errcode = '22023', message = 'INVALID_MSG91_CONNECTION';
  end if;
  if target_connection_id is not null then
    perform 1 from public.connected_accounts where id = connection_id
      and organization_id = target_organization_id and provider_key = 'msg91' and deleted_at is null
      for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'MSG91_CONNECTION_NOT_FOUND';
    end if;
    update public.connected_accounts set display_name = btrim(target_display_name),
      scope_mode = target_scope_mode::public.branch_scope_mode, status = 'CONNECTED', last_tested_at = target_tested_at,
      last_error_code = null, connection_config = jsonb_build_object(
        'connection_type','SMS_PROVIDER','capabilities',jsonb_build_array('TEMPLATE_SMS'),
        'sender_id',target_sender_id
      ) where id = connection_id and organization_id = target_organization_id;
  else
    insert into public.connected_accounts(id,organization_id,provider_key,display_name,
      scope_mode,status,auth_type,created_by,last_tested_at,connection_config)
    values(connection_id,target_organization_id,'msg91',btrim(target_display_name),
      target_scope_mode::public.branch_scope_mode,'CONNECTED','API_KEY',target_actor_id,target_tested_at,
      jsonb_build_object('connection_type','SMS_PROVIDER','capabilities',jsonb_build_array('TEMPLATE_SMS'),
        'sender_id',target_sender_id));
  end if;
  insert into public.integration_credentials(organization_id,connected_account_id,encrypted_payload,
    key_version,cipher_version,replaced_by)
  values(target_organization_id,connection_id,target_encrypted_payload,1,'AES-256-GCM-v1',target_actor_id)
  on conflict(connected_account_id) do update set encrypted_payload = excluded.encrypted_payload,
    key_version = excluded.key_version, cipher_version = excluded.cipher_version, replaced_by = excluded.replaced_by;
  update public.integration_branch_mappings set deleted_at = now()
    where connected_account_id = connection_id and deleted_at is null;
  insert into public.integration_branch_mappings(organization_id,connected_account_id,branch_id,
    external_resource_type,external_resource_id)
  select target_organization_id,connection_id,branch_id,'CONNECTION_SCOPE',connection_id::text
  from unnest(target_branch_ids) branch_id
  on conflict(connected_account_id,branch_id,external_resource_type,external_resource_id)
  do update set deleted_at = null;
  insert into public.audit_logs(organization_id,actor_id,action,resource_type,resource_id,request_id,metadata)
  values(target_organization_id,target_actor_id,
    case when target_connection_id is null then 'integration.connected' else 'integration.reconnected' end,
    'connected_account',connection_id::text,target_request_id,
    jsonb_build_object('provider_key','msg91','scope_mode',target_scope_mode,'credential_replaced',true,
      'test_sms_sent',target_tested_at is not null));
  return jsonb_build_object('connection_id',connection_id,'provider_key','msg91','status','CONNECTED','tested_at',target_tested_at);
end;
$function$;
revoke all on function public.save_msg91_integration_connection(uuid,uuid,uuid,text,text,uuid[],bytea,timestamptz,text,uuid)
  from public, anon, authenticated;
grant execute on function public.save_msg91_integration_connection(uuid,uuid,uuid,text,text,uuid[],bytea,timestamptz,text,uuid)
  to service_role;


-- A soft-deleted scope row retains its composite primary key. Reactivate it
-- when saving the same branch instead of attempting a duplicate insertion.
do $patch$
declare
  body text := pg_get_functiondef('public.save_brevo_integration_connection(uuid,uuid,uuid,text,text,uuid[],bytea,timestamptz,text,uuid)'::regprocedure);
  anchor text := 'from unnest(target_branch_ids) branch_id;';
begin
  if position(anchor in body) = 0 then raise exception 'BREVO_SCOPE_UPSERT_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'from unnest(target_branch_ids) branch_id
    on conflict(connected_account_id,branch_id,external_resource_type,external_resource_id)
    do update set deleted_at = null;');
  execute body;
end;
$patch$;

commit;
