begin;

-- A lead with unfinished work must remain with the Telecaller. The web guard
-- improves the experience, but this server-side guard protects direct RPC
-- callers and concurrent tabs too.
do $migration$
declare
  current_definition text;
  updated_definition text;
  anchor text := E'  if target_lead.lifecycle_status = ''Lost'' then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LOST_LEAD_CANNOT_TRANSFER'';\n'
    || E'  end if;\n';
  guard text := E'  if exists (\n'
    || E'    select 1 from public.followups followup_row\n'
    || E'    where followup_row.organization_id = current_organization_id\n'
    || E'      and followup_row.lead_id = target_lead.id\n'
    || E'      and followup_row.status in (''OPEN'', ''OVERDUE'')\n'
    || E'  ) then\n'
    || E'    raise exception using errcode = ''23514'', message = ''FOLLOWUP_PENDING_BEFORE_SALES_HANDOFF'';\n'
    || E'  end if;\n';
begin
  select pg_get_functiondef('public.transfer_lead_to_sales(uuid,uuid,text)'::regprocedure)
    into current_definition;

  if current_definition is null then
    raise exception 'TRANSFER_LEAD_TO_SALES_FUNCTION_NOT_FOUND';
  end if;
  if position('FOLLOWUP_PENDING_BEFORE_SALES_HANDOFF' in current_definition) > 0 then
    return;
  end if;

  updated_definition := replace(current_definition, anchor, anchor || E'\n' || guard);
  if updated_definition = current_definition then
    raise exception 'FOLLOWUP_PENDING_HANDOFF_GUARD_PATCH_TARGET_NOT_FOUND';
  end if;
  execute updated_definition;
end;
$migration$;

revoke all on function public.transfer_lead_to_sales(uuid, uuid, text) from public, anon;
grant execute on function public.transfer_lead_to_sales(uuid, uuid, text) to authenticated;

commit;
