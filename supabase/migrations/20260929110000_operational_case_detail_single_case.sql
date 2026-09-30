begin;

-- Opening one operational case (get_operational_case_detail) built every case
-- of the department through app_private.operational_case_rows -- both access
-- checks, the joins and the document counts for each -- and only then kept
-- the requested id, because a plpgsql set-returning function cannot take the
-- caller's filter. About 110 ms with ~28 cases per department in the demo
-- tenant, growing with every case until the 8 s statement timeout.
--
-- The detail function is operational_case_rows' only caller and always wants
-- one case, so the case id is now a parameter, filtered in each department
-- branch before the access checks run. Everything else is unchanged.
--
-- Verified before deploy as temporary copies against the live detail function:
-- 197/197 identical results -- every case of every department as that
-- department's manager, an OWN_RECORDS Sales Consultant, two denied roles, and
-- unknown ids. Median per open: 110-120 ms -> ~7 ms.
--
-- Patched in place from the deployed definitions (never re-emitted), and both
-- results must be byte-identical to the verified text.
do $migration$
declare
  rows_definition text := pg_catalog.pg_get_functiondef(
    'app_private.operational_case_rows(uuid,text)'::regprocedure
  );
  detail_definition text := pg_catalog.pg_get_functiondef(
    'public.get_operational_case_detail(text,uuid)'::regprocedure
  );
begin
  if (length(rows_definition) - length(replace(rows_definition, $o$operational_case_rows(target_organization_id uuid, target_department text)$o$, ''))) / length($o$operational_case_rows(target_organization_id uuid, target_department text)$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_CASE_DETAIL_PATCH_TARGET_NOT_FOUND: rows header';
  end if;
  rows_definition := replace(rows_definition, $o$operational_case_rows(target_organization_id uuid, target_department text)$o$, $n$operational_case_rows(target_organization_id uuid, target_department text, target_case_id uuid)$n$);
  if (length(rows_definition) - length(replace(rows_definition, $o$    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
$o$, ''))) / length($o$    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
$o$) <> 5 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_CASE_DETAIL_PATCH_TARGET_NOT_FOUND: rows branches';
  end if;
  rows_definition := replace(rows_definition, $o$    and case_row.organization_id = target_organization_id
    and case_row.deleted_at is null
$o$, $n$    and case_row.organization_id = target_organization_id
    and case_row.id = target_case_id
    and case_row.deleted_at is null
$n$);
  if (length(detail_definition) - length(replace(detail_definition, $o$  from app_private.operational_case_rows(current_organization_id, normalized_department) case_row
$o$, ''))) / length($o$  from app_private.operational_case_rows(current_organization_id, normalized_department) case_row
$o$) <> 1 then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_CASE_DETAIL_PATCH_TARGET_NOT_FOUND: detail call';
  end if;
  detail_definition := replace(detail_definition, $o$  from app_private.operational_case_rows(current_organization_id, normalized_department) case_row
$o$, $n$  from app_private.operational_case_rows(
    current_organization_id, normalized_department, target_case_id
  ) case_row
$n$);

  if md5(rows_definition) <> 'cb0e01ccbc6024238a78dd0b1b2fe00e' or md5(detail_definition) <> '9269a63d39f8dc13a9b993ab67b4c827' then
    raise exception using errcode = 'P0001', message = 'OPERATIONAL_CASE_DETAIL_PATCH_UNVERIFIED';
  end if;
  execute rows_definition;
  execute detail_definition;
end;
$migration$;

-- Same privileges as the two-argument version: owner only.
revoke all on function app_private.operational_case_rows(uuid, text, uuid)
  from public, anon, authenticated;
drop function app_private.operational_case_rows(uuid, text);

commit;
