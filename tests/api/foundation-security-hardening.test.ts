import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '202608150001_foundation_security_hardening.sql'),
  'utf8',
);
const rolePresets = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '202608140009_role_presets.sql'),
  'utf8',
);
const providerMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '202608150002_provider_integrations.sql'),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('foundational database security hardening', () => {
  it('uses partial provider/idempotency indexes so null identifiers remain repeatable', () => {
    expect(migration).toContain('profiles_tenant_employee_unique_idx');
    expect(migration).toContain('where organization_id is not null and employee_id is not null');
    expect(migration).toContain('profiles_platform_employee_unique_idx');
    expect(migration).toContain('where organization_id is null and employee_id is not null');
    expect(migration).toContain('leads_provider_external_unique_idx');
    expect(migration).toContain('where connection_id is not null and external_lead_id is not null');
    expect(migration).toContain('calls_provider_external_unique_idx');
    expect(migration).toContain('where connection_id is not null and provider_call_id is not null');
    expect(migration).toContain('conversation_messages_provider_unique_idx');
    expect(migration).toContain('where provider_message_id is not null');
    expect(migration).toContain('bookings_quotation_unique_idx');
    expect(migration).toContain('where quotation_id is not null');
  });

  it('replays credit consumption without updating the immutable ledger', () => {
    const consumeCredits = section(
      'create or replace function public.consume_credits(',
      '-- Replace permissive FOR ALL policies',
    );
    expect(consumeCredits).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(consumeCredits).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(consumeCredits).toContain('select * into existing_entry');
    expect(consumeCredits).not.toContain('on conflict');
    expect(consumeCredits).not.toMatch(/update\s+public\.credit_ledger/i);
  });

  it('requires MFA for every privileged assignment, including platform access', () => {
    const requiresMfa = section(
      'create or replace function app_private.requires_mfa',
      'create or replace function app_private.mfa_policy_satisfied',
    );
    expect(requiresMfa).toContain('app_private.is_platform_admin()');
    expect(requiresMfa).toContain("'super_admin', 'business_owner', 'client_admin'");
    expect(requiresMfa).toContain("'system_administrator', 'gm_sales'");
    expect(requiresMfa).toContain('exists (');

    const accessContext = section(
      'create or replace function public.get_access_context()',
      '-- Only non-security profile fields may be self-edited',
    );
    expect(accessContext.indexOf("if aal <> 'aal2'")).toBeLessThan(
      accessContext.indexOf("'destination', 'CRM'"),
    );
  });

  it('allows platform tenant access only through an approved active support session', () => {
    const supportSession = section(
      'create or replace function app_private.has_active_approved_support_session',
      'create or replace function app_private.is_tenant_support_controller',
    );
    expect(supportSession).toContain("request_row.status = 'APPROVED'");
    expect(supportSession).toContain('request_row.approved_by = session_row.approver_id');
    expect(supportSession).toContain("approver_permission.permission_key = 'support.approve'");
    expect(supportSession).toContain('request_row.capability_scope = session_row.capability_scope');
    expect(supportSession).toContain('app_private.mfa_policy_satisfied(null)');
    expect(supportSession).toContain('session_row.requester_id = auth.uid()');
    expect(supportSession).toContain('session_row.starts_at <= now()');
    expect(supportSession).toContain('session_row.expires_at > now()');
    expect(supportSession).toContain('session_row.ended_at is null');
    expect(supportSession).toContain("organization_row.status = 'SUPPORT_MAINTENANCE'");
    expect(migration).toContain(
      'create or replace function app_private.support_session_allows_permission',
    );
    expect(migration).toContain(
      'app_private.support_session_allows_permission(target_organization_id, target_permission)',
    );
  });

  it('removes scope-only policies and defaults unmapped modules to deny', () => {
    expect(migration).toContain("'drop policy if exists tenant_record_scope on public.%I'");
    expect(migration).not.toContain("'create policy tenant_record_read_scope");
    expect(migration).toContain('data scope alone must never imply permission');
    expect(migration).toContain(
      'grant execute on function app_private.can_access_call(uuid, uuid) to authenticated',
    );
    expect(migration).toContain(
      'grant execute on function app_private.can_access_test_drive(uuid, uuid) to authenticated',
    );
    expect(migration).toContain('customer_contacts_read');
    expect(migration).toContain('email_messages_read');
    expect(migration).not.toMatch(/create policy\s+\w+\s+on\s+public\.\w+\s+for all/gi);
    expect(migration).toContain(
      'create policy block_authenticated_hard_delete on public.%I as restrictive for delete',
    );
    expect(migration).toContain(
      'revoke delete on all tables in schema public from anon, authenticated',
    );
  });

  it('uses command and permission-aware policies on the highest-risk tables', () => {
    for (const policy of [
      'profiles_update',
      'roles_insert',
      'roles_update',
      'role_permissions_insert',
      'role_assignments_insert',
      'role_assignments_update',
      'customers_insert',
    ]) {
      expect(migration).toContain(`create policy ${policy}`);
    }
    expect(migration).toContain(
      "app_private.has_permission(current_lead.organization_id, 'lead.update')",
    );
    expect(migration).toContain(
      "app_private.has_permission(new.organization_id, 'integration.manage')",
    );
    expect(migration).toContain('app_private.can_access_connection(organization_id, id)');
    expect(migration).toContain('CONNECTED_ACCOUNT_SERVER_FIELDS_IMMUTABLE');
    expect(migration).toContain('enforce_connected_account_write_security');
    expect(migration).not.toContain('create policy connected_accounts_insert');
    expect(migration).not.toContain('create policy connected_accounts_update');
    expect(migration).toContain('credit_ledger_read');
    expect(migration).toContain('audit_logs_read');
    expect(migration).toContain('branches_read');
    expect(migration).toContain('teams_read');
    expect(migration).toContain('team_members_read');
    expect(migration).toContain("'data.directory.view'");
    for (const policy of [
      'calls_read',
      'call_recordings_read',
      'conversations_read',
      'conversation_messages_read',
      'test_drive_route_points_read',
      'quotation_items_read',
      'booking_status_history_read',
      'reminders_read',
      'notifications_read',
    ]) {
      expect(migration).toContain(`create policy ${policy}`);
    }
    expect(migration).toContain("app_private.has_permission(target_organization_id, 'call.view')");
    expect(migration).toContain(
      "app_private.has_permission(target_organization_id, 'test_drive.manage')",
    );
    expect(migration).toContain('create or replace function public.create_lead(');
    expect(migration).toContain('CONTROLLED_LEAD_CREATE_REQUIRED');
    expect(migration).toContain('NO_ELIGIBLE_FRESH_ASSIGNEE');
    expect(migration).toContain("'Automatic fresh lead assignment'");
    expect(migration).toContain('create or replace function public.mark_notification_read(');
    expect(migration).not.toContain('create policy leads_insert');
    expect(migration).not.toContain('create policy leads_update');
    for (const role of ['sales_consultant', 'telecaller_bdc']) {
      const roleIndex = rolePresets.indexOf(`r.role_key = '${role}'`);
      expect(roleIndex).toBeGreaterThanOrEqual(0);
      expect(rolePresets.slice(roleIndex, roleIndex + 700)).toContain("'lead.create'");
    }
  });

  it('updates leads only through an audited, versioned domain RPC', () => {
    const updateLead = section(
      'create or replace function public.update_lead(',
      'create or replace function public.assign_lead(',
    );
    expect(updateLead).toContain('LEAD_VERSION_CONFLICT');
    expect(updateLead).toContain('LEAD_PATCH_FIELD_FORBIDDEN');
    expect(updateLead).toContain('for update');
    expect(updateLead).toContain('insert into public.lead_stage_history');
    expect(updateLead).toContain('insert into public.lead_temperature_history');
    expect(updateLead).toContain("'lead.updated'");
    expect(updateLead).toContain('previous_updated_at');
    expect(updateLead).toContain('CHANGE_REASON_REQUIRED');

    const patchAllowlist = updateLead.slice(
      updateLead.indexOf('where patch_key.key not in ('),
      updateLead.indexOf("message = 'LEAD_PATCH_FIELD_FORBIDDEN'"),
    );
    for (const immutableField of [
      "'organization_id'",
      "'branch_id'",
      "'team_id'",
      "'customer_id'",
      "'source'",
      "'connection_id'",
      "'external_lead_id'",
      "'assigned_user_id'",
    ]) {
      expect(patchAllowlist).not.toContain(immutableField);
    }
  });

  it('guards self-service profile fields and delegated role authority in triggers', () => {
    const profileGuard = section(
      'create or replace function app_private.validate_profile_update',
      'drop trigger if exists enforce_profile_update_security',
    );
    expect(profileGuard).toContain('PROFILE_SECURITY_FIELDS_IMMUTABLE');
    expect(profileGuard).toContain('new.mfa_required is distinct from old.mfa_required');
    expect(profileGuard).toContain('new.active is distinct from old.active');
    expect(profileGuard).toContain('USER_AUTHORITY_CEILING_EXCEEDED');

    expect(migration).toContain('ROLE_AUTHORITY_CEILING_EXCEEDED');
    expect(migration).toContain('PERMISSION_DELEGATION_CEILING_EXCEEDED');
    expect(migration).toContain('SYSTEM_ROLE_PERMISSIONS_IMMUTABLE');
    expect(migration).toContain('create or replace function public.revoke_role_permission(');
    expect(migration).toContain("'role.permission.revoked'");
    expect(migration).toContain('SELF_ASSIGNMENT_FORBIDDEN');
    expect(migration).toContain('BRANCH_SCOPE_CEILING_EXCEEDED');
    expect(migration).toContain('old.authority_level >= actor_authority');
    expect(migration).toContain('current_target_authority >= actor_authority');
  });

  it('enforces tenant consistency and one active lead assignment', () => {
    for (const constraint of [
      'leads_branch_org_fk',
      'leads_team_org_fk',
      'leads_customer_org_fk',
      'leads_assignee_org_fk',
      'leads_connection_org_fk',
      'lead_assignments_lead_org_fk',
      'lead_assignments_team_org_fk',
      'lead_assignments_assignee_org_fk',
      'teams_manager_org_fk',
      'integration_credentials_account_org_fk',
      'integration_branch_mappings_account_org_fk',
      'integration_branch_mappings_branch_org_fk',
      'integration_field_mappings_account_org_fk',
      'provider_events_account_org_fk',
      'sync_runs_account_org_fk',
      'calls_connection_org_fk',
      'conversations_connection_org_fk',
    ]) {
      expect(migration).toContain(`constraint ${constraint}`);
    }
    expect(providerMigration).toContain('constraint integration_oauth_states_account_org_fk');
    expect(providerMigration).toContain('enforce_integration_oauth_state_actor');
    expect(migration).toContain('actor_has_tenant_operation_context');
    expect(migration).toContain('enforce_connected_account_actor');
    expect(migration).toContain('enforce_integration_credential_actor');
    expect(migration).toContain("organization_row.status = 'SUPPORT_MAINTENANCE'");
    expect(providerMigration).toContain('foreign key (organization_id, branch_id, team_id)');
    expect(migration).toContain('lead_assignments_one_active_idx');
    expect(migration).toContain('LEAD_ASSIGNEE_NOT_IN_TEAM');
    expect(migration).toContain('ASSIGNMENT_RPC_REQUIRED');
    expect(migration).toContain('CUSTOMER_LINK_RPC_REQUIRED');
  });

  it('requires AAL2 on every authenticated platform plan mutation', () => {
    for (const policy of [
      'subscription_plans_insert',
      'subscription_plans_update',
      'plan_modules_insert',
      'plan_modules_update',
    ]) {
      const policyIndex = migration.indexOf(`create policy ${policy}`);
      expect(policyIndex).toBeGreaterThanOrEqual(0);
      expect(migration.slice(policyIndex, policyIndex + 420)).toContain(
        'app_private.mfa_policy_satisfied(null)',
      );
    }
  });

  it('validates and idempotently finalizes test-drive route data in PostgreSQL', () => {
    const routeFinalization = section(
      'create or replace function public.finalize_test_drive_route(',
      'create or replace function public.consume_credits(',
    );
    expect(routeFinalization).toContain("jsonb_typeof(route_points) <> 'array'");
    expect(routeFinalization).toContain('TOO_MANY_ROUTE_POINTS');
    expect(routeFinalization).toContain('ENCODED_POLYLINE_TOO_LONG');
    expect(routeFinalization).toContain('INVALID_ROUTE_SEQUENCE');
    expect(routeFinalization).toContain('INVALID_ROUTE_COORDINATES');
    expect(routeFinalization).toContain('INVALID_ROUTE_TIMESTAMP');
    expect(routeFinalization).toContain('pg_catalog.sha256(');
    expect(routeFinalization).toContain('pg_catalog.convert_to(');
    expect(routeFinalization).toContain('stored_points_match');
    expect(routeFinalization).toContain('return existing_summary.id');
    expect(routeFinalization).toContain('ROUTE_ALREADY_FINALIZED');

    const anchorFinalization = section(
      'create or replace function public.record_test_drive_anchor(',
      'create or replace function public.finalize_test_drive_route(',
    );
    expect(anchorFinalization).toContain("if drive.status = 'COMPLETED' then");
    expect(anchorFinalization).toContain('END_ALREADY_RECORDED');
    expect(anchorFinalization).toContain('REACHED_ALREADY_RECORDED');
    expect(anchorFinalization).toContain('return drive');
  });
});
