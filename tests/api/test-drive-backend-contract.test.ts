import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150025_test_drive_workspace.sql');
const hardeningMigration = source(
  'supabase/migrations/202608150001_foundation_security_hardening.sql',
);
const anchorEdge = source('supabase/functions/test-drive-anchor/index.ts');
const completeEdge = source('supabase/functions/test-drive-complete/index.ts');
const config = source('supabase/config.toml');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('test-drive permission, tenancy and write boundary', () => {
  it('separates scoped viewing from lifecycle mutation and keeps frozen presets explicit', () => {
    expect(migration).toContain("('test_drive.view', 'test-drives'");
    expect(migration).toContain("('test_drive.manage', 'test-drives'");
    expect(migration).toContain(
      "'business_owner', 'client_admin', 'system_administrator', 'gm_sales'",
    );
    expect(migration).toContain("'showroom_manager', 'team_manager', 'sales_consultant'");
    expect(migration).toContain('roles_apply_default_test_drive_permissions');
  });

  it('enforces composite tenant references and validates the migrated constraints', () => {
    for (const constraint of [
      'test_drive_appointments_branch_org_fk',
      'test_drive_appointments_team_org_fk',
      'test_drive_appointments_customer_org_fk',
      'test_drive_appointments_lead_org_fk',
      'test_drive_appointments_assignee_org_fk',
      'test_drive_appointments_stock_org_fk',
      'test_drives_appointment_org_fk',
      'test_drives_customer_org_fk',
      'test_drives_lead_org_fk',
      'test_drive_route_summaries_drive_org_fk',
      'test_drive_route_points_drive_org_fk',
      'test_drive_feedback_drive_org_fk',
    ]) {
      expect(migration).toContain(`constraint ${constraint}`);
      expect(migration).toContain(`validate constraint ${constraint}`);
    }
    expect(migration).toContain('TEST_DRIVE_APPOINTMENT_SCOPE_MISMATCH');
    expect(migration).toContain('TEST_DRIVE_STOCK_SCOPE_MISMATCH');
  });

  it('keeps direct tenant writes closed and exposes only scoped reads plus audited RPCs', () => {
    for (const table of [
      'test_drive_appointments',
      'test_drives',
      'test_drive_feedback',
      'test_drive_route_summaries',
      'test_drive_route_points',
      'live_tracking_sessions',
    ]) {
      expect(migration).toContain(
        `revoke insert, update, delete, truncate on public.${table} from anon, authenticated`,
      );
    }
    expect(migration).toContain('create policy test_drive_appointments_read');
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('app_private.can_access_customer');
    expect(migration).toContain('app_private.can_access_lead');
  });
});

describe('test-drive list and selector boundary', () => {
  const page = section(
    'create or replace function public.get_test_drive_workspace_page(',
    'create or replace function public.get_test_drive_lead_options(',
  );
  const leads = section(
    'create or replace function public.get_test_drive_lead_options(',
    'create or replace function public.get_test_drive_vehicle_options(',
  );
  const vehicles = section(
    'create or replace function public.get_test_drive_vehicle_options(',
    'create or replace function public.create_test_drive(',
  );

  it('uses bounded server paging, stable sorting, page-local search and one KPI bundle', () => {
    expect(page).toContain('target_page_size is null or target_page_size not in (25, 50, 100)');
    expect(page).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
    expect(page).toContain(
      "target_sort not in ('scheduled:asc', 'scheduled:desc', 'updated:desc', 'customer:asc')",
    );
    expect(page).toContain("'kpis', jsonb_build_object(");
    expect(page).toContain("'overdue'");
    expect(page).toContain("'completed_this_month'");
    expect(page).not.toMatch(/select\s+\*\s+from\s+public\.test_drive/i);
  });

  it('does not leak quotation conversion evidence without quotation permission and scope', () => {
    expect(page).toContain("has_permission(drive_row.organization_id, 'quotation.view')");
    expect(page).toContain("has_permission(drive_row.organization_id, 'quotation.manage')");
    expect(page).toContain('quotation_row.lead_id = drive_row.lead_id');
    expect(page).toContain('app_private.can_access_record(');
    expect(page).toContain('end as quotation_status');
  });

  it('bounds lead/vehicle options and requires every permission implied by scheduling', () => {
    expect(leads).toContain('target_limit not between 1 and 25');
    expect(leads).toContain("has_permission(current_organization_id, 'lead.view')");
    expect(leads).toContain("has_permission(current_organization_id, 'lead.update')");
    expect(leads).toContain('app_private.can_access_customer');
    expect(vehicles).toContain('target_limit not between 1 and 25');
    expect(vehicles).toContain("stock_row.status = 'AVAILABLE'");
    expect(vehicles).toContain('app_private.can_access_branch');
  });
});

