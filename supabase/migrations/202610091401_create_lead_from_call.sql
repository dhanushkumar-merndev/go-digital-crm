begin;

-- A telecaller turns a logged inbound call from an unknown number into a lead.
-- One transaction: create the lead through create_lead (so lead.create,
-- branch access and the team's assignment rules all apply exactly as for a
-- manual lead) and link the call to it, so the call shows on the lead's
-- history and the Calls row stops reading "Unknown caller".

create or replace function public.create_lead_from_call(
  target_call_id uuid,
  lead_customer_name text,
  lead_interested_model text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  call_row public.calls%rowtype;
  new_lead_id uuid;
  new_customer_id uuid;
begin
  select * into call_row from public.calls where id = target_call_id for update;
  if not found or not app_private.can_access_call(call_row.organization_id, call_row.id) then
    raise exception using errcode = '42501', message = 'CALL_ACCESS_DENIED';
  end if;
  if call_row.lead_id is not null then
    raise exception using errcode = 'PT409', message = 'CALL_ALREADY_HAS_LEAD';
  end if;
  if nullif(btrim(coalesce(call_row.normalized_caller_phone, '')), '') is null then
    raise exception using errcode = '22023', message = 'CALL_HAS_NO_CALLER_PHONE';
  end if;

  new_lead_id := public.create_lead(
    call_row.organization_id,
    call_row.branch_id,
    -- No team: a telecaller (own-records scope) then self-assigns the lead, so
    -- whoever handled the call keeps the customer instead of round-robin
    -- handing it to a colleague; a manager creates into the queue as usual.
    null,
    'Manual',
    lead_customer_name,
    call_row.normalized_caller_phone,
    null,
    'TeleCMI inbound call',
    null,
    nullif(btrim(coalesce(lead_interested_model, '')), '')
  );

  select customer_id into new_customer_id from public.leads where id = new_lead_id;

  update public.calls set
    lead_id = new_lead_id,
    customer_id = coalesce(customer_id, new_customer_id),
    version = version + 1,
    updated_at = now()
  where id = call_row.id;

  insert into public.audit_logs (
    organization_id, branch_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    call_row.organization_id, call_row.branch_id, auth.uid(), 'call.lead_created_from_call',
    'call', call_row.id, jsonb_build_object('lead_id', new_lead_id)
  );

  return jsonb_build_object('call_id', call_row.id, 'lead_id', new_lead_id);
end;
$$;

revoke all on function public.create_lead_from_call(uuid, text, text) from public, anon;
grant execute on function public.create_lead_from_call(uuid, text, text) to authenticated;

commit;
