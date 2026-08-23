begin;

-- Later marketing/report RPCs and the controlled-retention contract already
-- treat quotations as soft-deletable, but the base table omitted the column.
-- A nullable column is metadata-only on PostgreSQL and repairs those runtime
-- paths before the Sales Consultant partial indexes are built.
alter table public.quotations
  add column if not exists deleted_at timestamptz;

create or replace function app_private.can_access_quotation(
  target_organization_id uuid,
  target_quotation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quotations quotation_row
    where quotation_row.id = target_quotation_id
      and quotation_row.organization_id = target_organization_id
      and quotation_row.deleted_at is null
      and (
        app_private.has_permission(target_organization_id, 'quotation.view')
        or app_private.has_permission(target_organization_id, 'quotation.manage')
      )
      and app_private.can_access_record(
        quotation_row.organization_id,
        quotation_row.branch_id,
        quotation_row.team_id,
        quotation_row.assigned_user_id
      )
  );
$$;

commit;
