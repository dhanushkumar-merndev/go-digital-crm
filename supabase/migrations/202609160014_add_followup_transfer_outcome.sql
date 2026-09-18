begin;

alter table public.followups
  drop constraint if exists followups_outcome_check;
alter table public.followups
  add constraint followups_outcome_check
  check (outcome is null or outcome in ('FOLLOW_UP', 'APPOINTMENT', 'LOST', 'TRANSFER_TO_SALES'));

comment on column public.followups.outcome is
  'What the consultant committed to when completing this follow-up: FOLLOW_UP, APPOINTMENT, LOST or TRANSFER_TO_SALES. Null only for follow-ups completed before the outcome was captured, and for rows that are still open or cancelled.';

drop function if exists public.complete_followup(uuid, bigint, text, uuid, text);

create or replace function public.complete_followup(
  target_followup_id uuid,
  expected_version bigint,
  completion_note text,
  target_request_id uuid,
  followup_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.followups%rowtype;
  request_fingerprint text;
  replay_result jsonb;
  manager_override boolean;
  normalized_completion_note text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if followup_outcome is null
    or followup_outcome not in ('FOLLOW_UP', 'APPOINTMENT', 'LOST', 'TRANSFER_TO_SALES')
  then
    raise exception using errcode = '22023', message = 'FOLLOWUP_OUTCOME_REQUIRED';
  end if;
  if char_length(btrim(coalesce(completion_note, ''))) > 1000 then
    raise exception using errcode = '22023', message = 'COMPLETION_NOTE_TOO_LONG';
  end if;
  normalized_completion_note := nullif(btrim(completion_note), '');

  select * into current_row
  from public.followups followup_row
  where followup_row.id = target_followup_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FOLLOWUP_NOT_FOUND';
  end if;
  manager_override := current_row.assigned_user_id <> auth.uid();
  if not app_private.has_permission(current_row.organization_id, 'followup.complete')
    or not app_private.can_access_record(
      current_row.organization_id,
      current_row.branch_id,
      current_row.team_id,
      current_row.assigned_user_id
    )
    or (
      manager_override
      and not app_private.has_permission(
        current_row.organization_id,
        'followup.override_complete'
      )
    )
  then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  request_fingerprint := app_private.work_request_fingerprint(jsonb_build_object(
    'followup_id', target_followup_id,
    'expected_version', expected_version,
    'completion_note', normalized_completion_note,
    'outcome', followup_outcome
  ));
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    auth.uid()::text || ':followup.completed:' || target_request_id::text,
    0
  ));
  replay_result := app_private.replay_work_request(
    current_row.organization_id,
    'followup.completed',
    target_request_id,
    request_fingerprint
  );
  if replay_result is not null then
    return replay_result;
  end if;
  if expected_version is null or current_row.version <> expected_version then
    raise exception using errcode = '40001', message = 'WORK_VERSION_CONFLICT';
  end if;
  if current_row.status <> 'OPEN' then
    raise exception using errcode = '23514', message = 'FOLLOWUP_TERMINAL';
  end if;

  update public.followups
  set status = 'COMPLETED',
      completed_at = clock_timestamp(),
      completion_note = normalized_completion_note,
      outcome = followup_outcome,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = current_row.id
  returning version, completed_at into current_row.version, current_row.completed_at;
  perform app_private.refresh_lead_next_followup(current_row.organization_id, current_row.lead_id);

  insert into public.activities (
    organization_id, customer_id, lead_id, activity_type, actor_id, metadata
  ) values (
    current_row.organization_id,
    current_row.customer_id,
    current_row.lead_id,
    'FOLLOWUP_COMPLETED',
    auth.uid(),
    jsonb_build_object(
      'followup_id', current_row.id,
      'manager_override', manager_override,
      'outcome', followup_outcome
    )
  );
  result := jsonb_build_object(
    'id', current_row.id,
    'version', current_row.version,
    'status', 'COMPLETED',
    'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id,
    branch_id, request_id, metadata
  ) values (
    current_row.organization_id,
    auth.uid(),
    'followup.completed',
    'followup',
    current_row.id::text,
    current_row.branch_id,
    target_request_id,
    jsonb_build_object(
      'request_fingerprint', request_fingerprint,
      'result', result,
      'assigned_user_id', current_row.assigned_user_id,
      'manager_override', manager_override,
      'outcome', followup_outcome,
      'completion_mode', case when manager_override then 'MANAGER_OVERRIDE' else 'OWNER' end
    )
  );
  return result;
end;
$$;

revoke all on function public.complete_followup(uuid, bigint, text, uuid, text)
  from public, anon;
grant execute on function public.complete_followup(uuid, bigint, text, uuid, text)
  to authenticated;

commit;
