import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source(
  'supabase/migrations/202608220005_sales_consultant_sales_stock_exchange_hot_paths.sql',
);
const softDeleteMigration = source(
  'supabase/migrations/202608220000_quotation_soft_delete_contract.sql',
);
const indexMigration = source(
  'supabase/migrations/202608220001_sales_consultant_hot_path_indexes.sql',
);

function functionBody(startMarker: string, endMarker: string) {
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('Sales Consultant sales, stock and exchange hot paths', () => {
  it('keeps every public RPC signature and delegates non-Sales roles to legacy behavior', () => {
    const legacyNames = [
      'get_quotation_workspace_page_legacy',
      'get_sales_booking_filter_options_legacy',
      'get_sales_booking_workspace_page_legacy',
      'get_stock_check_filter_options_legacy',
      'get_stock_check_page_v2_legacy',
      'get_sales_exchange_options_legacy',
    ];
    for (const legacyName of legacyNames) {
      expect(migration).toContain(`rename to ${legacyName}`);
      expect(migration).toContain(`return public.${legacyName}(`);
    }

    expect(migration).toContain('create or replace function public.get_quotation_workspace_page(');
    expect(migration).toContain(
      'create or replace function public.get_sales_booking_filter_options()',
    );
    expect(migration).toContain(
      'create or replace function public.get_sales_booking_workspace_page(',
    );
    expect(migration).toContain(
      'create or replace function public.get_stock_check_filter_options(',
    );
    expect(migration).toContain('create or replace function public.get_stock_check_page_v2(');
    expect(migration).toContain('create or replace function public.get_sales_exchange_options(');
  });

  it('uses one permission-set lookup plus direct owner and allowed-branch scope', () => {
    expect(migration.match(/access_context->>'role_key' = 'sales-consultant'/g)).toHaveLength(6);
    expect(migration.match(/sales_consultant_permissions\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(migration).toContain('quotation_row.assigned_user_id = target_user_id');
    expect(migration).toContain('booking_row.assigned_user_id = target_user_id');
    expect(migration).toContain('booking_row.branch_id = any(target_branch_ids)');
    expect(migration).toContain('stock_row.branch_id = any(target_branch_ids)');
    expect(migration).not.toContain('app_private.can_access_record(');
    expect(migration).not.toContain(
      'app_private.can_access_branch(stock_row.organization_id, stock_row.branch_id)',
    );
  });

  it('gates customer PII and uses the indexed normalized customer search path', () => {
    expect(migration).toContain("can_view_customer := 'customer.view' = any(permission_keys)");
    expect(migration).toContain("else 'Restricted' end as customer_name");
    expect(migration).toContain('then customer_row.primary_phone else null end as phone');
    expect(migration).toContain("or not ('customer.view' = any(permission_keys))");
    expect(migration.match(/customer_row\.normalized_name/g)?.length).toBeGreaterThanOrEqual(5);
    expect(migration).not.toContain('position(normalized_search in lower(customer_row.full_name))');
  });

  it('pages IDs/groups before expensive child JSON and display enrichment', () => {
    const quotation = functionBody(
      'create or replace function app_private.get_sales_consultant_quotation_workspace_page(',
      'revoke all on function app_private.get_sales_consultant_quotation_workspace_page(',
    );
    expect(quotation.indexOf('page_rows as materialized')).toBeLessThan(
      quotation.indexOf('from public.quotation_items item_row'),
    );
    const quotationPage = quotation.slice(
      quotation.indexOf('page_rows as materialized'),
      quotation.indexOf('enriched_page as'),
    );
    expect(quotationPage).toContain('from public.quotations quotation_row');
    expect(quotationPage).not.toContain('from filtered_rows');
    expect(quotation).toContain("if target_sort = 'updated:desc' and normalized_search = ''");
    expect(quotation).toContain('order by quotation_row.updated_at desc, quotation_row.id desc');
    expect(quotationPage).toContain('quotation_row.id = any(page_ids)');

    const booking = functionBody(
      'create or replace function app_private.get_sales_consultant_booking_workspace_page(',
      'revoke all on function app_private.get_sales_consultant_booking_workspace_page(',
    );
    expect(booking.indexOf('page_rows as materialized')).toBeLessThan(
      booking.indexOf("item_row.item_type = 'VEHICLE'"),
    );
    const bookingPage = booking.slice(
      booking.indexOf('page_rows as materialized'),
      booking.indexOf('enriched_page as'),
    );
    expect(bookingPage).toContain('from public.bookings booking_row');
    expect(bookingPage).not.toContain('from filtered_rows');
    expect(booking).toContain("if target_sort = 'updated:desc'");
    expect(booking).toContain('order by booking_row.updated_at desc, booking_row.id desc');
    expect(bookingPage).toContain('booking_row.id = any(page_ids)');
    expect(booking).toContain('booking_row.created_at >= from_timestamp');
    expect(booking).toContain('booking_row.created_at < to_timestamp_exclusive');
    expect(booking).not.toContain('booking_row.created_at::date');

    const stock = functionBody(
      'create or replace function app_private.get_sales_consultant_stock_check_page(',
      'revoke all on function app_private.get_sales_consultant_stock_check_page(',
    );
    expect(stock.indexOf('grouped_keys as materialized')).toBeLessThan(
      stock.indexOf('join public.vehicle_variants variant_row'),
    );
    expect(stock.indexOf('page_rows as materialized')).toBeLessThan(
      stock.indexOf("'records', coalesce"),
    );

    const exchange = functionBody(
      'create or replace function app_private.get_sales_consultant_exchange_options(',
      'revoke all on function app_private.get_sales_consultant_exchange_options(',
    );
    expect(exchange.indexOf('page_rows as materialized')).toBeLessThan(
      exchange.indexOf('from public.customer_addresses address_row'),
    );
    expect(exchange.indexOf('limit target_limit')).toBeLessThan(
      exchange.indexOf('from public.customer_addresses address_row'),
    );
  });

  it('keeps all list/filter payloads bounded and fixes the exchange file contract', () => {
    expect(migration.match(/target_page_size not in \(25, 50, 100\)/g)).toHaveLength(3);
    expect(migration.match(/limit 100/g)?.length).toBeGreaterThanOrEqual(8);
    expect(migration).toContain('target_limit not between 1 and 25');
    expect(migration).toContain("'file_name', coalesce(file_row.original_file_name, 'Document')");
    expect(migration).not.toContain('file_row.file_name');
    expect(migration).not.toMatch(/select\s+\*/i);
  });

  it('provides owner/status/default-sort and active-stock covering indexes', () => {
    expect(indexMigration).toContain('quotations_sc_owner_updated_idx');
    expect(indexMigration).toContain('quotations_sc_owner_status_updated_idx');
    expect(indexMigration).toContain('bookings_sc_owner_updated_idx');
    expect(indexMigration).toContain('bookings_sc_owner_status_updated_idx');
    expect(indexMigration).toContain('stock_units_sc_active_group_idx');
    expect(indexMigration).toContain("where deleted_at is null and status <> 'DELIVERED'");
    expect(indexMigration).not.toMatch(/^begin;|^commit;/m);
  });

  it('honors quotation soft deletion without inventing a missing legacy column', () => {
    expect(softDeleteMigration).toContain('add column if not exists deleted_at timestamptz');
    expect(migration).toContain('quotation_row.deleted_at is null');
    expect(migration).toContain('get_quotation_workspace_page_legacy');
  });
});
