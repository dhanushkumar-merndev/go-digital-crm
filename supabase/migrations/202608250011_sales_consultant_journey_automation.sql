begin;

-- Video and consultant calls are first-class appointments.  Keep the existing
-- transaction, idempotency and audit behaviour intact; only expand the
-- permitted appointment type list in the two focused RPCs.
do $migration$
declare
  signature regprocedure;
  definition text;
  updated_definition text;
begin
  foreach signature in array array[
    'public.create_appointment(uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'::regprocedure,
    'public.update_appointment(uuid,bigint,jsonb,uuid)'::regprocedure
  ] loop
    select pg_get_functiondef(signature) into definition;
    if position('''Video Call''' in definition) > 0 then
      continue;
    end if;
    updated_definition := replace(
      replace(
        definition,
        E'(''Showroom Visit'',''Test Drive'')',
        E'(''Showroom Visit'',''Video Call'',''Consultant Call'',''Test Drive'')'
      ),
      E'(''Showroom Visit'', ''Test Drive'')',
      E'(''Showroom Visit'', ''Video Call'', ''Consultant Call'', ''Test Drive'')'
    );
    if updated_definition = definition then
      raise exception using errcode = 'P0001', message = 'APPOINTMENT_TYPE_PATCH_TARGET_NOT_FOUND';
    end if;
    execute updated_definition;
  end loop;
end;
$migration$;

-- Keep the next action visible in Tasks without relying on a browser session.
-- The checks make retries, status edits and reschedules idempotent.
create or replace function app_private.automate_sales_appointment_tasks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  confirmation_title text := 'Confirm ' || new.appointment_type;
  followup_title text := 'Follow up after ' || new.appointment_type;
  confirmation_due_at timestamptz := greatest(clock_timestamp(), new.scheduled_at - interval '1 day');
begin
  if new.lead_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.tasks task_row
      where task_row.organization_id = new.organization_id
        and task_row.resource_type = 'APPOINTMENT'
        and task_row.resource_id = new.id
        and task_row.title = confirmation_title
        and task_row.status in ('OPEN', 'IN_PROGRESS')
    ) then
      insert into public.tasks (
        organization_id, branch_id, team_id, assigned_user_id,
        resource_type, resource_id, lead_id, customer_id,
        title, description, priority, status, due_at, created_by, updated_by
      ) values (
        new.organization_id, new.branch_id, new.team_id, new.assigned_user_id,
        'APPOINTMENT', new.id, new.lead_id, new.customer_id,
        confirmation_title, 'Confirm the customer attendance before the scheduled appointment.',
        'HIGH', 'OPEN', confirmation_due_at, coalesce(new.created_by, new.assigned_user_id),
        coalesce(new.created_by, new.assigned_user_id)
      );
    end if;
  elsif new.status = 'COMPLETED' and old.status is distinct from 'COMPLETED' then
    if not exists (
      select 1 from public.tasks task_row
      where task_row.organization_id = new.organization_id
        and task_row.resource_type = 'APPOINTMENT'
        and task_row.resource_id = new.id
        and task_row.title = followup_title
        and task_row.status in ('OPEN', 'IN_PROGRESS')
    ) then
      insert into public.tasks (
        organization_id, branch_id, team_id, assigned_user_id,
        resource_type, resource_id, lead_id, customer_id,
        title, description, priority, status, due_at, created_by, updated_by
      ) values (
        new.organization_id, new.branch_id, new.team_id, new.assigned_user_id,
        'APPOINTMENT', new.id, new.lead_id, new.customer_id,
        followup_title, 'Record the outcome and schedule the customer''s next sales action.',
        'HIGH', 'OPEN', clock_timestamp() + interval '1 day',
        coalesce(new.created_by, new.assigned_user_id), coalesce(new.created_by, new.assigned_user_id)
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_sales_journey_tasks on public.appointments;
create trigger appointments_sales_journey_tasks
after insert or update of status on public.appointments
for each row execute function app_private.automate_sales_appointment_tasks();

create index if not exists tasks_appointment_open_unique_idx
  on public.tasks (organization_id, resource_type, resource_id, title)
  where status in ('OPEN', 'IN_PROGRESS');

commit;
