begin;

-- A customer who rated 1-3 stars on the public feedback form (202609070202)
-- could not submit. route_completed_customer_feedback opens a customer-care
-- case with created_by = auth.uid(), which is null for the anonymous visitor,
-- so the NOT NULL violation rolled the whole submission back. 4-5 star
-- submissions were unaffected because that branch creates no case.
--
-- The case is now attributed to the staff member who issued the customer's
-- form link (the feedback_request.link_issued audit row), falling back to the
-- delivery case owner. Staff-entered feedback keeps auth.uid().

do $patch$
declare
  target regprocedure := 'app_private.route_completed_customer_feedback()'::regprocedure;
  definition text := pg_get_functiondef(target);
  declare_anchor text := 'review_url text; description text;';
  value_anchor text := E'now()+interval ''8 hours'',auth.uid());';
  creator_anchor text := E'    description := ''Customer feedback '' ';
begin
  if position('case_creator' in definition) > 0 then
    raise exception 'route_completed_customer_feedback already patched';
  end if;
  if (length(definition) - length(replace(definition, declare_anchor, ''))) / length(declare_anchor) <> 1
    or (length(definition) - length(replace(definition, value_anchor, ''))) / length(value_anchor) <> 1
    or (length(definition) - length(replace(definition, creator_anchor, ''))) / length(creator_anchor) <> 1
  then
    raise exception 'route_completed_customer_feedback anchors not found exactly once';
  end if;

  definition := replace(definition, declare_anchor,
    'review_url text; description text; case_creator uuid;');
  definition := replace(definition, creator_anchor,
    E'    -- The public form has no session; attribute the case to whoever sent the link.\n'
    || E'    case_creator := coalesce(\n'
    || E'      auth.uid(),\n'
    || E'      (select audit_row.actor_id from public.audit_logs audit_row\n'
    || E'        where audit_row.organization_id = new.organization_id\n'
    || E'          and audit_row.action = ''feedback_request.link_issued''\n'
    || E'          and audit_row.resource_type = ''feedback_request''\n'
    || E'          and audit_row.resource_id = new.id::text\n'
    || E'          and audit_row.actor_id is not null\n'
    || E'        order by audit_row.created_at desc limit 1),\n'
    || E'      (select delivery_row.assigned_user_id from public.delivery_cases delivery_row\n'
    || E'        where delivery_row.organization_id = new.organization_id\n'
    || E'          and delivery_row.id = new.delivery_case_id)\n'
    || E'    );\n'
    || creator_anchor);
  definition := replace(definition, value_anchor,
    E'now()+interval ''8 hours'',case_creator);');
  execute definition;

  definition := pg_get_functiondef(target);
  if position('case_creator);' in definition) = 0
    or position(value_anchor in definition) > 0
  then
    raise exception 'route_completed_customer_feedback patch did not apply';
  end if;
end;
$patch$;

commit;
