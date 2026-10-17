-- Loaded after public-feedback-base.sql and 202609070202: the extra tables and
-- triggers 202610142271 touches, reduced to the columns it reads and writes.
alter table branches add column version integer not null default 1;

-- Production bumps branches.version in a_branches_bump_administration_version.
create function app_private.bump_branch_version() returns trigger language plpgsql as $$
begin new.version := old.version + 1; return new; end $$;
create trigger a_branches_bump_version before update on branches
  for each row execute function app_private.bump_branch_version();

-- Stand-in for validate_branch_administration_row: a legacy row that fails its
-- validation raises 23514 on any update.
create function app_private.validate_branch_row() returns trigger language plpgsql as $$
begin
  if new.name = 'Legacy invalid' then
    raise exception using errcode = '23514', message = 'INVALID_BRANCH_CONFIGURATION';
  end if;
  return new;
end $$;
create trigger branches_validate before update on branches
  for each row execute function app_private.validate_branch_row();

create table object_files(
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid,
  resource_type text not null, resource_id uuid not null, bucket text not null,
  object_key text not null, mime_type text not null, size_bytes bigint not null,
  checksum text not null default 'x', uploaded_by uuid, deleted_at timestamptz
);
create table integration_branch_mappings(
  organization_id uuid not null, connected_account_id uuid not null, branch_id uuid not null,
  external_resource_type text not null, external_resource_id text not null,
  external_resource_label text, mapping_metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz
);
