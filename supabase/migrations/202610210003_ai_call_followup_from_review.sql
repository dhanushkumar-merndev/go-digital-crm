-- An approved AI "next follow-up" becomes a follow-up someone works (found in
-- the 2026-10-21 end-to-end run).
--
-- review_ai_call_fields wrote next_followup_at straight onto the lead, so the
-- lead showed a date but "No follow-up set", and nothing appeared in the
-- Follow-ups queue. It now goes through create_followup, which also keeps
-- leads.next_followup_at in step; when the lead already has an open follow-up,
-- that one is rescheduled through update_followup instead of adding a second.
-- A time outside what create_followup accepts (past, or over two years out)
-- keeps the old behaviour of setting the lead's date only.
-- Patched onto the live definition (see 202610210001), never re-emitted.

begin;

create or replace function pg_temp.patch_function(target regprocedure, old_text text, new_text text)
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
  'public.review_ai_call_fields(uuid,jsonb,uuid)',
  $old$  requirements_patch jsonb := '{}'::jsonb;
$old$,
  $new$  requirements_patch jsonb := '{}'::jsonb;
  followup_due timestamptz;
  open_followup record;
$new$
);

select pg_temp.patch_function(
  'public.review_ai_call_fields(uuid,jsonb,uuid)',
  $old$    if decision_row.decision in ('APPLIED', 'EDITED') and decision_row.field_key in (
      'variant',$old$,
  $new$    if decision_row.decision in ('APPLIED', 'EDITED')
      and decision_row.field_key = 'next_followup_at'
      and (resolved_value #>> '{}') is not null
      and (resolved_value #>> '{}')::timestamptz
        between now() - interval '5 minutes' and now() + interval '2 years'
    then
      followup_due := (resolved_value #>> '{}')::timestamptz;
      accepted_fields := array_append(accepted_fields, decision_row.field_key);
    elsif decision_row.decision in ('APPLIED', 'EDITED') and decision_row.field_key in (
      'variant',$new$
);

select pg_temp.patch_function(
  'public.review_ai_call_fields(uuid,jsonb,uuid)',
  $old$  if requirements_patch <> '{}'::jsonb then
$old$,
  $new$  if followup_due is not null then
    select followup_row.id, followup_row.version into open_followup
    from public.followups followup_row
    where followup_row.organization_id = updated_lead.organization_id
      and followup_row.lead_id = updated_lead.id
      and followup_row.status = 'OPEN'
    order by followup_row.due_at, followup_row.id
    limit 1;
    if open_followup.id is null then
      perform public.create_followup(
        updated_lead.id,
        updated_lead.customer_id,
        updated_lead.branch_id,
        updated_lead.team_id,
        updated_lead.assigned_user_id,
        'Next step agreed on the call',
        followup_due,
        'NORMAL',
        md5(target_request_id::text || ':followup')::uuid
      );
    else
      perform public.update_followup(
        open_followup.id,
        open_followup.version,
        jsonb_build_object('due_at', followup_due),
        md5(target_request_id::text || ':followup')::uuid
      );
    end if;
  end if;

  if requirements_patch <> '{}'::jsonb then
$new$
);

commit;
