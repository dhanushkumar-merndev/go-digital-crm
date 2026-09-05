-- =============================================================================
-- SEED: calls, follow-ups, tasks, notes (and WhatsApp messages, if a
-- connection exists) for the "focus" telecaller's leads from
-- 01-seed-org-leads.sql -- this is what actually populates My Leads,
-- Follow-ups, Tasks, Activity Timeline, Calls and Inbox with something to
-- look at for that telecaller.
--
-- Run 01-seed-org-leads.sql FIRST and let it commit. Then:
--
--   npx supabase db query --linked -f scripts/sql/02-seed-telecaller-focus-activity.sql
--
-- One transaction, rolls back whole on any error, safe to re-run (each run's
-- rows are tagged with their own timestamp so re-running adds more rather
-- than colliding). Targets the MOST RECENT focus batch from script 1.
-- =============================================================================

begin;

alter table public.followups disable trigger realtime_followups_invalidate;
alter table public.calls disable trigger realtime_calls_invalidate;
alter table public.conversations disable trigger realtime_conversations_invalidate;
alter table public.conversation_messages disable trigger realtime_conversation_messages_invalidate;

do $seed$
declare
  v_focus_campaign text;
  v_org_id uuid;
  v_focus_user_id uuid;
  v_lead_count int;
  v_connection_id uuid;
  v_run_tag text := to_char(now(), 'YYYYMMDDHH24MISS');
