begin;

-- 202609060016 created six operations executives. Five mirror their manager's
-- module rights; the Customer Relationship Executive was given a navigation
-- menu and an empty preset, so every page in that menu was unreachable. The
-- customer-care RPCs require `customer_care.view` and the follow-up workspace
-- requires `followup.view`, and the role held neither -- only `customer.view`,
-- the document pair and `email.send`.
--
-- It now mirrors `customer_relationship_manager` the way the other five mirror
-- theirs: the same customer-care and follow-up rights, and still no
-- `report.export`, which the report trigger grants to managers only. New
-- tenants pick this up without further change, because the provisioning
-- trigger added by 202609060016 reads the preset function replaced here.

alter table public.role_permissions disable trigger enforce_role_permission_write_security;

create or replace function app_private.operations_executive_permissions(target_role_key text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case target_role_key
    when 'finance_executive' then array['finance.view', 'finance.manage']
    when 'insurance_executive' then array['insurance.view', 'insurance.manage']
    when 'rto_executive' then array['rto.view', 'rto.manage']
    when 'exchange_executive'
      then array['exchange.view', 'exchange.request', 'exchange.manage']
    when 'delivery_executive' then array['delivery.view', 'delivery.manage']
    when 'customer_relationship_executive'
      then array[
        'customer_care.view', 'customer_care.manage', 'customer_care.escalate',
        'followup.view', 'followup.create', 'followup.update',
        'followup.complete', 'followup.cancel'
      ]
    else array[]::text[]
  end || array['customer.view', 'document.upload', 'document.download', 'email.send']
$$;

-- The same delete-then-insert whitelist as 202609060016, scoped to the single
-- role whose preset changed so the other five keep exactly what they hold.
delete from public.role_permissions role_permission_row
using public.roles role_row, public.permissions permission_row
where role_permission_row.role_id = role_row.id
  and role_permission_row.permission_id = permission_row.id
  and role_row.role_key = 'customer_relationship_executive'
  -- report.view is granted by the report trigger and is intentionally kept.
  and permission_row.permission_key <> 'report.view'
  and not (
    permission_row.permission_key = any(
      app_private.operations_executive_permissions(role_row.role_key)
    )
  );

insert into public.role_permissions (role_id, permission_id)
select role_row.id, permission_row.id
from public.roles role_row
cross join public.permissions permission_row
where role_row.organization_id is not null
  and role_row.role_key = 'customer_relationship_executive'
  and permission_row.permission_key = any(
    app_private.operations_executive_permissions(role_row.role_key)
  )
on conflict do nothing;

alter table public.role_permissions enable trigger enforce_role_permission_write_security;

commit;
