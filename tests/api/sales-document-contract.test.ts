import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/202608150024_quotation_booking_workspace.sql');
const workspace = source('src/features/sales/sales-document-workspace.tsx');
const dialogs = source('src/features/sales/sales-document-dialogs.tsx');
const quotationCreate = source('src/features/sales/quotation-create-view.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');
const customerMigration = source('supabase/migrations/202608150011_customer_workspace.sql');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('quotation and booking read boundary', () => {
  it('adds explicit read permissions while preserving manage-only mutations', () => {
    expect(migration).toContain("('quotation.view', 'quotations'");
    expect(migration).toContain("('booking.view', 'bookings'");
    expect(migration).toContain("has_permission(target_organization_id, 'quotation.view')");
    expect(migration).toContain("has_permission(target_organization_id, 'booking.view')");
    expect(migration).toContain("has_permission(current_organization_id, 'quotation.manage')");
    expect(migration).toContain("has_permission(current_organization_id, 'booking.manage')");
    expect(customerMigration).toContain(
      "has_permission(customer_row.organization_id, 'quotation.view')",
    );
    expect(customerMigration).toContain(
      "has_permission(customer_row.organization_id, 'booking.view')",
    );
  });

  it('server-paginates scoped lists, validates filters, and returns one KPI bundle', () => {
    const quotations = section(
      'create or replace function public.get_quotation_workspace_page(',
      'create or replace function public.get_booking_workspace_page(',
    );
    const bookings = section(
      'create or replace function public.get_booking_workspace_page(',
      'create or replace function public.get_quotation_lead_options(',
    );
    for (const list of [quotations, bookings]) {
      expect(list).toContain('target_page_size not in (25, 50, 100)');
      expect(list).toContain('app_private.current_tenant_organization()');
      expect(list).toContain('app_private.can_access_record(');
      expect(list).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
      expect(list).toContain("'kpis', jsonb_build_object(");
      expect(list).not.toMatch(/select\s+\*\s+from\s+public\.(quotations|bookings)/i);
    }
    expect(migration).toContain('quotations_workspace_idx');
    expect(migration).toContain('bookings_workspace_idx');
  });
});

describe('quotation mutation boundary', () => {
  const save = section(
    'create or replace function public.save_quotation(',
    'create or replace function public.transition_quotation_status(',
  );
  const approval = section(
    'create or replace function public.decide_quotation_approval(',
    'create or replace function public.create_booking_from_quotation(',
  );

  it('recomputes bounded line totals in SQL and keeps immutable version snapshots', () => {
    expect(save).toContain("jsonb_typeof(target_items) <> 'array'");
    expect(save).toContain('jsonb_array_length(target_items) not between 1 and 50');
    expect(save).toContain("normalized_type = 'DISCOUNT'");
    expect(save).toContain('computed_total_amount := computed_total_amount');
    expect(save).toContain('discount_amount > gross_amount * 0.10');
    expect(save).toContain('insert into public.quotation_versions');
    expect(save).toContain('set deleted_at = now()');
    expect(save).not.toContain('delete from public.quotation_items');
  });

  it('requires a distinct authorized approver and records the decision history', () => {
    expect(approval).toContain("has_permission(current_organization_id, 'approval.decide')");
    expect(approval).toContain('DISTINCT_APPROVER_REQUIRED');
    expect(approval).toContain('insert into public.approval_history');
    expect(approval).toContain("'quotation.approval_decided'");
    expect(migration).toContain('approvals_pending_quotation_unique_idx');
  });

  it('uses replay-safe idempotency, row locks, optimistic versions, activity and audit logs', () => {
    expect(migration).toContain('app_private.replay_sales_request');
    expect(migration).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('QUOTATION_VERSION_CONFLICT');
    expect(migration).toContain('BOOKING_VERSION_CONFLICT');
    expect(migration.match(/insert into public\.activities/g)?.length).toBeGreaterThanOrEqual(5);
    expect(migration.match(/insert into public\.audit_logs/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe('booking lifecycle boundary', () => {
  const create = section(
    'create or replace function public.create_booking_from_quotation(',
    'create or replace function public.transition_booking_status(',
  );
  const transition = section(
    'create or replace function public.transition_booking_status(',
    '-- Extend the private invalidation topic allow-list.',
  );

  it('converts exactly one accepted quotation and inherits its tenant/customer scope', () => {
    expect(create).toContain("quotation_row.status <> 'ACCEPTED'");
    expect(create).toContain('QUOTATION_ALREADY_BOOKED');
    expect(create).toContain("set status = 'CONVERTED'");
    expect(create).toContain('insert into public.booking_status_history');
    expect(migration).toContain('bookings_quotation_org_fk');
  });

  it('requires stock evidence before allocation/delivery and release before cancellation', () => {
    expect(transition).toContain("allocation_row.status in ('RESERVED', 'ALLOCATED')");
    expect(transition).toContain("allocation_row.status = 'ALLOCATED'");
    expect(transition).toContain('ACTIVE_STOCK_ALLOCATION_REQUIRED');
    expect(transition).toContain('DELIVERY_READY_STOCK_REQUIRED');
    expect(transition).toContain('DELIVERED_STOCK_REQUIRED');
    expect(transition).toContain('RELEASE_STOCK_BEFORE_CANCELLING');
    expect(transition).toContain('insert into public.booking_status_history');
  });
});

describe('sales document web contract', () => {
  it('uses shadcn, TanStack Query/Table, debounce, scoped Realtime and no unapproved chart library', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain("resource: 'sales'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(dialogs).toContain("from '@/components/ui/dialog'");
    expect(`${workspace}\n${dialogs}`).not.toMatch(/recharts|chart\.js|apexcharts|@mui/i);
  });

  it('uses the fixed reference pricing form while preserving server-calculated line items', () => {
    for (const field of [
      'Ex-showroom Price',
      'Insurance',
      'Registration Charges',
      'Accessories',
      'Extended Warranty',
      'Service Package',
      'Exchange Value',
      'Corporate Offer',
      'Dealer Discount',
      'Additional Discount',
      'Quotation Validity',
      'Final On-Road Price',
    ])
      expect(quotationCreate).toContain(field);
    expect(quotationCreate).not.toContain('Add item');
    expect(quotationCreate).toContain('fetchQuotationVehicleOptions');
    expect(quotationCreate).toContain('items,');
  });

  it('wires configured quotation and booking route families before fail-closed fallback', () => {
    expect(route).toContain("if (spec.category === 'quotations' && !isLocalPreviewMode())");
    expect(route).toContain('<SalesDocumentWorkspace kind="quotations"');
    expect(route).toContain("if (spec.category === 'bookings' && !isLocalPreviewMode())");
    expect(route).toContain('<SalesDocumentWorkspace kind="bookings"');
    expect(route.indexOf("spec.category === 'bookings'")).toBeLessThan(
      route.indexOf('if (!isLocalPreviewMode()) return <ProductionDataUnavailable />'),
    );
  });
});
