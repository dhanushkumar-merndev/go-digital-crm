import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/202608260005_customer_drip_messaging.sql');
const api = source('src/features/customers/customer-drip-api.ts');
const panel = source('src/features/customers/customer-drip-panel.tsx');
const workspace = source('src/features/customers/customer-360-workspace.tsx');

describe('customer drip sequences', () => {
  it('keeps every read and write behind a scoped, permission-guarded RPC', () => {
    for (const rpc of [
      'get_customer_drip_templates',
      'get_customer_drip_panel',
      'create_customer_drip_enrollment',
      'cancel_customer_drip_enrollment',
    ]) {
      expect(migration).toContain(`function public.${rpc}`);
    }
    expect(migration).toContain('security definer');
    expect(migration).toContain('app_private.can_access_customer');
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain("has_permission(current_organization_id, 'customer.drip.manage')");
    expect(migration).toContain("has_permission(current_organization_id, 'customer.drip.view')");
    expect(migration).toContain('CUSTOMER_DRIP_SCOPE_DENIED');
  });

  it('enables and forces row level security on both new tables', () => {
    for (const table of ['customer_drip_enrollments', 'customer_drip_messages']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`alter table public.${table} force row level security`);
    }
    expect(migration).toContain(
      'revoke insert, update, delete, truncate\n  on public.customer_drip_enrollments, public.customer_drip_messages\n  from anon, authenticated;',
    );
  });

  it('copies template steps instead of reading the campaign back later', () => {
    // A campaign edited or archived by marketing next week must not change what
    // a customer was already promised, so the enrolment stores its own copy.
    expect(migration).toContain('source_campaign_id');
    expect(migration).toContain('Provenance only');
    expect(migration).toContain('insert into public.customer_drip_messages');
    expect(migration).not.toContain(
      'update public.customer_drip_messages message_row\n    set message_body',
    );
  });

  it('is idempotent on the request id and optimistic on cancellation', () => {
    expect(migration).toContain('REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('STALE_CUSTOMER_DRIP_VERSION');
    expect(api).toContain('requestId');
  });

  it('cancels only messages that have not been sent', () => {
    expect(migration).toContain("and message_row.status = 'QUEUED'");
    expect(panel).toContain('Messages already sent stay on the record');
  });

  it('reads the refusal reason from the message, never the SQLSTATE', () => {
    expect(api).toContain('getDripErrorMessage');
    expect(api).toContain('error.message');
    expect(api).not.toContain('error.code ??');
  });

  it('gates the Customer 360 tab on the permission and keeps it off the section pager', () => {
    expect(workspace).toContain(
      "hasWorkspacePermission(useWorkspaceSession(), 'customer.drip.view')",
    );
    expect(workspace).toContain('<CustomerDripPanel');
    // Drip fetches its own panel, so it must not appear in the lazy section map
    // that drives the shared pager and its loading and error states.
    expect(workspace).toContain('lazySectionByTab: Partial<');
    expect(workspace).not.toContain("drip: 'drip',");
  });
});
