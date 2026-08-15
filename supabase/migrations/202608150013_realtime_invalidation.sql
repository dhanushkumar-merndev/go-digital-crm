begin;

-- Realtime broadcasts carry invalidation metadata only. Clients refetch through
-- normal RLS-protected queries, so no CRM row or secret-bearing payload is copied
-- into realtime.messages.
create or replace function app_private.broadcast_tenant_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare row_data jsonb;
declare target_organization_id uuid;
declare target_record_id text;
declare target_topic text;
declare ignored jsonb;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  row_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if coalesce(row_data->>'organization_id', '')
    !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  then
    return null;
  end if;
  target_organization_id := (row_data->>'organization_id')::uuid;
  target_record_id := coalesce(
    row_data->>'id',
    row_data->>'connected_account_id',
    row_data->>'user_id',
    'changed'
  );
  target_topic := 'organization:' || target_organization_id::text || ':' || tg_argv[0];
  execute 'select realtime.send($1, $2, $3, true)'
    into ignored
    using jsonb_build_object(
      'resource', tg_argv[0],
      'operation', tg_op,
      'record_id', target_record_id
    ), lower(tg_op), target_topic;
  return null;
end;
$$;

create or replace function app_private.broadcast_platform_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare row_data jsonb;
declare target_record_id text;
declare ignored jsonb;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  row_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  target_record_id := coalesce(row_data->>'id', 'changed');
  execute 'select realtime.send($1, $2, $3, true)'
    into ignored
    using jsonb_build_object(
      'resource', tg_argv[0],
      'operation', tg_op,
      'record_id', target_record_id
    ), lower(tg_op), 'platform:' || tg_argv[0];
  return null;
end;
$$;

create or replace function app_private.realtime_topic_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_topic text;
declare topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(
    current_topic,
    '^organization:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):(leads|customers|communications|work|notifications|integrations|support)$'
  );
  return case when topic_match is null then null else topic_match[1]::uuid end;
exception when others then
  return null;
end;
$$;

create or replace function app_private.realtime_topic_resource()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_topic text;
declare topic_match text[];
begin
  if to_regprocedure('realtime.topic()') is null then return null; end if;
  execute 'select realtime.topic()' into current_topic;
  topic_match := regexp_match(
    current_topic,
    '^organization:[0-9a-fA-F-]{36}:(leads|customers|communications|work|notifications|integrations|support)$'
  );
  return case when topic_match is null then null else topic_match[1] end;
exception when others then
  return null;
end;
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists crm_tenant_broadcast_read on realtime.messages';
    execute $policy$
      create policy crm_tenant_broadcast_read on realtime.messages
      for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and app_private.can_access_organization(app_private.realtime_topic_organization())
        and case app_private.realtime_topic_resource()
          when 'leads' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'lead.view'
          )
          when 'customers' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'customer.view'
          )
          when 'communications' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'message.view')
            or app_private.has_permission(app_private.realtime_topic_organization(), 'call.view')
          when 'work' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'lead.view')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'test_drive.manage'
            )
          when 'notifications' then true
          when 'integrations' then app_private.has_permission(
            app_private.realtime_topic_organization(), 'integration.view'
          )
          when 'support' then
            app_private.has_permission(app_private.realtime_topic_organization(), 'support.request')
            or app_private.has_permission(
              app_private.realtime_topic_organization(), 'support.approve'
            )
          else false
        end
      )
    $policy$;
    execute 'drop policy if exists crm_platform_broadcast_read on realtime.messages';
    execute $policy$
      create policy crm_platform_broadcast_read on realtime.messages
      for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and realtime.topic() ~ '^platform:(dealerships|onboarding|support|health|retention|integrations)$'
        and app_private.is_platform_admin()
        and app_private.mfa_policy_satisfied(null)
      )
    $policy$;
  end if;
end $$;

