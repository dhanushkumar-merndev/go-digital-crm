-- Templates could be drafted and archived but never approved, so
-- `templates.status = 'APPROVED'` was unreachable through the application. That
-- made the gate in send-email (which requires an APPROVED row carrying the
-- provider's own template id) impossible to satisfy: transactional email could
-- not be delivered by any tenant. The same gate is what drip and bulk sending
-- will depend on, because both send outside WhatsApp's 24h service window where
-- only a pre-approved template may be used.

-- send-email resolves a template with `.maybeSingle()` on
-- (organization_id, channel, provider_template_id). Two approved rows sharing a
-- provider id would turn every send into a runtime error rather than a wrong
-- send, so uniqueness is enforced here rather than trusted to the caller.
create unique index if not exists templates_approved_provider_id_idx
  on public.templates (organization_id, upper(channel), provider_template_id)
  where deleted_at is null and upper(status) = 'APPROVED' and provider_template_id is not null;

-- RLS is enabled with no policy, which already denies direct access. The explicit
-- revoke matches how every other tenant table in this schema is written and keeps
-- the intent legible if a policy is ever added.
revoke insert, update, delete, truncate on public.templates from anon, authenticated;

-- Approval records a decision the provider already made. Meta and Brevo approve
-- templates in their own consoles on their own timelines, so the CRM stores the
-- resulting provider id rather than pretending to own the approval itself.
create or replace function public.approve_template(
  target_template_id uuid,
  target_provider_template_id text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  template_row public.templates%rowtype;
  normalized_provider_id text := btrim(coalesce(target_provider_template_id, ''));
  normalized_channel text;
  result jsonb;
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_template_id is null or target_request_id is null
    or char_length(normalized_provider_id) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_APPROVAL_INPUT';
  end if;

  select * into template_row
  from public.templates
  where id = target_template_id
    and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'TEMPLATE_NOT_FOUND';
  end if;

  normalized_channel := upper(btrim(coalesce(template_row.channel, '')));

  -- send-email casts the provider id back through `z.int().positive()`, so a
  -- non-numeric Brevo id would be stored here and then never match at send time.
  -- Rejecting it now turns a silent dead template into an immediate error.
  if normalized_channel = 'EMAIL' and normalized_provider_id !~ '^[0-9]{1,18}$' then
    raise exception using errcode = '22023', message = 'INVALID_BREVO_TEMPLATE_ID';
  end if;
  -- Meta names approved WhatsApp templates in lowercase snake case. Length is
  -- already bounded above; POSIX regex caps a repetition count at 255, so the
  -- quantifier here stays unbounded rather than restating the 512 limit.
  if normalized_channel in ('WHATSAPP', 'WHATSAPP_BUSINESS')
    and normalized_provider_id !~ '^[a-z0-9_]+$' then
    raise exception using errcode = '22023', message = 'INVALID_WHATSAPP_TEMPLATE_NAME';
  end if;

  -- Approving twice with the same provider id is the natural retry and must not
  -- fail; approving twice with a different id is a conflicting decision.
  if upper(template_row.status) = 'APPROVED' then
    if template_row.provider_template_id is distinct from normalized_provider_id then
      raise exception using errcode = '22023', message = 'TEMPLATE_ALREADY_APPROVED';
    end if;
    return jsonb_build_object(
      'id', template_row.id, 'status', 'APPROVED',
      'provider_template_id', normalized_provider_id, 'replayed', true
    );
  end if;
  if upper(template_row.status) not in ('DRAFT', 'REJECTED') then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_APPROVABLE';
  end if;

  update public.templates
  set status = 'APPROVED', provider_template_id = normalized_provider_id, updated_at = now()
  where id = template_row.id and organization_id = current_organization_id;

  result := jsonb_build_object(
    'id', template_row.id, 'status', 'APPROVED',
    'provider_template_id', normalized_provider_id, 'replayed', false
  );
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'template.approved', 'template',
    template_row.id::text, target_request_id,
    jsonb_build_object('channel', normalized_channel, 'result', result)
  );
  return result;
exception
  when unique_violation then
    raise exception using errcode = '22023', message = 'TEMPLATE_PROVIDER_ID_IN_USE';
end;
$$;

-- The workspace already filters on REJECTED, but nothing could set it. Without
-- this an admin's only way to retire a bad template is to archive it, which also
-- hides it from the queue that says what still needs attention.
create or replace function public.reject_template(
  target_template_id uuid,
  target_reason text,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  template_row public.templates%rowtype;
  normalized_reason text := left(btrim(coalesce(target_reason, '')), 500);
begin
  current_organization_id := app_private.current_tenant_organization();
  if auth.uid() is null or current_organization_id is null
    or not app_private.has_permission(current_organization_id, 'integration.manage') then
    raise exception using errcode = '42501', message = 'TEMPLATE_MANAGE_PERMISSION_REQUIRED';
  end if;
  if target_template_id is null or target_request_id is null
    or char_length(normalized_reason) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_TEMPLATE_REJECTION_INPUT';
  end if;

  select * into template_row
  from public.templates
  where id = target_template_id
    and organization_id = current_organization_id
    and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'TEMPLATE_NOT_FOUND';
  end if;
  if upper(template_row.status) = 'ARCHIVED' then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_REJECTABLE';
  end if;

  -- Clearing the provider id keeps the partial unique index free for a
  -- replacement template that will carry the same approved provider id.
  update public.templates
  set status = 'REJECTED', provider_template_id = null, updated_at = now()
  where id = template_row.id and organization_id = current_organization_id;

  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, request_id, metadata
  ) values (
    current_organization_id, auth.uid(), 'template.rejected', 'template',
    template_row.id::text, target_request_id,
    jsonb_build_object('reason', normalized_reason)
  );
  return jsonb_build_object('id', template_row.id, 'status', 'REJECTED');
end;
$$;

revoke all on function public.approve_template(uuid, text, uuid) from public, anon;
grant execute on function public.approve_template(uuid, text, uuid) to authenticated;
revoke all on function public.reject_template(uuid, text, uuid) from public, anon;
grant execute on function public.reject_template(uuid, text, uuid) to authenticated;
