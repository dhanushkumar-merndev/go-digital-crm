begin;

-- Data repair for the regression 202609020018 fixed in code.
--
-- While 202609020006 was live, create_lead treated every OWN_RECORDS user as a
-- Sales Consultant. A Telecaller typing in a lead therefore got a lead written
-- straight to 'Transferred to Sales', a first_contacted_at stamp, a
-- lead_stage_history row reading "Created by the owning sales consultant", and a
-- SALES_CONTACTED activity -- none of which happened.
--
-- The lead was self-assigned, so it was never handed to anyone: it still belongs
-- to the Telecaller who typed it. That is what identifies these rows, and it is
-- exact rather than heuristic. A genuinely handed-off lead is owned by the
-- consultant it went to, so nothing real can match.
--
-- Symptom that surfaced it: the row showed the "Transferred to Sales" badge but
-- stayed fully editable, because is_telecaller_handoff_viewer correctly refuses
-- to call a lead handed off when its owner never changed. The badge was wrong,
-- not the greying.
do $migration$
declare
  affected_leads uuid[];
  lead_count integer;
begin
  select coalesce(array_agg(lead_row.id), '{}'::uuid[])
  into affected_leads
  from public.leads lead_row
  join public.user_role_assignments assignment_row
    on assignment_row.user_id = lead_row.assigned_user_id
   and assignment_row.organization_id = lead_row.organization_id
   and assignment_row.active
  join public.roles role_row
    on role_row.id = assignment_row.role_id
   and role_row.role_key = 'telecaller_bdc'
  where lead_row.lifecycle_status = 'Transferred to Sales'
    and lead_row.deleted_at is null
    -- Never moved to anyone: no history entry hands it away from its owner.
    and not exists (
      select 1
      from public.lead_assignment_history history_row
      where history_row.lead_id = lead_row.id
        and history_row.previous_owner_id is not null
        and history_row.previous_owner_id is distinct from history_row.new_owner_id
    );

  lead_count := coalesce(array_length(affected_leads, 1), 0);

  -- The regression was open for roughly ninety minutes on one demo tenant. A
  -- broad match means the rule has stopped meaning what it was written to mean,
  -- and silently rewriting real lifecycle states is not a thing to discover later.
  if lead_count > 50 then
    raise exception using
      errcode = 'P0001',
      message = 'FALSE_HANDOFF_RESET_SCOPE_TOO_BROAD';
  end if;

  if lead_count = 0 then
    return;
  end if;

  -- The fabricated handoff event. Pinned to the exact reason create_lead wrote,
  -- so a real stage change on the same lead is never touched.
  delete from public.lead_stage_history
  where lead_id = any(affected_leads)
    and to_status = 'Transferred to Sales'
    and from_status = 'New'
    and reason = 'Created by the owning sales consultant';

  -- The contact that never happened.
  delete from public.activities
  where lead_id = any(affected_leads)
    and activity_type = 'SALES_CONTACTED'
    and metadata ->> 'source' = 'lead_created_by_consultant';

  update public.leads
  set lifecycle_status = 'New',
      first_contacted_at = null,
      updated_at = greatest(now(), updated_at + interval '1 microsecond')
  where id = any(affected_leads);

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  )
  select
    lead_row.organization_id,
    null,
    'lead.false_handoff_reset',
    'lead',
    lead_row.id::text,
    jsonb_build_object(
      'migration', '202609020020',
      'from_status', 'Transferred to Sales',
      'to_status', 'New',
      'leads_reset', lead_count,
      'cause', 'create_lead regression introduced by 202609020006, fixed by 202609020018'
    )
  from public.leads lead_row
  where lead_row.id = any(affected_leads);
end;
$migration$;

commit;
