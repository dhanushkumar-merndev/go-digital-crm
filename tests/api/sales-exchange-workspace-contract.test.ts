import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { operationalCaseNextStatuses } from '../../src/features/operations/operational-case-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608200011_sales_exchange_workspace.sql');
const api = source('src/features/operations/sales-exchange-api.ts');
const workspace = source('src/features/operations/sales-exchange-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('sales exchange authorization and workflow', () => {
  it('persists a versioned draft and only allows the assigned consultant to request evaluation', () => {
    expect(migration).toContain("'DRAFT', 'REQUESTED'");
    expect(migration).toContain('booking_row.assigned_user_id = auth.uid()');
    expect(migration).toContain("'exchange.request'");
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain('app_private.can_access_customer');
    expect(migration).toContain('OPERATIONAL_CASE_VERSION_CONFLICT');
    expect(operationalCaseNextStatuses('EXCHANGE', 'DRAFT')).toEqual(['REQUESTED', 'CANCELLED']);
  });

  it('keeps manager evaluation separate and accepts an offer only after OFFERED', () => {
    expect(migration).toContain("normalized_action = 'ACCEPT_OFFER'");
    expect(migration).toContain("case_row.status <> 'OFFERED'");
    expect(migration).toContain('EXCHANGE_OFFER_NOT_READY');
    expect(migration).not.toContain('insert into public.exchange_evaluations');
  });

  it('uses auditable RPC mutations and private object storage rather than client table writes', () => {
    expect(api).toContain("rpc('save_sales_exchange_request'");
    expect(api).toContain('uploadOperationalCaseDocument');
    expect(migration).toContain('insert into public.audit_logs');
    expect(migration).toContain('insert into public.activities');
    expect(workspace).not.toMatch(/\.from\(['"]exchange_cases/);
  });
});

describe('sales exchange page contract', () => {
  it('routes the consultant to the dedicated workspace', () => {
    expect(route).toContain("role === 'sales-consultant' && slug[0] === 'exchange'");
    expect(route).toContain('<SalesExchangeWorkspace />');
  });

  it('exposes the reference workflow and real actions', () => {
    for (const text of [
      'Exchange Vehicle',
      'Existing Vehicle',
      'Request evaluation',
      'Submit exchange',
      'Vehicle Photos (Max 8)',
      'RC Copy',
      'Exchange Status',
      'Estimated Exchange Value',
    ])
      expect(workspace).toContain(text);
    expect(workspace).toContain("submit('SAVE_DRAFT')");
    expect(workspace).toContain("submit('REQUEST_EVALUATION')");
    expect(workspace).toContain("submit('ACCEPT_OFFER')");
  });
});
