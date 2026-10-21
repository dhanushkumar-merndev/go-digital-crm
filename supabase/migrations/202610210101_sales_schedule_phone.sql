-- The Sales Consultant dashboard schedule ("Up next" on mobile) carries the
-- customer's phone so a row can be swiped to call, like Call next and Recent
-- leads. Every branch already joins the lead and/or customer it reads, so this
-- adds a column, not a join; the rows and their scope are unchanged.
-- Patched onto the live definition (see 202610171593), never re-emitted.

begin;

create function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
returns void
language plpgsql
as $$
declare
  definition text := pg_get_functiondef(target);
  occurrences integer := (char_length(definition) - char_length(replace(definition, old_text, ''))) / char_length(old_text);
begin
  if occurrences <> 1 then
    raise exception 'PATCH_ANCHOR_% for %: expected 1 occurrence, found %',
      md5(old_text), target, occurrences;
  end if;
  execute replace(definition, old_text, new_text);
  if position(new_text in pg_get_functiondef(target)) = 0 then
    raise exception 'PATCH_NOT_APPLIED for %', target;
  end if;
end;
$$;

select pg_temp.patch_function(
  'public.get_sales_consultant_dashboard_live(text)',
  $old$        source_row.detail,
        source_row.status
      from ($old$,
  $new$        source_row.detail,
        source_row.status,
        source_row.phone
      from ($new$
);

select pg_temp.patch_function(
  'public.get_sales_consultant_dashboard_live(text)',
  $old$          followup_row.status
        from public.followups followup_row$old$,
  $new$          followup_row.status,
          coalesce(lead_row.phone, customer_row.primary_phone) as phone
        from public.followups followup_row$new$
);

select pg_temp.patch_function(
  'public.get_sales_consultant_dashboard_live(text)',
  $old$          appointment_row.status
        from public.appointments appointment_row$old$,
  $new$          appointment_row.status,
          coalesce(lead_row.phone, customer_row.primary_phone)
        from public.appointments appointment_row$new$
);

select pg_temp.patch_function(
  'public.get_sales_consultant_dashboard_live(text)',
  $old$          drive_row.status
        from public.test_drive_appointments drive_row$old$,
  $new$          drive_row.status,
          coalesce(lead_row.phone, customer_row.primary_phone)
        from public.test_drive_appointments drive_row$new$
);

select pg_temp.patch_function(
  'public.get_sales_consultant_dashboard_live(text)',
  $old$          delivery_row.status
        from public.delivery_cases delivery_row$old$,
  $new$          delivery_row.status,
          customer_row.primary_phone
        from public.delivery_cases delivery_row$new$
);

commit;