describe('test-drive lifecycle and concurrency boundary', () => {
  const create = section(
    'create or replace function public.create_test_drive(',
    'create or replace function public.cancel_test_drive(',
  );
  const cancel = section(
    'create or replace function public.cancel_test_drive(',
    'create or replace function public.record_test_drive_anchor_v2(',
  );
  const anchor = section(
    'create or replace function public.record_test_drive_anchor_v2(',
    'create or replace function public.finalize_test_drive_route_v2(',
  );
  const finalize = section(
    'create or replace function public.finalize_test_drive_route_v2(',
    'create or replace function public.save_test_drive_feedback(',
  );
  const feedback = section(
    'create or replace function public.save_test_drive_feedback(',
    '-- Existing authenticated clients must use the versioned boundaries above.',
  );

  it('requires lead-update authority before scheduling changes the lead lifecycle', () => {
    expect(create).toContain("has_permission(current_organization_id, 'test_drive.manage')");
    expect(create).toContain("has_permission(current_organization_id, 'customer.view')");
    expect(create).toContain("has_permission(current_organization_id, 'lead.view')");
    expect(create).toContain("has_permission(current_organization_id, 'lead.update')");
    expect(create).toContain('insert into public.lead_stage_history');
    expect(create).toContain("set lifecycle_status = 'Appointment Scheduled'");
  });

  it('serializes idempotent scheduling and rejects vehicle/consultant overlaps', () => {
    expect(create.match(/pg_advisory_xact_lock/g)?.length).toBeGreaterThanOrEqual(3);
    expect(create).toContain('app_private.replay_test_drive_request');
    expect(create).toContain('TEST_DRIVE_VEHICLE_SCHEDULE_CONFLICT');
    expect(create).toContain('TEST_DRIVE_CONSULTANT_SCHEDULE_CONFLICT');
    expect(create).toContain("source_row.status = 'AVAILABLE'");
    expect(create).toContain('insert into public.audit_logs');
  });

  it('makes cancellation, anchors, route finalization and feedback optimistic and replay-safe', () => {
    for (const mutation of [cancel, anchor, finalize, feedback]) {
      expect(mutation).toContain('target_request_id');
      expect(mutation).toContain('app_private.replay_test_drive_request');
      expect(mutation).toContain('pg_advisory_xact_lock');
      expect(mutation).toContain('TEST_DRIVE_VERSION_CONFLICT');
      expect(mutation).toContain('insert into public.audit_logs');
    }
  });

  it('restricts driving evidence to the assignee and enforces recoverable ordering', () => {
    for (const mutation of [anchor, finalize, feedback]) {
      expect(mutation).toContain('drive_row.assigned_user_id <> auth.uid()');
      expect(mutation).toContain('TEST_DRIVE_ASSIGNEE_REQUIRED');
    }
    expect(anchor).toContain('TEST_DRIVE_VEHICLE_UNAVAILABLE');
    expect(anchor).toContain('TEST_DRIVE_CONSULTANT_ALREADY_ACTIVE');
    expect(finalize).toContain("drive_row.status <> 'COMPLETED'");
    expect(feedback).toContain('drive_row.route_finalized_at is null');
  });

  it('validates the route payload inside SQL rather than trusting Edge validation', () => {
    expect(finalize).toContain('jsonb_array_length(route_points) > 2000');
    expect(finalize).toContain('octet_length(route_points::text) > 2000000');
    expect(finalize).toContain('char_length(encoded_polyline) > 100000');
    expect(finalize).toContain('public.finalize_test_drive_route(');
    expect(hardeningMigration).toContain('INVALID_ROUTE_POINT');
    expect(hardeningMigration).toContain('INVALID_ROUTE_SEQUENCE');
    expect(hardeningMigration).toContain('INVALID_ROUTE_COORDINATES');
    expect(hardeningMigration).toContain('INVALID_ROUTE_TIMESTAMP');
  });
});

describe('test-drive inventory and Edge integration boundary', () => {
  it('prevents stock mutation/allocation races for scheduled and active drives', () => {
    expect(migration).toContain('app_private.protect_test_drive_stock()');
    expect(migration).toContain('TEST_DRIVE_PREVENTS_STOCK_CHANGE');
    expect(migration).toContain('stock_units_protect_test_drive');
    expect(migration).toContain('app_private.protect_test_drive_stock_allocation()');
    expect(migration).toContain('TEST_DRIVE_PREVENTS_STOCK_ALLOCATION');
    expect(migration).toContain('stock_allocations_protect_test_drive');
  });

  it('retires the unversioned authenticated RPCs and keeps the Edge functions JWT-protected', () => {
    expect(migration).toContain('revoke all on function public.record_test_drive_anchor(');
    expect(migration).toContain(
      'revoke all on function public.finalize_test_drive_route(uuid, jsonb, text) from authenticated',
    );
    expect(migration).toContain('grant execute on function public.record_test_drive_anchor_v2(');
    expect(migration).toContain('grant execute on function public.finalize_test_drive_route_v2(');
    expect(anchorEdge).toContain("rpc('record_test_drive_anchor_v2'");
    expect(completeEdge).toContain("rpc('finalize_test_drive_route_v2'");
    expect(anchorEdge).toContain('expected_version');
    expect(anchorEdge).toContain('request_id');
    expect(completeEdge).toContain('expected_version');
    expect(completeEdge).toContain('request_id');
    expect(config).toMatch(/\[functions\.test-drive-anchor\][\s\S]*?verify_jwt = true/);
    expect(config).toMatch(/\[functions\.test-drive-complete\][\s\S]*?verify_jwt = true/);
  });

  it('invalidates the scoped work topic when drive evidence changes', () => {
    expect(
      migration.match(/broadcast_tenant_invalidation\('work'\)/g)?.length,
    ).toBeGreaterThanOrEqual(4);
  });
});
