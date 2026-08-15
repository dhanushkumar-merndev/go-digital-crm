import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSupportWorkspaceQuery,
  toSupportSearchTerm,
  toSupportWorkspaceQueryString,
} from '../../src/features/platform/support-session-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150019_support_workspace.sql');
const api = source('src/features/platform/support-session-api.ts');
const workspace = source('src/features/platform/support-session-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('support workspace backend contract', () => {
  it('requires the exact platform or tenant MFA authorization boundary', () => {
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('app_private.is_tenant_support_controller(actor_organization_id)');
    expect(migration).toContain('app_private.has_organization_wide_scope(actor_organization_id)');
    expect(migration).toContain("message = 'SUPPORT_WORKSPACE_ACCESS_REQUIRED'");
  });

  it('bounds server-side filter, sort and pagination inputs', () => {
    expect(migration).toContain('page_size not in (25, 50, 100)');
    expect(migration).toContain("status_filter not in ('all', 'pending', 'active'");
    expect(migration).toContain("sort_key not in ('created_desc', 'created_asc'");
    expect(migration).toContain('limit page_size');
    expect(migration).toContain('offset page_offset');
    expect(api).toContain(".rpc('get_support_workspace_page'");
  });

  it('returns one scoped KPI/page envelope without raw support JSON', () => {
    expect(migration).toContain("'pending', count(*) filter");
    expect(migration).toContain("'expiring_soon', count(*) filter");
    expect(migration).toContain("'records', page_payload.records");
    expect(migration).toContain("coalesce(request_row.capability_scope -> 'permissions'");
    expect(migration).not.toContain("'capability_scope', page_row.capability_scope");
  });

  it('searches only bounded active tenant options and excludes approval authority', () => {
    expect(migration).toContain('char_length(normalized_search) not between 2 and 80');
    expect(migration).toContain("organization_row.status = 'ACTIVE'");
    expect(migration).toContain('result_limit not between 1 and 25');
    expect(migration).toContain("permission_row.permission_key <> 'support.approve'");
  });

  it('keeps every mutation on the existing audited Edge boundary', () => {
    expect(api).toContain("'support-session-request'");
    expect(api).toContain("'support-session-accept'");
    expect(api).toContain("'support-session-end'");
    expect(api).not.toContain(".from('support_access_requests').insert");
    expect(api).not.toContain(".from('support_sessions').update");
  });
});

describe('support workspace routing and query contract', () => {
  it('sanitizes and bounds page-local search values', () => {
    expect(toSupportSearchTerm('  Dealer %_ <script> /  ')).toBe('Dealer _ script /');
    expect(toSupportSearchTerm('x'.repeat(150))).toHaveLength(120);
  });

  it('parses only approved filters, sorts and page sizes', () => {
    const parsed = parseSupportWorkspaceQuery(
      new URLSearchParams('page=3&pageSize=50&status=active&sort=expires_asc&q=Dealer'),
    );
    expect(parsed).toEqual({
      page: 3,
      pageSize: 50,
      status: 'active',
      sort: 'expires_asc',
      search: 'Dealer',
    });
    expect(
      parseSupportWorkspaceQuery(
        new URLSearchParams('page=-1&pageSize=500&status=unknown&sort=raw'),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      status: 'all',
      sort: 'created_desc',
      search: '',
    });
  });

  it('serializes stable query state without defaults', () => {
    expect(
      toSupportWorkspaceQueryString({
        page: 2,
        pageSize: 25,
        status: 'pending',
        sort: 'created_desc',
        search: 'Acme',
      }),
    ).toBe('page=2&q=Acme&status=pending');
  });

  it('routes only the approved role pages to the production workspace', () => {
    expect(route).toContain("role === 'super-admin' && slug[0] === 'support-sessions'");
    expect(route).toContain('role="super-admin"');
    expect(route).toContain("role === 'business-owner' && slug[0] === 'support-maintenance'");
    expect(route).toContain('role="business-owner"');
  });

  it('uses TanStack Table, shadcn primitives and private realtime invalidation', () => {
    expect(workspace).toContain('useReactTable');
    expect(workspace).toContain('@/components/ui/dialog');
    expect(workspace).toContain('@/components/ui/table');
    expect(workspace).toContain('usePlatformRealtimeInvalidation');
    expect(workspace).toContain('useTenantRealtimeInvalidation');
    expect(workspace).not.toContain('demo-page-repository');
  });
});
