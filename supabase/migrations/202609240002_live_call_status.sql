begin;

-- The moment the customer leg is answered. started_at is when the CRM asked
-- TeleCMI to dial, so a "Connected" timer counting from it would include the
-- ringing time and read minutes longer than the conversation.
alter table public.calls add column if not exists answered_at timestamptz;

-- One small read behind the live call bar. It returns at most one row -- the
-- caller's own in-flight call -- so the browser polls nothing and the realtime
-- broadcast on public.calls is what makes it move.
--
-- Two bounds matter. Live statuses are limited to the last five minutes so a
-- call TeleCMI accepted and then abandoned (no webhook ever arrives) cannot
-- pin a permanent "Starting call..." to the screen. Terminal statuses linger
-- for 25 seconds so the outcome is actually readable before it disappears.
create or replace function public.get_active_call_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'call_id', call_row.id,
    'status', call_row.status,
    'outcome', call_row.outcome,
    'lead_id', call_row.lead_id,
    'customer_id', call_row.customer_id,
    'customer_name', coalesce(customer_row.full_name, lead_row.customer_name, 'Customer'),
    'phone', coalesce(customer_row.primary_phone, lead_row.phone),
    'started_at', call_row.started_at,
    'answered_at', call_row.answered_at,
    'ended_at', call_row.ended_at,
    'duration_seconds', call_row.duration_seconds
  )
  from public.calls call_row
  left join public.customers customer_row
    on customer_row.id = call_row.customer_id
   and customer_row.organization_id = call_row.organization_id
  left join public.leads lead_row
    on lead_row.id = call_row.lead_id
   and lead_row.organization_id = call_row.organization_id
  where call_row.assigned_user_id = auth.uid()
    and call_row.call_source = 'PROVIDER'
    and (
      (
        call_row.status in ('PENDING', 'RINGING', 'IN_PROGRESS')
        and call_row.started_at > now() - interval '5 minutes'
      )
      or (
        call_row.ended_at is not null
        and call_row.ended_at > now() - interval '25 seconds'
      )
    )
  order by call_row.started_at desc
  limit 1;
$$;

revoke all on function public.get_active_call_status() from public, anon;
grant execute on function public.get_active_call_status() to authenticated;

commit;
