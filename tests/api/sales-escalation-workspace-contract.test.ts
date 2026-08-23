import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220036_sales_escalation_workspace.sql');
const api = source('src/features/sales/sales-escalation-api.ts');
const workspace = source('src/features/sales/sales-escalation-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('sales escalation workspace contract', () => {
  it('uses scoped manager permissions and server-side pagination', () => {
    expect(migration).toContain("'escalation.view'");
    expect(migration).toContain("'escalation.resolve'");
    expect(migration).toContain('app_private.can_access_sales_escalation');
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('limit target_page_size offset');
  });

  it('resolves escalations through an audited, optimistic concurrency RPC', () => {
    expect(migration).toContain('create or replace function public.resolve_sales_escalation(');
    expect(migration).toContain('SALES_ESCALATION_VERSION_CONFLICT');
    expect(migration).toContain("'sales_escalation.resolved'");
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('revoke all on function public.resolve_sales_escalation');
  });

  it('keeps the UI query-driven and routes only manager roles to it', () => {
    expect(api).toContain("rpc('get_sales_escalation_workspace_page'");
    expect(api).toContain("rpc('resolve_sales_escalation'");
    expect(workspace).toContain('useDebouncedValue');
    expect(workspace).toContain('useReactTable');
    expect(workspace).toContain('Mark resolved');
    expect(route).toContain("['team-manager', 'showroom-manager', 'gm-sales'].includes(role)");
    expect(route).toContain('<SalesEscalationWorkspace role={role} />');
  });
});
