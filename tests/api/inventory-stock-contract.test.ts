import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InventoryVersionConflictError,
  inventoryViewForRoute,
  isInventoryVersionConflict,
  parseInventoryQuery,
  toInventoryQueryString,
} from '../../src/features/inventory/inventory-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150023_inventory_stock_workspace.sql');
const nextMigration = source('supabase/migrations/202608150024_quotation_booking_workspace.sql');
const workspace = source('src/features/inventory/inventory-workspace.tsx');
const dialogs = source('src/features/inventory/inventory-dialogs.tsx');
const api = source('src/features/inventory/inventory-api.ts');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('inventory permission and identity boundary', () => {
  it('separates aggregate stock checking from VIN-level and mutation permissions', () => {
    for (const permission of [
      'inventory.stock_check',
      'inventory.view',
      'inventory.create',
      'inventory.update',
      'inventory.move',
      'inventory.allocate',
    ])
      expect(migration).toContain(`('${permission}', 'inventory'`);
    expect(migration).toContain("role_row.role_key = 'sales_consultant'");
    expect(migration).toContain("permission_row.permission_key = 'inventory.stock_check'");
    expect(migration).toContain("'client_admin', 'system_administrator', 'inventory_manager'");
  });

  it('normalizes tenant-unique VIN/chassis identity and prevents cross-tenant references', () => {
    expect(migration).toContain('app_private.normalize_inventory_identifier');
    expect(migration).toContain('stock_units_org_normalized_vin_unique_idx');
    expect(migration).toContain('stock_units_org_normalized_chassis_unique_idx');
    expect(migration).toContain("normalized_vin ~ '^[A-HJ-NPR-Z0-9]{17}$'");
    expect(migration).toContain('stock_units_branch_org_fk');
    expect(migration).toContain('stock_units_variant_org_fk');
    expect(migration).toContain('stock_movements_unit_org_fk');
    expect(migration).toContain('stock_allocations_unit_org_fk');
    expect(migration).toContain('stock_allocations_booking_org_fk');
    expect(migration).toContain('bookings_org_id_unique_idx');
    expect(migration).toContain('stock_allocations_validate_scope');
    expect(migration).toContain('STOCK_ALLOCATION_BRANCH_MISMATCH');
    expect(migration).toContain('BOOKING_ALLOCATION_BRANCH_MISMATCH');
  });

  it('closes direct writes and does not expose an ordinary hard-delete RPC', () => {
    expect(migration).toContain('revoke insert, update, delete on public.stock_units');
    expect(migration).toContain('revoke insert, update, delete on public.stock_movements');
    expect(migration).toContain('revoke insert, update, delete on public.stock_allocations');
    expect(migration).not.toMatch(/function public\.(?:delete|purge)_stock/i);
  });
});

describe('inventory read boundary', () => {
  const stockUnits = section(
    'create or replace function public.get_stock_unit_page(',
    'create or replace function public.get_stock_check_page(',
  );
  const stockCheck = section(
    'create or replace function public.get_stock_check_page(',
    'create or replace function public.get_stock_allocation_page(',
  );
  const allocations = section(
    'create or replace function public.get_stock_allocation_page(',
    'create or replace function public.get_stock_movement_page(',
  );
  const movements = section(
    'create or replace function public.get_stock_movement_page(',
    'create or replace function public.get_inventory_variant_options(',
  );

  it('server-paginates every operational list with stable, allowlisted queries and one KPI bundle', () => {
    for (const list of [stockUnits, stockCheck, allocations, movements]) {
      expect(list).toContain('target_page_size not in (25, 50, 100)');
      expect(list).toContain('limit target_page_size');
      expect(list).toContain('offset (target_page - 1) * target_page_size');
      expect(list).toContain("'kpis', jsonb_build_object(");
      expect(list).toContain('app_private.can_access_branch');
      expect(list).not.toMatch(/select\s+\*\s+from\s+public\./i);
    }
  });

  it('keeps the sales stock-check preset aggregate-only', () => {
    expect(stockCheck).toContain("'available', page_row.available");
    expect(stockCheck).toContain("'availability', page_row.availability");
    expect(stockCheck).toContain("'inventory.stock_check'");
    expect(stockCheck).not.toContain("'vin'");
    expect(stockCheck).not.toContain('chassis_number');
    expect(stockCheck).not.toContain('booking_number');
  });

  it('indexes the actual stock, movement and allocation page patterns', () => {
    expect(migration).toContain('stock_units_org_status_received_page_idx');
    expect(migration).toContain('stock_units_org_branch_received_page_idx');
    expect(migration).toContain('stock_movements_org_moved_page_idx');
    expect(migration).toContain('stock_allocations_org_status_page_idx');
    expect(migration).toContain('stock_allocations_active_stock_unique_idx');
    expect(migration).toContain('stock_allocations_active_booking_unique_idx');
  });
});

