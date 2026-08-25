import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const migration = source('supabase/migrations/202608220034_global_customer_lookup.sql');
const customerSearchApi = source('src/features/customers/global-customer-search-api.ts');
const customerSearch = source('src/components/shared/global-customer-search.tsx');
const notificationCenter = source('src/features/notifications/notification-center-sheet.tsx');
const appHeader = source('src/components/shared/app-header.tsx');

describe('global workflow centers contract', () => {
  it('keeps global customer lookup tenant, permission and customer-scope guarded', () => {
    expect(migration).toContain('create or replace function public.search_authorized_customers(');
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'customer.view')",
    );
    expect(migration).toContain(
      'app_private.can_access_customer(customer_row.organization_id, customer_row.id)',
    );
    expect(migration).toContain('GLOBAL_CUSTOMER_SEARCH_REQUIRES_2_TO_160_CHARACTERS');
    expect(migration).toContain('limit target_page_size + 1');
    expect(migration).toContain("'has_next'");
    expect(migration).toContain('revoke all on function public.search_authorized_customers');
    expect(migration).toContain('grant execute on function public.search_authorized_customers');
    expect(migration).not.toContain('to anon;\ngrant execute');
  });

  it('uses the lookup RPC from a debounced, paginated customer search dialog', () => {
    expect(customerSearchApi).toContain("rpc('search_authorized_customers'");
    expect(customerSearch).toContain('useDebouncedValue(value, 300)');
    expect(customerSearch).toContain('enabled: open && ready');
    expect(customerSearch).toContain('has_next');
    expect(customerSearch).toContain('Customer search');
    expect(customerSearch).toContain('router.push(`/${role}/customers/${customerId}`)');
  });

  it('provides a paginated notification center sharing the private read mutation', () => {
    expect(notificationCenter).toContain(
      'fetchNotificationPage({ page, pageSize: 25, search, status, signal })',
    );
    expect(notificationCenter).toContain('useDebouncedValue(searchInput, 300)');
    expect(notificationCenter).toContain('markHeaderNotificationRead');
    expect(notificationCenter).toContain('notificationWorkspaceKey');
    expect(notificationCenter).toContain('headerNotificationsKey');
  });

  it('keeps customer search and notifications in the header, and routes Tasks to its page', () => {
    expect(appHeader).toContain('<GlobalCustomerSearch role={role} />');
    expect(appHeader).toContain('onClick={() => router.push(`/${role}/tasks`)}');
    expect(appHeader).not.toContain('<TaskCenterSheet');
    expect(appHeader).toContain('<NotificationCenterSheet');
    expect(appHeader).toContain('View notification center');
  });
});
