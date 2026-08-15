begin;

create unique index object_files_org_id_unique_idx
  on public.object_files (organization_id, id);

create table public.organization_onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  version integer not null check (version > 0),
  organization_name text not null,
  legal_name text not null,
  gst_number text not null,
  dealer_information jsonb not null,
  status text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'CHANGES_REQUIRED', 'APPROVED', 'REJECTED')),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  unique (organization_id, version),
  unique (organization_id, id),
  constraint onboarding_submitter_org_fk
    foreign key (organization_id, submitted_by)
    references public.profiles (organization_id, id)
    not valid,
  constraint onboarding_gst_format check (
    gst_number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  )
);

create table public.organization_onboarding_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  submission_id uuid not null references public.organization_onboarding_submissions(id),
  document_type text not null check (
    document_type in ('OWNER_IDENTITY', 'GST_CERTIFICATE', 'DEALERSHIP_AUTHORIZATION')
  ),
  object_file_id uuid not null references public.object_files(id),
  created_at timestamptz not null default now(),
  unique (submission_id, document_type),
  unique (submission_id, object_file_id),
  constraint onboarding_document_submission_org_fk
    foreign key (organization_id, submission_id)
    references public.organization_onboarding_submissions (organization_id, id)
    not valid,
  constraint onboarding_document_file_org_fk
    foreign key (organization_id, object_file_id)
    references public.object_files (organization_id, id)
    not valid
);

alter table public.organization_onboarding_submissions enable row level security;
alter table public.organization_onboarding_submissions force row level security;
alter table public.organization_onboarding_documents enable row level security;
alter table public.organization_onboarding_documents force row level security;
revoke insert, update, delete, truncate on public.organization_onboarding_submissions
from anon, authenticated;
revoke insert, update, delete, truncate on public.organization_onboarding_documents
from anon, authenticated;

create policy onboarding_submissions_read on public.organization_onboarding_submissions
for select to authenticated using (
  (
    app_private.is_platform_admin()
    and app_private.mfa_policy_satisfied(null)
  )
  or exists (
    select 1
    from public.organizations organization_row
    join public.profiles profile_row
      on profile_row.id = auth.uid()
     and profile_row.organization_id = organization_row.id
    where organization_row.id = organization_id
      and organization_row.primary_owner_id = auth.uid()
      and profile_row.active
      and profile_row.deleted_at is null
      and app_private.mfa_policy_satisfied(organization_id)
  )
);
create policy onboarding_documents_read on public.organization_onboarding_documents
for select to authenticated using (
  exists (
    select 1
    from public.organization_onboarding_submissions submission_row
    where submission_row.id = submission_id
      and submission_row.organization_id = organization_id
  )
);

create or replace function public.get_tenant_onboarding_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare profile_row public.profiles%rowtype;
declare organization_row public.organizations%rowtype;
declare latest_submission public.organization_onboarding_submissions%rowtype;
begin
  select * into profile_row
  from public.profiles
  where id = auth.uid()
    and active
    and deleted_at is null;
  if not found or profile_row.organization_id is null then
    raise exception using errcode = '42501', message = 'ONBOARDING_OWNER_REQUIRED';
  end if;
  select * into organization_row
  from public.organizations
  where id = profile_row.organization_id
    and primary_owner_id = auth.uid()
    and status in ('ONBOARDING', 'UNDER_REVIEW', 'CHANGES_REQUIRED')
    and deleted_at is null;
  if not found
    or not app_private.mfa_policy_satisfied(profile_row.organization_id)
    or not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.organization_id = profile_row.organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
        and assignment_row.data_scope = 'ORGANIZATION'
        and role_row.role_key = 'business_owner'
    )
  then
    raise exception using errcode = '42501', message = 'ONBOARDING_OWNER_REQUIRED';
  end if;
  select * into latest_submission
  from public.organization_onboarding_submissions submission_row
  where submission_row.organization_id = organization_row.id
  order by submission_row.version desc
  limit 1;
  return jsonb_build_object(
    'organization_id', organization_row.id,
    'status', organization_row.status,
    'organization_name', organization_row.name,
    'legal_name', organization_row.legal_name,
    'gst_number', organization_row.gst_number,
    'latest_submission_id', latest_submission.id,
    'latest_submission_status', latest_submission.status,
    'dealer_information', coalesce(latest_submission.dealer_information, '{}'::jsonb),
    'review_note', latest_submission.review_note
  );