describe('inventory mutation boundary', () => {
  const create = section(
    'create or replace function public.create_stock_unit(',
    'create or replace function public.update_stock_unit(',
  );
  const update = section(
    'create or replace function public.update_stock_unit(',
    'create or replace function public.set_stock_unit_status(',
  );
  const status = section(
    'create or replace function public.set_stock_unit_status(',
    'create or replace function public.move_stock_unit(',
  );
  const move = section(
    'create or replace function public.move_stock_unit(',
    'create or replace function public.allocate_stock_unit(',
  );
  const allocate = section(
    'create or replace function public.allocate_stock_unit(',
    'create or replace function public.release_stock_allocation(',
  );
  const release = section('create or replace function public.release_stock_allocation(', 'commit;');

  it('uses replay-safe request IDs, audit logs and optimistic versions for every write', () => {
    for (const mutation of [create, update, status, move, allocate, release]) {
      expect(mutation).toContain('target_request_id');
      expect(mutation).toContain('app_private.inventory_request_fingerprint');
      expect(mutation).toContain('app_private.inventory_idempotent_replay');
      expect(mutation).toContain('pg_advisory_xact_lock');
      expect(mutation).toContain('insert into public.audit_logs');
    }
    for (const mutation of [update, status, move, allocate, release])
      expect(mutation).toContain('VERSION_CONFLICT');
  });

  it('validates physical intake and records every successful change as a movement', () => {
    expect(create).toContain('INVALID_VIN');
    expect(create).toContain('INVALID_CHASSIS_NUMBER');
    expect(create).toContain('INVALID_ENGINE_NUMBER');
    expect(create).toContain('INVALID_RECEIVED_TIME');
    expect(create).toContain("'INTAKE'");
    expect(update).toContain("'DETAIL_UPDATE'");
    expect(status).toContain("'STATUS_CHANGE'");
    expect(move).toContain("'BRANCH_TRANSFER'");
    expect(allocate).toContain("'ALLOCATION'");
    expect(release).toContain("'ALLOCATION_RELEASE'");
  });

  it('requires mutual branch scope and refuses to move allocated stock', () => {
    expect(move.match(/app_private\.can_access_branch/g)?.length).toBeGreaterThanOrEqual(2);
    expect(move).toContain('ACTIVE_ALLOCATION_PREVENTS_MOVE');
    expect(move).toContain("stock_record.status not in ('INCOMING', 'AVAILABLE', 'HOLD')");
  });

  it('owns stock/allocation state while leaving booking lifecycle to the booking RPC', () => {
    expect(allocate).toContain("normalized_status not in ('RESERVED', 'ALLOCATED')");
    expect(allocate).toContain("allocation_record.status <> 'RESERVED'");
    expect(allocate).toContain("set status = 'ALLOCATED'");
    expect(release).toContain("set status = 'RELEASED'");
    expect(release).toContain("set status = 'AVAILABLE'");
    expect(release).toContain("stock_record.status not in ('ALLOCATED', 'READY_FOR_DELIVERY')");
    expect(migration).toContain("('ALLOCATED', 'READY_FOR_DELIVERY')");
    expect(migration).toContain("('READY_FOR_DELIVERY', 'DELIVERED')");
    expect(`${allocate}\n${release}\n${status}`).not.toMatch(/update\s+public\.bookings/i);
  });
});