begin
  select campaign into v_focus_campaign
  from public.leads
  where campaign like 'SEED_DEMO_100K_%_FOCUS'
  order by created_at desc
  limit 1;

  if v_focus_campaign is null then
    raise exception using errcode = 'P0001', message =
      'No focus batch found -- run 01-seed-org-leads.sql first and let it commit.';
  end if;

  select organization_id, assigned_user_id, count(*)
  into v_org_id, v_focus_user_id, v_lead_count
  from public.leads
  where campaign = v_focus_campaign
  group by organization_id, assigned_user_id;

  raise notice 'Adding activity for % focus leads (campaign %), telecaller %.',
    v_lead_count, v_focus_campaign, v_focus_user_id;

  create temporary table focus_leads on commit drop as
  select
    lead_row.id as lead_id,
    lead_row.organization_id,
    lead_row.branch_id,
    lead_row.team_id,
    lead_row.customer_id,
    lead_row.assigned_user_id,
    lead_row.customer_name,
    lead_row.phone,
    row_number() over (order by lead_row.id) as rn
  from public.leads lead_row
  where lead_row.campaign = v_focus_campaign;

  -- 1) Calls -- every focus lead gets one. Each call needs a distinct
  -- provider_call_id: calls has `unique nulls not distinct (organization_id,
  -- connection_id, provider_call_id)`, and connection_id is null for all of
  -- these (personal/manual calls), so a shared null would collide after the
  -- first row if provider_call_id weren't unique too.
  with new_calls as (
    insert into public.calls (
      organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
      provider_call_id, direction, call_source, started_at, ended_at,
      duration_seconds, outcome, status, created_at
    )
    select
      fl.organization_id, fl.branch_id, fl.team_id, fl.lead_id, fl.customer_id, fl.assigned_user_id,
      'SEED-CALL-' || v_run_tag || '-' || fl.rn::text,
      case when fl.rn % 5 = 0 then 'INBOUND' else 'OUTBOUND' end,
      'PERSONAL_MANUAL',
      call_time.started_at,
      call_time.started_at + (30 + (fl.rn % 240)) * interval '1 second',
      30 + (fl.rn % 240),
      (array['CONNECTED','CONNECTED','CONNECTED','NO_ANSWER','BUSY','SWITCHED_OFF'])[1 + (fl.rn % 6)],
      'COMPLETED',
      call_time.started_at
    from focus_leads fl
    cross join lateral (
      select now() - (fl.rn % 14) * interval '1 day' - (((fl.rn * 37) % 720)) * interval '1 minute'
        as started_at
    ) call_time
    returning id, lead_id, organization_id, customer_id, assigned_user_id, started_at, outcome, direction
  )
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at)
  select organization_id, customer_id, lead_id, 'CALL_LOGGED', assigned_user_id,
    jsonb_build_object('call_id', id, 'direction', direction, 'call_source', 'PERSONAL_MANUAL', 'outcome', outcome),
    started_at
  from new_calls;

  -- 2) Follow-ups -- roughly 4 in 10 focus leads have one open/completed follow-up.
  with due_followups as (
    insert into public.followups (
      organization_id, branch_id, team_id, lead_id, customer_id, assigned_user_id,
      reason, due_at, status, completed_at, created_by, created_at
    )
    select
      fl.organization_id, fl.branch_id, fl.team_id, fl.lead_id, fl.customer_id, fl.assigned_user_id,
      (array['Confirm showroom visit','Share brochure and pricing','Check financing interest',
             'Follow up after test drive','Confirm callback time','Discuss exchange value'])[1 + (fl.rn % 6)],
      case when fl.rn % 10 < 3 then now() - ((fl.rn % 3) * interval '1 day') -- overdue/today mix, recently past
        else now() + (1 + (fl.rn % 5)) * interval '1 day' end, -- upcoming
      case when fl.rn % 4 = 0 then 'COMPLETED' else 'OPEN' end,
      case when fl.rn % 4 = 0 then now() - (fl.rn % 3) * interval '1 day' else null end,
      fl.assigned_user_id,
      now() - (fl.rn % 10) * interval '1 day'
    from focus_leads fl
    where fl.rn % 10 < 4
    returning id, organization_id, customer_id, lead_id, assigned_user_id, created_at
  )
  insert into public.activities (organization_id, customer_id, lead_id, activity_type, actor_id, metadata, occurred_at)
  select organization_id, customer_id, lead_id, 'FOLLOWUP_SCHEDULED', assigned_user_id,
    jsonb_build_object('followup_id', id), created_at
  from due_followups;

  -- 3) Tasks -- roughly 3 in 10.
  with new_tasks as (
    insert into public.tasks (
      organization_id, branch_id, team_id, assigned_user_id,
      resource_type, resource_id, title, description, priority, status, due_at,
      completed_at, created_by, created_at
    )
    select
      fl.organization_id, fl.branch_id, fl.team_id, fl.assigned_user_id,
      'LEAD', fl.lead_id,
      (array['Confirm Showroom Visit','Send Quotation Follow-up','Update CRM Notes',
             'Verify Contact Details','Schedule Test Drive Reminder'])[1 + (fl.rn % 5)],
      'Seeded demo task for ' || fl.customer_name,
      (array['LOW','NORMAL','NORMAL','HIGH'])[1 + (fl.rn % 4)],
      case when fl.rn % 3 = 0 then 'COMPLETED' else 'OPEN' end,
      now() + ((fl.rn % 7) - 2) * interval '1 day',
      -- tasks_completion_check requires completed_at set iff status = 'COMPLETED'.
      case when fl.rn % 3 = 0 then now() - (fl.rn % 5) * interval '1 day' else null end,
      fl.assigned_user_id,
      now() - (fl.rn % 10) * interval '1 day'
    from focus_leads fl
    where fl.rn % 10 < 3
    returning id, organization_id, resource_id as lead_id, assigned_user_id, created_at
  )
  insert into public.activities (organization_id, lead_id, activity_type, actor_id, metadata, occurred_at)
  select organization_id, lead_id, 'TASK_CREATED', assigned_user_id,
    jsonb_build_object('task_id', id), created_at
  from new_tasks;

  -- 4) Notes -- roughly 2 in 10, feeds the "Recent notes" panel directly.
  insert into public.notes (organization_id, resource_type, resource_id, body, created_by, created_at)
  select
    fl.organization_id, 'customer', fl.customer_id,
    (array[
      'Customer prefers a callback in the evening.',
      'Interested in the top variant, waiting on finance approval.',
      'Requested a comparison with the competitor model.',
      'Family decision -- following up once spouse is available.',
      'Asked about exchange value for their current car.'
    ])[1 + (fl.rn % 5)],
    fl.assigned_user_id,
    now() - (fl.rn % 12) * interval '1 day'
  from focus_leads fl
  where fl.rn % 10 < 2;

  -- 5) WhatsApp thread -- only if the org already has a WhatsApp connection;
  -- conversations.connection_id is NOT NULL, so this is skipped (not faked)
  -- when none exists.
  select id into v_connection_id
  from public.connected_accounts
  where organization_id = v_org_id
    and provider_key = 'whatsapp_cloud'
    and deleted_at is null
  order by created_at
  limit 1;

  if v_connection_id is not null then
    with new_conversations as (
      insert into public.conversations (organization_id, branch_id, lead_id, customer_id, channel, connection_id, assigned_user_id, status, created_at)
      select fl.organization_id, fl.branch_id, fl.lead_id, fl.customer_id, 'WHATSAPP_BUSINESS', v_connection_id, fl.assigned_user_id, 'OPEN',
        now() - (fl.rn % 12) * interval '1 day'
      from focus_leads fl
      where fl.rn % 10 = 0
      returning id, organization_id, created_at, lead_id
    )
    insert into public.conversation_messages (organization_id, conversation_id, provider_message_id, direction, body, delivery_status, sent_by, sent_at)
    select organization_id, id, 'SEED-MSG-' || v_run_tag || '-' || lead_id::text, 'OUTBOUND',
      'Hi, following up on your enquiry -- let us know a good time to talk.', 'DELIVERED', v_focus_user_id, created_at
    from new_conversations;
    raise notice 'Also seeded WhatsApp threads via connection %.', v_connection_id;
  else
    raise notice 'No WhatsApp Business connection found for this org -- skipped Inbox/messages seeding.';
  end if;

  raise notice 'Done.';
end;
$seed$;

alter table public.followups enable trigger realtime_followups_invalidate;
alter table public.calls enable trigger realtime_calls_invalidate;
alter table public.conversations enable trigger realtime_conversations_invalidate;
alter table public.conversation_messages enable trigger realtime_conversation_messages_invalidate;

commit;
