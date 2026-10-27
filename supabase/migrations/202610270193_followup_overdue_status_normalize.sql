-- Follow-ups stored as OVERDUE.
--
-- Overdue is derived from due_at (the lists label an OPEN follow-up past its
-- due time "Overdue"), but 50 seeded follow-ups were written with status
-- OVERDUE. complete_followup and update_followup accept only OPEN, so those
-- could not be completed or rescheduled; the follow-up list left them out of
-- the Overdue, Today and Upcoming tabs; and the dashboards still counted them,
-- so the mobile home read 150 overdue above a "147 overdue" link.
-- They are opened again with their due time untouched, and OVERDUE is no
-- longer a storable status, so a derived state cannot be persisted again.

begin;

update public.followups
set status = 'OPEN',
    version = version + 1,
    updated_at = now()
where status = 'OVERDUE';

alter table public.followups drop constraint followups_status_check;
alter table public.followups
  add constraint followups_status_check
  check (status = any (array['OPEN'::text, 'COMPLETED'::text, 'CANCELLED'::text]));

commit;
