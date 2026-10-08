import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const api = source('src/features/administration/audit-log-api.ts');
const workspace = source('src/features/administration/audit-log-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');
const migration = source('supabase/migrations/202610050004_audit_log_page_rpc.sql');

describe('audit log workspace data contract', () => {
  it('reads a narrow, scope-checked audit-log page rather than an unbounded dataset', () => {
    // Direct table reads ran the RLS helpers once per row: 12 s for 8 rows.
    expect(api).toContain("rpc('get_audit_log_page'");
    expect(api).not.toContain(".from('audit_logs')");
    expect(api).toContain('page_limit: pageSize + 1');
    expect(migration).toContain(
      'returns table (\n  id bigint,\n  action text,\n  resource_type text,\n  resource_id text,\n  actor_id uuid,\n  branch_id uuid,\n  metadata jsonb,\n  created_at timestamptz\n)',
    );
    expect(migration).toContain('least(greatest(coalesce(page_limit, 26), 1), 201)');
  });

  it('uses stable keyset pagination and sanitised page-local filters', () => {
    expect(api).toContain('function filterValue(value: string)');
    expect(api).toContain('.slice(0, 80)');
    expect(api).toContain('cursor_created_at: input.cursor?.created_at ?? null');
    expect(migration).toContain('order by log_row.created_at desc, log_row.id desc');
    expect(migration).toContain(
      'or (log_row.created_at = cursor_created_at and log_row.id < cursor_id)',
    );
    expect(migration).toContain("'INVALID_AUDIT_CURSOR'");
    // LIKE wildcards in the filter are literal text, escaped server-side.
    expect(migration).toContain(
      "replace(replace(replace(action_term, '\\', '\\\\'), '%', '\\%'), '_', '\\_')",
    );
  });

  it('applies the same visibility as the audit_logs policies', () => {
    expect(migration).toContain(
      'app_private.is_platform_admin()\n    and app_private.mfa_policy_satisfied(null::uuid)',
    );
    expect(migration).toContain('app_private.mfa_policy_satisfied(candidate.organization_id)');
    expect(migration).toContain(
      "app_private.has_permission(candidate.organization_id, 'audit.view')",
    );
    expect(migration).toContain(
      'app_private.has_organization_wide_scope(readable.organization_id)',
    );
    expect(migration).toContain(
      'app_private.can_access_branch(branch_row.organization_id, branch_row.id)',
    );
    expect(migration).toContain('revoke all on function public.get_audit_log_page');
    expect(migration).toMatch(
      /grant execute on function public\.get_audit_log_page\([^)]*\)\s+to authenticated;/,
    );
  });

  it('validates records before they enter the browser state', () => {
    expect(api).toContain('const auditLogSchema = z.object({');
    expect(api).toContain('const auditLogIdSchema = z.union([');
    expect(api).toContain('Number.isSafeInteger');
    expect(api).toContain('.transform(String)');
    expect(api).toContain('id: auditLogIdSchema');
    expect(api).not.toMatch(/^\s*id: z\.uuid\(\),$/m);
    expect(api).toContain('z.array(auditLogSchema).parse(data ?? [])');
  });
});

describe('audit log workspace UI contract', () => {
  it('debounces filters and keys each query by filters plus server cursor', () => {
    expect(workspace).toContain('useDebouncedValue(actionInput, 300)');
    expect(workspace).toContain('useDebouncedValue(resourceInput, 300)');
    expect(workspace).toContain('...workspaceQueryScope(session)');
    expect(workspace).toContain("'audit-log-page'");
    expect(workspace).toContain('cursor?.id ?? null');
    expect(workspace).toContain('cursor pagination');
  });

  it('renders security data in shadcn table primitives without exposing arbitrary metadata', () => {
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).toContain('function auditSummary(record: AuditLogRecord)');
    expect(workspace).toContain('record.metadata.safe_message');
    expect(workspace).not.toContain('JSON.stringify(record.metadata)');
  });

  it('exposes the real workspace only to the configured administrator routes', () => {
    expect(route).toContain("slug[0] === 'audit-logs'");
    expect(route).toContain("role === 'client-admin'");
    expect(route).toContain("role === 'system-administrator'");
    expect(route.indexOf('<AuditLogWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
