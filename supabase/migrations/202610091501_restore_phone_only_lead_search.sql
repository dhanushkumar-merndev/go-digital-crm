begin;

-- The October same-mobile workspace replacement restored an older phone
-- expression that extracts digits from customer names. "Customer 08" then
-- matches every +918... enquiry and can page the named lead out of view.
-- Restore the existing phone-like-input guard for this function only, keeping
-- its current scope, grouping, projection and pagination logic intact.
do $patch$
declare
  definition text;
  patched text;
  assignment_pattern constant text :=
    'search_phone_digits\s*:=\s*coalesce\(\s*(app_private\.normalize_phone_digits\(normalized_search\),\s*)+''''\s*\);';
  replacement constant text :=
    'search_phone_digits := app_private.phone_search_digits(normalized_search);';
begin
  definition := pg_get_functiondef(
    'app_private.get_sales_role_lead_workspace_page(uuid,uuid,boolean,uuid[],uuid[],boolean,uuid[],integer,integer,text,text,text,text,text,text,text,date,date,boolean,boolean)'::regprocedure
  );
  if position(replacement in definition) > 0 then
    return;
  end if;
  if (select count(*) from regexp_matches(definition, assignment_pattern, 'g')) <> 1 then
    raise exception 'LEAD_PHONE_SEARCH_ASSIGNMENT_SHAPE_CHANGED';
  end if;
  patched := regexp_replace(definition, assignment_pattern, replacement);
  execute patched;
end;
$patch$;

notify pgrst, 'reload schema';
commit;
