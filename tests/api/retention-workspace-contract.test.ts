import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeRetentionSearch,
  parseRetentionQuery,
  toRetentionQueryString,
} from '../../src/features/platform/retention/retention-query';

const migration = readFileSync('supabase/migrations/202608150015_retention_workspace.sql', 'utf8');
const workflowMigration = readFileSync(
  'supabase/migrations/202608150010_controlled_retention_workflow.sql',
  'utf8',
);
const api = readFileSync('src/features/platform/retention/retention-api.ts', 'utf8');
const workspace = readFileSync('src/features/platform/retention/retention-workspace.tsx', 'utf8');
const rolePage = readFileSync('src/app/[role]/[[...slug]]/page.tsx', 'utf8');

describe('platform retention workspace contracts', () => {
  it('normalizes and round-trips server pagination, status, sort, and search state', () => {
    const query = parseRetentionQuery(
      new URLSearchParams(
        'page=3&pageSize=50&status=legal-hold&sort=deleted%3Adesc&q=North%20Motors',
      ),
    );
    expect(query).toEqual({
      page: 3,
      pageSize: 50,
      status: 'legal-hold',
      sort: 'deleted:desc',
      search: 'North Motors',
    });
    expect(parseRetentionQuery(new URLSearchParams(toRetentionQueryString(query)))).toEqual(query);
    expect(parseRetentionQuery(new URLSearchParams('page=-1&pageSize=500&status=unknown'))).toEqual(
      {
        page: 1,
        pageSize: 25,
        status: 'open',
        sort: 'purge:asc',
        search: '',
      },
    );
    expect(normalizeRetentionSearch(`  ${'x'.repeat(200)}  `)).toHaveLength(160);
  });

  it('uses one MFA-protected RPC for a bounded list and KPI response', () => {
    expect(migration).toContain('get_platform_retention_workspace');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('char_length(normalized_search) > 160');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain("'records', coalesce(");
    expect(migration).toContain("'kpis', jsonb_build_object(");
    expect(migration).toContain('offset (target_page - 1) * target_page_size');
    expect(migration).toContain('limit target_page_size');
    expect(api).toContain("rpc('get_platform_retention_workspace'");
  });

  it('offers only currently eligible tenants and keeps final eligibility transactional', () => {
    expect(migration).toContain('get_platform_retention_tenant_options');
    expect(migration).toContain(
      "organization_row.status not in ('SOFT_DELETED', 'SUPPORT_MAINTENANCE')",
    );
    expect(migration).toContain('session_row.expires_at > now()');
    expect(migration).toContain('limit 25');
    expect(workflowMigration).toContain('for update;');
    expect(workflowMigration).toContain('ACTIVE_SUPPORT_SESSION_EXISTS');
    expect(workflowMigration).toContain('deletion_requests_one_open_tenant_idx');
  });

  it('routes every operator action through audited retention RPCs', () => {
    for (const rpc of [
      'request_tenant_deletion',
      'review_tenant_deletion',
      'restore_soft_deleted_tenant',
      'set_tenant_deletion_legal_hold',
      'extend_tenant_retention',
      'requeue_failed_tenant_purge',
    ])
      expect(api).toContain(`rpc('${rpc}'`);
    expect(workspace).toContain('crypto.randomUUID()');
    expect(workspace).toContain('The requesting Super Admin cannot approve their own request.');
    expect(workspace).toContain('final checksum');
    expect(workspace).toContain('External provider token revocation staged');
  });

  it('wires the production-only route and realtime invalidation without exposing a purge API', () => {
    expect(rolePage).toContain("slug[0] === 'data-retention'");
    expect(rolePage).toContain('<RetentionWorkspace spec={spec} />');
    expect(workspace).toContain("resource: 'retention'");
    expect(migration).toContain("broadcast_platform_invalidation('retention')");
    expect(api).not.toContain("rpc('purge_tenant_data_batch'");
    expect(api).not.toContain("rpc('finalize_controlled_tenant_purge'");
  });
});
