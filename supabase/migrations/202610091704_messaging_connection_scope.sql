begin;

-- Connection authorization reads CONNECTION_SCOPE rows. SMS/email connections
-- previously saved their branch scopes under provider-specific resource types.
-- Preserve the exact tenant and branch; do not grant access to another scope.
with repaired as (
  update public.integration_branch_mappings mapping
  set external_resource_type = 'CONNECTION_SCOPE'
  from public.connected_accounts account
  where account.id = mapping.connected_account_id
    and account.organization_id = mapping.organization_id
    and account.deleted_at is null
    and account.scope_mode in ('ONE_BRANCH','SELECTED_BRANCHES')
    and mapping.deleted_at is null
    and ((account.provider_key = 'msg91' and mapping.external_resource_type = 'MSG91_ACCOUNT')
      or (account.provider_key = 'brevo' and mapping.external_resource_type = 'BREVO_ACCOUNT'))
    and exists (select 1 from public.branches branch
      where branch.id = mapping.branch_id and branch.organization_id = mapping.organization_id)
    and not exists (select 1 from public.integration_branch_mappings existing
      where existing.organization_id = mapping.organization_id
        and existing.connected_account_id = mapping.connected_account_id
        and existing.branch_id = mapping.branch_id
        and existing.external_resource_type = 'CONNECTION_SCOPE' and existing.deleted_at is null)
  returning mapping.organization_id, mapping.connected_account_id, mapping.branch_id
)
insert into public.audit_logs(organization_id,action,resource_type,resource_id,branch_id,metadata)
select organization_id,'integration.scope_mapping_repaired','connected_account',
  connected_account_id::text,branch_id,
  jsonb_build_object('migration','202610091704','scope_preserved',true)
from repaired;

do $patch$
declare
  body text := pg_get_functiondef('public.save_brevo_integration_connection(uuid,uuid,uuid,text,text,uuid[],bytea,timestamptz,text,uuid)'::regprocedure);
  anchor text := '''BREVO_ACCOUNT''';
begin
  if position(anchor in body) = 0 then raise exception 'BREVO_MAPPING_SCOPE_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'''CONNECTION_SCOPE''');
  execute body;
end;
$patch$;

commit;
