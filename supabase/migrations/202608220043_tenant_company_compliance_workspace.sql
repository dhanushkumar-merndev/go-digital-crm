begin;

-- Company and compliance information is a tenant-owned administrative record.
-- This read model deliberately returns evidence metadata only: object IDs, keys,
-- download URLs and any credential/billing data never leave the server boundary.
create or replace function public.get_tenant_company_compliance_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  organization_row record;
  latest_submission_row record;
  evidence_rows jsonb;
  history_rows jsonb;
  branch_total integer;
  active_branch_total integer;
begin
  current_organization_id := app_private.current_tenant_organization();

  if auth.uid() is null
    or current_organization_id is null
    or not app_private.mfa_policy_satisfied(current_organization_id)
    or not app_private.has_organization_wide_scope(current_organization_id)
    or not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.user_id = auth.uid()
        and assignment_row.organization_id = current_organization_id
        and assignment_row.active
        and assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')
        and (
          (role_row.role_key = 'client_admin'
            and app_private.has_permission(current_organization_id, 'user.manage'))
          or role_row.role_key = 'business_owner'
        )
    )
  then
    raise exception using errcode = '42501', message = 'COMPANY_COMPLIANCE_VIEW_PERMISSION_REQUIRED';
  end if;

  select
    organization_source.id,
    organization_source.name,
    organization_source.legal_name,
    organization_source.gst_number,
    organization_source.status::text as status,
    organization_source.created_at,
    organization_source.updated_at
  into organization_row
  from public.organizations organization_source
  where organization_source.id = current_organization_id
    and organization_source.deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'ORGANIZATION_NOT_FOUND';
  end if;

  select
    submission_source.id,
    submission_source.version,
    submission_source.organization_name,
    submission_source.legal_name,
    submission_source.gst_number,
    submission_source.dealer_information,
    submission_source.status,
    submission_source.submitted_at,
    submission_source.reviewed_at,
    submission_source.review_note
  into latest_submission_row
  from public.organization_onboarding_submissions submission_source
  where submission_source.organization_id = current_organization_id
  order by submission_source.version desc
  limit 1;

  if latest_submission_row.id is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'document_type', document_source.document_type,
          'uploaded_at', document_source.created_at,
          'mime_type', file_source.mime_type,
          'size_bytes', file_source.size_bytes
        )
        order by document_source.document_type
      ),
      '[]'::jsonb
    )
    into evidence_rows
    from public.organization_onboarding_documents document_source
    join public.object_files file_source
      on file_source.id = document_source.object_file_id
     and file_source.organization_id = current_organization_id
     and file_source.deleted_at is null
    where document_source.organization_id = current_organization_id
      and document_source.submission_id = latest_submission_row.id;
  else
    evidence_rows := '[]'::jsonb;
  end if;

  select
    count(*)::integer,
    count(*) filter (where branch_source.active)::integer
  into branch_total, active_branch_total
  from public.branches branch_source
  where branch_source.organization_id = current_organization_id
    and branch_source.deleted_at is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'from_status', history_source.from_status,
        'to_status', history_source.to_status,
        'reason', history_source.reason,
        'created_at', history_source.created_at
      ) order by history_source.created_at desc, history_source.id desc
    ),
    '[]'::jsonb
  )
  into history_rows
  from (
    select
      status_source.id,
      status_source.from_status::text as from_status,
      status_source.to_status::text as to_status,
      status_source.reason,
      status_source.created_at
    from public.tenant_status_history status_source
    where status_source.organization_id = current_organization_id
    order by status_source.created_at desc, status_source.id desc
    limit 8
  ) history_source;

  return jsonb_build_object(
    'organization', jsonb_build_object(
      'id', organization_row.id,
      'name', organization_row.name,
      'legal_name', organization_row.legal_name,
      'gst_number', organization_row.gst_number,
      'status', organization_row.status,
      'created_at', organization_row.created_at,
      'updated_at', organization_row.updated_at
    ),
    'branch_summary', jsonb_build_object(
      'total', coalesce(branch_total, 0),
      'active', coalesce(active_branch_total, 0)
    ),
    'latest_submission', case
      when latest_submission_row.id is null then null
      else jsonb_build_object(
        'version', latest_submission_row.version,
        'organization_name', latest_submission_row.organization_name,
        'legal_name', latest_submission_row.legal_name,
        'gst_number', latest_submission_row.gst_number,
        'dealer_information', coalesce(latest_submission_row.dealer_information, '{}'::jsonb),
        'status', latest_submission_row.status,
        'submitted_at', latest_submission_row.submitted_at,
        'reviewed_at', latest_submission_row.reviewed_at,
        'review_note', latest_submission_row.review_note,
        'evidence', evidence_rows
      )
    end,
    'status_history', history_rows
  );
end;
$$;

revoke all on function public.get_tenant_company_compliance_workspace() from public, anon;
grant execute on function public.get_tenant_company_compliance_workspace() to authenticated;

commit;
