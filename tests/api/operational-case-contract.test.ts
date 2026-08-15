import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150027_operational_case_workspace.sql');
const workspace = source('src/features/operations/operational-case-workspace.tsx');
const dialogs = source('src/features/operations/operational-case-dialogs.tsx');
const api = source('src/features/operations/operational-case-api.ts');
const roleRoute = source('src/app/[role]/[[...slug]]/page.tsx');
const topics = source('src/lib/realtime/topics.ts');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('operational case permission and tenant boundary', () => {
  it('keeps department visibility separate from mutation authority', () => {
    for (const department of ['finance', 'insurance', 'rto', 'exchange', 'delivery']) {
      expect(migration).toContain(`('${department}.view', '${department}'`);
      expect(migration).toContain(`('${department}.manage', '${department}'`);
    }
    expect(migration).toContain("('exchange.request', 'exchange'");
    expect(migration).toContain('roles_apply_default_operational_case_permissions');
    expect(migration).toContain("role_row.role_key = 'sales_consultant'");
  });

  it('retains separate department tables and makes tenant identity part of every reference', () => {
    for (const table of [
      'finance_cases',
      'insurance_cases',
      'rto_cases',
      'exchange_cases',
      'delivery_cases',
    ]) {
      expect(migration).toContain(`alter table public.${table}`);
      expect(migration).toContain(`create unique index if not exists ${table}_org_id_unique_idx`);
      expect(migration).toContain(`constraint ${table}_branch_org_fk`);
      expect(migration).toContain(`constraint ${table}_customer_org_fk`);
      expect(migration).toContain(`validate constraint ${table}_branch_org_fk`);
    }
    expect(migration).toContain('delivery_cases_signature_org_fk');
    expect(migration).toContain('exchange_evaluations_case_org_fk');
    expect(migration).toContain('delivery_checklist_case_org_fk');
  });

  it('revokes direct mutations and exposes permission/scope-filtered reads', () => {
    for (const table of [
      'finance_cases',
      'insurance_cases',
      'rto_cases',
      'exchange_cases',
      'delivery_cases',
    ]) {
      expect(migration).toContain(
        `revoke insert, update, delete, truncate on public.${table} from anon, authenticated`,
      );
      expect(migration).toContain(`create policy ${table}_read`);
    }
    expect(migration).toContain('app_private.operational_case_permission');
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('app_private.can_access_customer');
  });
});

describe('operational case server query boundary', () => {
  const page = section(
    'create or replace function public.get_operational_case_workspace_page(',
    'create or replace function public.get_operational_case_booking_options(',
  );
  const options = section(
    'create or replace function public.get_operational_case_booking_options(',
    'create or replace function public.create_operational_case(',
  );

  it('uses bounded server pagination, page-local search, allowlisted sorting and a KPI bundle', () => {
    expect(page).toContain('target_page_size is null or target_page_size not in (25, 50, 100)');
    expect(page).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
    expect(page).toContain(
      "target_sort not in ('updated:desc', 'updated:asc', 'due:asc', 'customer:asc', 'priority:desc')",
    );
    expect(page).toContain("'kpis', jsonb_build_object(");
    expect(page).toContain("'pending_documents'");
    expect(page).toContain("'completed_this_month'");
    expect(page).not.toMatch(
      /select\s+\*\s+from\s+public\.(finance|insurance|rto|exchange|delivery)_cases/i,
    );
  });

  it('bounds eligible booking options and validates all implied access', () => {
    expect(options).toContain('target_limit not between 1 and 25');
    expect(options).toContain('app_private.can_access_record');
    expect(options).toContain('app_private.can_access_customer');
    expect(options).toContain(
      "'CONFIRMED', 'AWAITING_ALLOCATION', 'ALLOCATED', 'READY_FOR_DELIVERY'",
    );
  });
});

describe('operational case atomic workflow boundary', () => {
  const create = section(
    'create or replace function public.create_operational_case(',
    'create or replace function public.update_operational_case(',
  );
  const update = section(
    'create or replace function public.update_operational_case(',
    'create or replace function public.get_operational_case_detail(',
  );
  const checklist = section(
    'create or replace function public.set_delivery_checklist_item(',
    'create or replace function app_private.realtime_topic_organization()',
  );

  it('makes create replay-safe, booking-derived, scoped and audited', () => {
    expect(create).toContain('target_request_id');
    expect(create).toContain('pg_advisory_xact_lock');
    expect(create).toContain('app_private.replay_operational_case_request');
    expect(create).toContain('from public.bookings source_row');
    expect(create).toContain('app_private.can_access_record');
    expect(create).toContain('app_private.can_access_customer');
    expect(create).toContain('insert into public.audit_logs');
    expect(create).toContain("'case.created.' || lower(normalized_department)");
  });

  it('serializes versioned updates and enforces transition-specific evidence', () => {
    expect(update).toContain('for update');
    expect(update).toContain('OPERATIONAL_CASE_VERSION_CONFLICT');
    expect(update).toContain('app_private.operational_case_transition_allowed');
    expect(update).toContain('OPERATIONAL_CASE_CHANGE_REASON_REQUIRED');
    expect(update).toContain('INVALID_FINANCE_CASE_DETAILS');
    expect(update).toContain('INVALID_INSURANCE_CASE_DETAILS');
    expect(update).toContain('INVALID_RTO_CASE_DETAILS');
    expect(update).toContain('INVALID_EXCHANGE_CASE_DETAILS');
    expect(update).toContain('FINANCE_CASE_DOCUMENT_REQUIRED');
    expect(update).toContain('INSURANCE_POLICY_DOCUMENT_REQUIRED');
    expect(update).toContain('RTO_CASE_DOCUMENT_REQUIRED');
    expect(update).toContain('DELIVERY_CHECKLIST_REQUIRED');
    expect(update).toContain('DELIVERY_EVIDENCE_REQUIRED');
    expect(update).toContain('DELIVERY_SIGNATURE_MISMATCH');
    expect(update).toContain('insert into public.activities');
    expect(update).toContain('insert into public.audit_logs');
  });

  it('keeps delivery checklist mutations optimistic, scoped, replay-safe and audited', () => {
    expect(checklist).toContain('DELIVERY_CHECKLIST_VERSION_CONFLICT');
    expect(checklist).toContain('for update');
    expect(checklist).toContain('pg_advisory_xact_lock');
    expect(checklist).toContain('app_private.replay_operational_case_request');
    expect(checklist).toContain('insert into public.audit_logs');
  });
});

describe('operational case UI, storage and realtime contract', () => {
  it('uses the approved server-state/table/component stack and no competing chart library', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
    expect(dialogs).toContain("from '@/components/ui/dialog'");
    expect(dialogs).toContain("from '@/components/ui/sheet'");
  });

  it('routes documents only through the existing private presign/finalize boundary', () => {
    expect(api).toContain(">('presign-upload'");
    expect(api).toContain(">('object-upload-finalize'");
    expect(api).toContain(">('presign-download'");
    expect(api).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(TIGRIS|SECRET|TOKEN|KEY)/);
  });

  it('subscribes to a tenant-private operations topic and routes before the fail-closed fallback', () => {
    expect(migration).toContain("when 'operations' then");
    expect(migration).toContain("broadcast_tenant_invalidation('operations')");
    expect(topics).toContain("'operations'");
    expect(workspace).toContain("resource: 'operations'");
    expect(roleRoute.indexOf('OperationalCaseWorkspace')).toBeLessThan(
      roleRoute.indexOf('ProductionDataUnavailable'),
    );
  });
});
