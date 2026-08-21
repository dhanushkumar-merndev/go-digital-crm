import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608200012_sales_booking_workspace.sql');
const api = source('src/features/sales/sales-document-api.ts');
const workspace = source('src/features/sales/sales-document-workspace.tsx');

describe('sales booking workspace contract', () => {
  it('keeps list queries tenant, permission and record-scope protected', () => {
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'booking.view')",
    );
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('app_private.can_access_branch');
    expect(migration).toContain('booking_row.organization_id = current_organization_id');
  });

  it('performs model, branch and booking-date filtering on the server with bounded pagination', () => {
    expect(migration).toContain('target_model text default null');
    expect(migration).toContain('target_branch_id uuid default null');
    expect(migration).toContain('target_from_date date default null');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('limit target_page_size offset');
    expect(api).toContain("rpc('get_sales_booking_filter_options'");
    expect(api).toContain("'get_sales_booking_workspace_page'");
  });

  it('uses real quotation and allocated stock vehicle details and exposes reference tabs', () => {
    expect(migration).toContain('public.quotation_items');
    expect(migration).toContain('public.stock_allocations');
    expect(migration).toContain('public.stock_units');
    expect(workspace).toContain("'Stock Awaited'");
    expect(workspace).toContain('Delivered this month');
    expect(workspace).toContain('Create booking');
  });
});