end;
$$;

create or replace function public.submit_tenant_onboarding(
  target_organization_name text,
  target_legal_name text,
  target_gst_number text,
  target_dealer_information jsonb,
  target_documents jsonb,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare profile_row public.profiles%rowtype;
declare organization_row public.organizations%rowtype;
declare created_submission_id uuid;
declare next_version integer;
declare normalized_gst_number text;
begin
  select * into profile_row
  from public.profiles
  where id = auth.uid()
    and active
    and deleted_at is null;
  if not found or profile_row.organization_id is null then
    raise exception using errcode = '42501', message = 'ONBOARDING_OWNER_REQUIRED';
  end if;
  select * into organization_row
  from public.organizations
  where id = profile_row.organization_id
    and primary_owner_id = auth.uid()
    and status in ('ONBOARDING', 'CHANGES_REQUIRED')
    and deleted_at is null
  for update;
  if not found
    or not app_private.mfa_policy_satisfied(profile_row.organization_id)
    or not exists (
      select 1
      from public.user_role_assignments assignment_row
      join public.roles role_row
        on role_row.id = assignment_row.role_id
       and role_row.organization_id = assignment_row.organization_id
      where assignment_row.organization_id = profile_row.organization_id
        and assignment_row.user_id = auth.uid()
        and assignment_row.active
        and assignment_row.data_scope = 'ORGANIZATION'
        and role_row.role_key = 'business_owner'
    )
  then
    raise exception using errcode = '42501', message = 'ONBOARDING_OWNER_REQUIRED';
  end if;
  normalized_gst_number := upper(btrim(coalesce(target_gst_number, '')));
  if char_length(btrim(coalesce(target_organization_name, ''))) not between 2 and 160
    or char_length(btrim(coalesce(target_legal_name, ''))) not between 2 and 200
    or normalized_gst_number !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
    or jsonb_typeof(target_dealer_information) <> 'object'
    or octet_length(target_dealer_information::text) > 10000
    or exists (
      select 1
      from jsonb_object_keys(target_dealer_information) dealer_key
      where dealer_key not in (
        'registered_address', 'dealership_license_number', 'manufacturer_names',
        'contact_phone', 'contact_email'
      )
    )
    or jsonb_typeof(target_documents) <> 'array'
    or jsonb_array_length(target_documents) <> 3
  then
    raise exception using errcode = '22023', message = 'INVALID_ONBOARDING_SUBMISSION';
  end if;
  if (
    select count(*)
    from (
      select distinct document_row.document_type
      from jsonb_to_recordset(target_documents) as document_row(
        document_type text,
        object_file_id uuid
      )
      where document_row.document_type in (
        'OWNER_IDENTITY', 'GST_CERTIFICATE', 'DEALERSHIP_AUTHORIZATION'
      )
    ) required_documents
  ) <> 3 or exists (
    select 1
    from jsonb_to_recordset(target_documents) as document_row(
      document_type text,
      object_file_id uuid
    )
    left join public.object_files file_row
      on file_row.id = document_row.object_file_id
     and file_row.organization_id = organization_row.id
     and file_row.resource_type = 'organization'
     and file_row.resource_id = organization_row.id
     and file_row.uploaded_by = auth.uid()
     and file_row.deleted_at is null
     and file_row.mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     and file_row.size_bytes between 1 and 26214400
    where file_row.id is null
  ) then
    raise exception using errcode = '23514', message = 'ONBOARDING_DOCUMENTS_INVALID';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.organization_onboarding_submissions
  where organization_id = organization_row.id;
  insert into public.organization_onboarding_submissions (
    organization_id, version, organization_name, legal_name, gst_number,
    dealer_information, status, submitted_by, submitted_at
  ) values (
    organization_row.id, next_version, btrim(target_organization_name),
    btrim(target_legal_name), normalized_gst_number, target_dealer_information,
    'SUBMITTED', auth.uid(), now()
  ) returning id into created_submission_id;
  insert into public.organization_onboarding_documents (
    organization_id, submission_id, document_type, object_file_id
  )
  select organization_row.id, created_submission_id,
    document_row.document_type, document_row.object_file_id
  from jsonb_to_recordset(target_documents) as document_row(
    document_type text,
    object_file_id uuid
  );
  update public.organizations
  set name = btrim(target_organization_name),
      legal_name = btrim(target_legal_name),
      gst_number = normalized_gst_number,
      status = 'UNDER_REVIEW',
      updated_at = now()
  where id = organization_row.id;
  insert into public.tenant_status_history (
    organization_id, from_status, to_status, changed_by, reason
  ) values (
    organization_row.id, organization_row.status, 'UNDER_REVIEW', auth.uid(),
    'Business Owner submitted required onboarding evidence'
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    organization_row.id, auth.uid(), 'tenant.onboarding_submitted',
    'organization_onboarding_submission', created_submission_id::text,
    target_request_id, jsonb_build_object('version', next_version, 'document_count', 3)
  );
  return jsonb_build_object(
    'submission_id', created_submission_id,
    'version', next_version,
    'status', 'UNDER_REVIEW'
  );
end;
$$;

create or replace function public.review_tenant_onboarding(
  target_submission_id uuid,
  target_decision text,
  target_review_note text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare submission_row public.organization_onboarding_submissions%rowtype;
declare organization_row public.organizations%rowtype;
declare next_tenant_status public.tenant_status;
declare next_submission_status text;
begin
  if not app_private.is_platform_admin()
    or not app_private.mfa_policy_satisfied(null)
  then
    raise exception using errcode = '42501', message = 'PLATFORM_MFA_REQUIRED';
  end if;
  if target_decision not in ('APPROVE', 'REQUEST_CHANGES', 'REJECT')
    or char_length(coalesce(target_review_note, '')) > 1000
    or (
      target_decision in ('REQUEST_CHANGES', 'REJECT')
      and char_length(btrim(coalesce(target_review_note, ''))) < 10
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_ONBOARDING_DECISION';
  end if;
  select * into submission_row
  from public.organization_onboarding_submissions
  where id = target_submission_id
    and status = 'SUBMITTED'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMITTED_ONBOARDING_NOT_FOUND';
  end if;
  select * into organization_row
  from public.organizations
  where id = submission_row.organization_id
    and status = 'UNDER_REVIEW'
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'TENANT_NOT_UNDER_REVIEW';
  end if;
  next_tenant_status := case target_decision
    when 'APPROVE' then 'ACTIVE'::public.tenant_status
    when 'REQUEST_CHANGES' then 'CHANGES_REQUIRED'::public.tenant_status
    else 'REJECTED'::public.tenant_status
  end;
  next_submission_status := case target_decision
    when 'APPROVE' then 'APPROVED'
    when 'REQUEST_CHANGES' then 'CHANGES_REQUIRED'
    else 'REJECTED'
  end;
  update public.organization_onboarding_submissions
  set status = next_submission_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = nullif(btrim(coalesce(target_review_note, '')), '')
  where id = submission_row.id;
  update public.organizations
  set status = next_tenant_status, updated_at = now()
  where id = organization_row.id;
  insert into public.tenant_status_history (
    organization_id, from_status, to_status, changed_by, reason
  ) values (
    organization_row.id, 'UNDER_REVIEW', next_tenant_status, auth.uid(),
    coalesce(nullif(btrim(coalesce(target_review_note, '')), ''), 'Onboarding approved')
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    organization_row.id, auth.uid(),
    case target_decision
      when 'APPROVE' then 'tenant.onboarding_approved'
      when 'REQUEST_CHANGES' then 'tenant.onboarding_changes_requested'
      else 'tenant.onboarding_rejected'
    end,
    'organization_onboarding_submission', submission_row.id::text,
    target_request_id, jsonb_build_object('decision', target_decision)
  );
  return jsonb_build_object(
    'submission_id', submission_row.id,
    'organization_id', organization_row.id,
    'status', next_tenant_status
  );
end;
$$;

revoke all on function public.get_tenant_onboarding_context() from public, anon;
grant execute on function public.get_tenant_onboarding_context() to authenticated;
revoke all on function public.submit_tenant_onboarding(text, text, text, jsonb, jsonb, uuid)
from public, anon;
grant execute on function public.submit_tenant_onboarding(text, text, text, jsonb, jsonb, uuid)
to authenticated;
revoke all on function public.review_tenant_onboarding(uuid, text, text, uuid)
from public, anon;
grant execute on function public.review_tenant_onboarding(uuid, text, text, uuid)
to authenticated;

commit;
