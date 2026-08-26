begin;

-- Test drives are their own module, on their own tables. `public.appointments`
-- typed 'Test Drive' was a parallel path that never reached any of it: it
-- created no `test_drives` row, held no stock unit, registration, route,
-- odometer or feedback, and was invisible to the Test Drives workspace. A
-- consultant who booked one saw a confirmed test drive that the business did
-- not have.
--
-- Booking one is therefore removed. This is a validation change only:
--   * `create_appointment` and `update_appointment` stop accepting the type,
--     so no new one can be made and an existing one cannot be retyped into it;
--   * the list and calendar filters stop offering it as a filter value.
--
-- Appointments already stored with that type are deliberately left in place and
-- still listed, still reschedulable, still cancellable. Hiding them would take
-- commitments off a consultant's day with no way to reach them; the patch below
-- only closes the door on creating more. `update_appointment` rejects the type
-- solely when the patch names `appointment_type`, so rescheduling or closing a
-- legacy row is unaffected.
do $migration$
declare
  signature regprocedure;
  definition text;
  updated_definition text;
begin
  foreach signature in array array[
    'public.create_appointment(uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'::regprocedure,
    'public.update_appointment(uuid,bigint,jsonb,uuid)'::regprocedure,
    'public.get_appointment_workspace_page(text,text,text,uuid,uuid,uuid,integer,integer,text,text)'::regprocedure,
    'public.get_appointment_calendar(date,date,text,text,text,uuid,uuid,uuid,text)'::regprocedure,
    'app_private.get_sales_consultant_appointment_calendar(uuid,uuid,uuid[],boolean,date,date,text,text,text,uuid,uuid,uuid,text)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(signature) into definition;

    -- Already separated: re-running this migration must not fail.
    if position('''Test Drive''' in definition) = 0 then
      continue;
    end if;

    -- Both orderings the type list has been written in are handled, because
    -- earlier migrations widened it twice with different spacing.
    updated_definition := replace(
      replace(
        replace(
          definition,
          E'''Video Call'', ''Test Drive'', ''Consultant Call''',
          E'''Video Call'', ''Consultant Call'''
        ),
        E'''Video Call'',''Consultant Call'',''Test Drive''',
        E'''Video Call'',''Consultant Call'''
      ),
      E'''Video Call'', ''Consultant Call'', ''Test Drive''',
      E'''Video Call'', ''Consultant Call'''
    );

    -- A silently unmatched patch would leave the type bookable while the
    -- migration reported success, so the mismatch has to be loud.
    if updated_definition = definition then
      raise exception using
        errcode = 'P0001',
        message = 'APPOINTMENT_TEST_DRIVE_PATCH_TARGET_NOT_FOUND: ' || signature::text;
    end if;
    execute updated_definition;
  end loop;
end;
$migration$;

commit;