drop trigger if exists realtime_leads_invalidate on public.leads;
create trigger realtime_leads_invalidate after insert or update on public.leads
for each row execute function app_private.broadcast_tenant_invalidation('leads');
drop trigger if exists realtime_customers_invalidate on public.customers;
create trigger realtime_customers_invalidate after insert or update on public.customers
for each row execute function app_private.broadcast_tenant_invalidation('customers');
drop trigger if exists realtime_followups_invalidate on public.followups;
create trigger realtime_followups_invalidate after insert or update on public.followups
for each row execute function app_private.broadcast_tenant_invalidation('work');
drop trigger if exists realtime_appointments_invalidate on public.appointments;
create trigger realtime_appointments_invalidate after insert or update on public.appointments
for each row execute function app_private.broadcast_tenant_invalidation('work');
drop trigger if exists realtime_test_drives_invalidate on public.test_drives;
create trigger realtime_test_drives_invalidate after insert or update on public.test_drives
for each row execute function app_private.broadcast_tenant_invalidation('work');
drop trigger if exists realtime_calls_invalidate on public.calls;
create trigger realtime_calls_invalidate after insert or update on public.calls
for each row execute function app_private.broadcast_tenant_invalidation('communications');
drop trigger if exists realtime_conversations_invalidate on public.conversations;
create trigger realtime_conversations_invalidate after insert or update on public.conversations
for each row execute function app_private.broadcast_tenant_invalidation('communications');
drop trigger if exists realtime_conversation_messages_invalidate on public.conversation_messages;
create trigger realtime_conversation_messages_invalidate after insert or update on public.conversation_messages
for each row execute function app_private.broadcast_tenant_invalidation('communications');
drop trigger if exists realtime_notifications_invalidate on public.notifications;
create trigger realtime_notifications_invalidate after insert or update on public.notifications
for each row execute function app_private.broadcast_tenant_invalidation('notifications');
drop trigger if exists realtime_connections_invalidate on public.connected_accounts;
create trigger realtime_connections_invalidate after insert or update on public.connected_accounts
for each row execute function app_private.broadcast_tenant_invalidation('integrations');
drop trigger if exists realtime_connections_platform_invalidate on public.connected_accounts;
create trigger realtime_connections_platform_invalidate
after insert or update on public.connected_accounts
for each row execute function app_private.broadcast_platform_invalidation('integrations');
drop trigger if exists realtime_support_requests_invalidate on public.support_access_requests;
create trigger realtime_support_requests_invalidate after insert or update on public.support_access_requests
for each row execute function app_private.broadcast_tenant_invalidation('support');
drop trigger if exists realtime_support_sessions_invalidate on public.support_sessions;
create trigger realtime_support_sessions_invalidate after insert or update on public.support_sessions
for each row execute function app_private.broadcast_tenant_invalidation('support');

drop trigger if exists realtime_organizations_platform_invalidate on public.organizations;
create trigger realtime_organizations_platform_invalidate after insert or update on public.organizations
for each row execute function app_private.broadcast_platform_invalidation('dealerships');
drop trigger if exists realtime_onboarding_platform_invalidate
on public.organization_onboarding_submissions;
create trigger realtime_onboarding_platform_invalidate
after insert or update on public.organization_onboarding_submissions
for each row execute function app_private.broadcast_platform_invalidation('onboarding');
drop trigger if exists realtime_support_requests_platform_invalidate
on public.support_access_requests;
create trigger realtime_support_requests_platform_invalidate
after insert or update on public.support_access_requests
for each row execute function app_private.broadcast_platform_invalidation('support');
drop trigger if exists realtime_support_sessions_platform_invalidate on public.support_sessions;
create trigger realtime_support_sessions_platform_invalidate
after insert or update on public.support_sessions
for each row execute function app_private.broadcast_platform_invalidation('support');

revoke all on function app_private.broadcast_tenant_invalidation()
from public, anon, authenticated;
revoke all on function app_private.broadcast_platform_invalidation()
from public, anon, authenticated;
revoke all on function app_private.realtime_topic_organization()
from public, anon, authenticated;
revoke all on function app_private.realtime_topic_resource()
from public, anon, authenticated;

commit;