describe('inventory and booking integration contract', () => {
  it('preserves the inventory Realtime topic through the following sales migration', () => {
    expect(migration).toContain("broadcast_tenant_invalidation('inventory')");
    expect(nextMigration).toMatch(/administration\|inventory\|sales/);
    expect(nextMigration).toContain("when 'inventory' then");
    expect(nextMigration).toContain("'inventory.stock_check'");
  });

  it('keeps final booking evidence compatible with allocation and stock status semantics', () => {
    expect(nextMigration).toContain("allocation_row.status in ('RESERVED', 'ALLOCATED')");
    expect(nextMigration).toContain("allocation_row.status = 'ALLOCATED'");
    expect(nextMigration).toContain("stock_row.status = 'READY_FOR_DELIVERY'");
    expect(nextMigration).toContain("stock_row.status = 'DELIVERED'");
    expect(nextMigration).toContain('RELEASE_STOCK_BEFORE_CANCELLING');
  });
});

describe('inventory web contract', () => {
  it('uses only the approved data, table, component, chart and Realtime stack', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain("from '@/components/charts/e-chart'");
    expect(workspace).toContain("resource: 'inventory'");
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(dialogs).toContain("from '@/components/ui/dialog'");
    expect(dialogs).toContain("from '@/components/ui/sheet'");
    expect(`${workspace}\n${dialogs}`).not.toMatch(/recharts|chart\.js|apexcharts|@mui/i);
  });

  it('uses charts only in the analytical dashboard section', () => {
    const dashboardStart = workspace.indexOf('function Dashboard(');
    const filtersStart = workspace.indexOf('function Filters(');
    expect(dashboardStart).toBeGreaterThanOrEqual(0);
    expect(filtersStart).toBeGreaterThan(dashboardStart);
    expect(workspace.slice(dashboardStart, filtersStart)).toContain('<EChart');
    expect(workspace.slice(filtersStart)).not.toContain('<EChart');
  });

  it('wires only completed Inventory Manager and sales stock-check routes', () => {
    expect(route).toContain("role === 'inventory'");
    expect(route).toContain("'vehicle-inventory'");
    expect(route).toContain("'stock-allocation'");
    expect(route).toContain("'stock-ageing'");
    expect(route).toContain("'stock-transfer'");
    expect(route).toContain("role === 'sales-consultant' && slug[0] === 'stock-check'");
    expect(route).toContain('<InventoryWorkspace');
    expect(api).toContain("'inventory.stock_check'");
  });
});

describe('inventory URL and concurrency helpers', () => {
  it('maps only configured role routes to a production preset', () => {
    expect(inventoryViewForRoute('inventory', 'dashboard')).toBe('dashboard');
    expect(inventoryViewForRoute('inventory', 'vehicle-inventory')).toBe('units');
    expect(inventoryViewForRoute('sales-consultant', 'stock-check')).toBe('stock-check');
    expect(inventoryViewForRoute('telecaller', 'dashboard')).toBeNull();
  });

  it('accepts only view-specific filters, sorting, UUID branches and bounded pagination', () => {
    expect(
      parseInventoryQuery(
        new URLSearchParams(
          'page=-2&pageSize=77&status=allocated&age=90-plus&sort=drop-table&branch=------------------------------------&q=%20%20VIN123%20',
        ),
        'stock-check',
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      search: 'VIN123',
      filter: 'all',
      branchId: '',
      age: 'all',
      sort: 'model:asc',
    });
  });

  it('preserves meaningful page-local state and recognizes only conflict signals', () => {
    const branchId = '123e4567-e89b-42d3-a456-426614174000';
    expect(
      toInventoryQueryString(
        {
          page: 3,
          pageSize: 50,
          search: 'Nexon',
          filter: 'available',
          branchId,
          age: '61-90',
          sort: 'age:desc',
        },
        'units',
      ),
    ).toBe(
      `page=3&pageSize=50&q=Nexon&status=available&branch=${branchId}&age=61-90&sort=age%3Adesc`,
    );
    expect(isInventoryVersionConflict(new InventoryVersionConflictError())).toBe(true);
    expect(isInventoryVersionConflict({ code: '40001', message: 'STOCK_VERSION_CONFLICT' })).toBe(
      true,
    );
    expect(isInventoryVersionConflict({ code: '42501', message: 'PERMISSION_DENIED' })).toBe(false);
  });
});
