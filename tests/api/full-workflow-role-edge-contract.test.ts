import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function section(sourceText: string, start: string, end: string) {
  const startIndex = sourceText.indexOf(start);
  const endIndex = sourceText.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return sourceText.slice(startIndex, endIndex);
}

const leadWorkspace = source('src/features/leads/lead-workspace.tsx');
const workMigration = source('supabase/migrations/202608150016_work_appointments_workspace.sql');
const testDriveMigration = source('supabase/migrations/202608150025_test_drive_workspace.sql');
const inventoryMigration = source('supabase/migrations/202608150023_inventory_stock_workspace.sql');
const bookingMigration = source('supabase/migrations/202608150024_quotation_booking_workspace.sql');
const operationalMigration = source(
  'supabase/migrations/202608150027_operational_case_workspace.sql',
);

const cancelFollowup = section(
  workMigration,
  'create or replace function public.cancel_followup(',
  'revoke all on function public.cancel_followup(',
);
const testDriveCreate = section(
  testDriveMigration,
  'create or replace function public.create_test_drive(',
  'create or replace function public.cancel_test_drive(',
);
const inventoryAllocate = section(
  inventoryMigration,
  'create or replace function public.allocate_stock_unit(',
  'create or replace function public.release_stock_allocation(',
);
const bookingTransition = section(
  bookingMigration,
  'create or replace function public.transition_booking_status(',
  'revoke all on function public.transition_booking_status(',
);
const operationalUpdate = section(
  operationalMigration,
  'create or replace function public.update_operational_case(',
  'create or replace function public.get_operational_case_detail(',
);

describe('end-to-end workflow role edge contract', () => {
  it('keeps the Telecaller ladder exclusive and recoverable', () => {
    expect(leadWorkspace).toContain('function PendingFollowupDialog');
    expect(leadWorkspace).toContain('Follow-up still pending');
    expect(leadWorkspace).toContain('Complete or cancel it to continue');
    expect(leadWorkspace).toContain('function canHandOffToSales');
    expect(leadWorkspace).toContain("lead.lifecycle_status !== 'Lost'");
    expect(cancelFollowup).toContain("status = 'CANCELLED'");
    expect(cancelFollowup).toContain('CANCELLATION_REASON_REQUIRED');
  });

  it('prevents Sales Consultants from creating conflicting test drives or advancing them out of order', () => {
    expect(testDriveCreate).toContain('TEST_DRIVE_VEHICLE_SCHEDULE_CONFLICT');
    expect(testDriveCreate).toContain('TEST_DRIVE_CONSULTANT_SCHEDULE_CONFLICT');
    expect(testDriveCreate).toContain("source_row.status = 'AVAILABLE'");
    expect(testDriveMigration).toContain('TEST_DRIVE_ASSIGNEE_REQUIRED');
    expect(testDriveMigration).toContain('TEST_DRIVE_CONSULTANT_ALREADY_ACTIVE');
    expect(testDriveMigration).toContain("drive_row.status <> 'COMPLETED'");
  });

  it('protects Inventory allocation from duplicate or invalid stock assignment', () => {
    expect(inventoryAllocate).toContain("normalized_status not in ('RESERVED', 'ALLOCATED')");
    expect(inventoryAllocate).toContain("allocation_record.status <> 'RESERVED'");
    expect(inventoryMigration).toContain('stock_allocations_active_stock_unique_idx');
    expect(inventoryMigration).toContain('stock_allocations_active_booking_unique_idx');
    expect(testDriveMigration).toContain('TEST_DRIVE_PREVENTS_STOCK_ALLOCATION');
  });

  it('requires Sales booking and delivery transitions to respect allocation and final-state evidence', () => {
    expect(bookingTransition).toContain('INVALID_BOOKING_TRANSITION');
    expect(bookingTransition).toContain('ACTIVE_STOCK_ALLOCATION_REQUIRED');
    expect(bookingTransition).toContain('DELIVERY_READY_STOCK_REQUIRED');
    expect(bookingTransition).toContain('DELIVERED_STOCK_REQUIRED');
    expect(bookingTransition).toContain('RELEASE_STOCK_BEFORE_CANCELLING');
    expect(bookingTransition).toContain('BOOKING_VERSION_CONFLICT');
  });

  it('requires Finance, Insurance, and RTO evidence before each terminal case can advance', () => {
    expect(operationalUpdate).toContain('INVALID_OPERATIONAL_CASE_TRANSITION');
    expect(operationalUpdate).toContain('FINANCE_CASE_DOCUMENT_REQUIRED');
    expect(operationalUpdate).toContain('INVALID_FINANCE_CASE_DETAILS');
    expect(operationalUpdate).toContain('INSURANCE_POLICY_DOCUMENT_REQUIRED');
    expect(operationalUpdate).toContain('INVALID_INSURANCE_CASE_DETAILS');
    expect(operationalUpdate).toContain('RTO_CASE_DOCUMENT_REQUIRED');
    expect(operationalUpdate).toContain('INVALID_RTO_CASE_DETAILS');
    expect(operationalUpdate).toContain('OPERATIONAL_CASE_VERSION_CONFLICT');
  });

  it('requires Delivery PDI, checklist, schedule, and proof before final completion', () => {
    expect(operationalUpdate).toContain('DELIVERY_CHECKLIST_REQUIRED');
    expect(operationalUpdate).toContain('DELIVERY_CHECKLIST_INCOMPLETE');
    expect(operationalUpdate).toContain('DELIVERY_SCHEDULE_REQUIRED');
    expect(operationalUpdate).toContain('DELIVERY_EVIDENCE_REQUIRED');
    expect(operationalUpdate).toContain('DELIVERY_SIGNATURE_MISMATCH');
  });
});
