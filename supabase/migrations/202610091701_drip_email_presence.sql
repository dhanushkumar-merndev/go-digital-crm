begin;

-- An SMS fallback is a separate LEAD_CREATED campaign with email_presence
-- MISSING. Use the same contact resolution as email delivery, including an
-- already-linked customer, and re-check delayed messages before claiming.
create or replace function app_private.drip_email_presence_matches(
  target_organization_id uuid, target_customer_id uuid, target_lead_email text,
  target_presence text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case coalesce(target_presence, 'ANY')
    when 'ANY' then true
    when 'MISSING' then contact.email is null
    when 'PRESENT' then contact.email is not null
    else false
  end
  from (
    select coalesce(
      (select nullif(btrim(customer_row.primary_email), '') from public.customers customer_row
       where customer_row.organization_id = target_organization_id
         and customer_row.id = target_customer_id and customer_row.deleted_at is null),
      nullif(btrim(target_lead_email), '')
    ) as email
  ) contact;
$function$;
revoke all on function app_private.drip_email_presence_matches(uuid, uuid, text, text)
  from public, anon, authenticated;

alter table public.customer_drip_messages
  drop constraint customer_drip_messages_skip_reason_check,
  add constraint customer_drip_messages_skip_reason_check check (
    skip_reason is null or skip_reason in (
      'CAMPAIGN_PAUSED', 'DORMANT', 'OPTED_OUT', 'NO_RECIPIENT', 'EMAIL_CONDITION_CHANGED'
    )
  );

-- Extend the deployed functions without replacing their other scope,
-- opt-out, temperature and event rules. Fail the migration on a changed body.
do $patch$
declare
  body text;
  anchor text;
begin
  body := pg_get_functiondef('app_private.normalize_drip_campaign_payload(uuid,jsonb)'::regprocedure);
  anchor := 'if trigger_value = ''LEAD_CREATED'' then';
  if position(anchor in body) = 0 then raise exception 'DRIP_NORMALIZER_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || $sql$
    if conditions ? 'email_presence' and (
      jsonb_typeof(conditions -> 'email_presence') <> 'string'
      or (conditions ->> 'email_presence') not in ('ANY', 'PRESENT', 'MISSING')
    ) then
      raise exception using errcode = '22023', message = 'INVALID_DRIP_EMAIL_PRESENCE';
    end if;
  $sql$);
  anchor := '''sources'', coalesce((select jsonb_agg(distinct source_name)';
  if position(anchor in body) = 0 then raise exception 'DRIP_CONDITIONS_ANCHOR_MISSING'; end if;
  body := replace(body, anchor,
    '''email_presence'', coalesce(conditions ->> ''email_presence'', ''ANY''), ' || anchor);
  execute body;

  body := pg_get_functiondef('public.run_event_drip_matches(integer)'::regprocedure);
  anchor := 'and lead_row.created_at >= pass_at - interval ''3 days''';
  if position(anchor in body) = 0 then raise exception 'DRIP_EVENT_EMAIL_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || $sql$
      and app_private.drip_email_presence_matches(
        lead_row.organization_id, lead_row.customer_id, lead_row.email,
        campaign.conditions ->> 'email_presence'
      )
  $sql$);
  execute body;

  body := pg_get_functiondef('public.preview_marketing_drip_audience(text,jsonb,uuid)'::regprocedure);
  anchor := 'and lead_row.created_at >= now() - interval ''30 days''';
  if position(anchor in body) = 0 then raise exception 'DRIP_PREVIEW_EMAIL_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || $sql$
      and app_private.drip_email_presence_matches(
        lead_row.organization_id, lead_row.customer_id, lead_row.email,
        conditions ->> 'email_presence'
      )
  $sql$);
  execute body;

  body := pg_get_functiondef('public.claim_due_drip_messages(text,integer)'::regprocedure);
  anchor := 'when enrollment_row.customer_id is not null and exists (';
  if position(anchor in body) = 0 then raise exception 'DRIP_CLAIM_EMAIL_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, $sql$
        when campaign_row.trigger_type = 'LEAD_CREATED'
          and not app_private.drip_email_presence_matches(
            enrollment_row.organization_id, enrollment_row.customer_id,
            (select lead_row.email from public.leads lead_row
             where lead_row.id = enrollment_row.lead_id
               and lead_row.organization_id = enrollment_row.organization_id),
            campaign_row.trigger_conditions ->> 'email_presence'
          ) then 'EMAIL_CONDITION_CHANGED'
        $sql$ || anchor);
  -- The cancellation pass is bounded. Messages beyond that pass still must
  -- satisfy the condition when the worker claims its temperature-ordered batch.
  anchor := 'left join public.leads priority_lead on priority_lead.id = priority_enrollment.lead_id';
  if position(anchor in body) = 0 then raise exception 'DRIP_CANDIDATE_EMAIL_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, anchor || $sql$
    left join public.marketing_drip_campaigns email_campaign
      on email_campaign.id = priority_enrollment.source_campaign_id
  $sql$);
  anchor := '-- AGENTS.md 9.7: HOT first, then WARM, then COLD, then by due time.';
  if position(anchor in body) = 0 then raise exception 'DRIP_CANDIDATE_FILTER_ANCHOR_MISSING'; end if;
  body := replace(body, anchor, $sql$
    and (email_campaign.trigger_type is distinct from 'LEAD_CREATED'
      or app_private.drip_email_presence_matches(
        priority_enrollment.organization_id, priority_enrollment.customer_id,
        priority_lead.email, email_campaign.trigger_conditions ->> 'email_presence'
      ))
    $sql$ || anchor);
  execute body;
end;
$patch$;

commit;
