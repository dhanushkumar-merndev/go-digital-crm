begin;

-- connected_accounts.scope_mode uses the shared branch_scope_mode enum.
do $patch$
declare
  body text := pg_get_functiondef('public.save_brevo_integration_connection(uuid,uuid,uuid,text,text,uuid[],bytea,timestamptz,text,uuid)'::regprocedure);
  anchor text;
begin
  anchor := 'scope_mode = target_scope_mode,';
  if position(anchor in body) = 0 then raise exception 'BREVO_UPDATE_SCOPE_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'scope_mode = target_scope_mode::public.branch_scope_mode,');
  anchor := 'target_scope_mode,''CONNECTED'',''API_KEY''';
  if position(anchor in body) = 0 then raise exception 'BREVO_INSERT_SCOPE_ANCHOR_MISSING'; end if;
  body := replace(body,anchor,'target_scope_mode::public.branch_scope_mode,''CONNECTED'',''API_KEY''');
  execute body;
end;
$patch$;

commit;
