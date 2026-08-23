import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const api = source('src/features/administration/audit-log-api.ts');
const workspace = source('src/features/administration/audit-log-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('audit log workspace data contract', () => {
  it('reads a narrow, RLS-protected audit-log projection rather than an unbounded dataset', () => {
    expect(api).toContain(".from('audit_logs')");
    expect(api).toContain(
      ".select('id,action,resource_type,resource_id,actor_id,branch_id,metadata,created_at')",
    );
    expect(api).toContain('.limit(pageSize + 1)');
    expect(api).not.toContain(".select('*')");
  });

  it('uses stable keyset pagination and sanitised page-local filters', () => {
    expect(api).toContain('function filterValue(value: string)');
    expect(api).toContain('.slice(0, 80)');
    expect(api).toContain(".order('created_at', { ascending: false })");
    expect(api).toContain(".order('id', { ascending: false })");
    expect(api).toContain('created_at.lt.${input.cursor.created_at}');
    expect(api).toContain('id.lt.${input.cursor.id}');
    expect(api).toContain("request.ilike('action'");
    expect(api).toContain("request.ilike('resource_type'");
  });

  it('validates records before they enter the browser state', () => {
    expect(api).toContain('const auditLogSchema = z.object({');
    expect(api).toContain('z.array(auditLogSchema).parse(data ?? [])');
  });
});

describe('audit log workspace UI contract', () => {
  it('debounces filters and keys each query by filters plus server cursor', () => {
    expect(workspace).toContain('useDebouncedValue(actionInput, 300)');
    expect(workspace).toContain('useDebouncedValue(resourceInput, 300)');
    expect(workspace).toContain("['audit-log-page', action, resource, cursor?.created_at ?? null, cursor?.id ?? null]");
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
    expect(route.indexOf('<AuditLogWorkspace')).toBeLessThan(route.indexOf('<ProductionDataUnavailable'));
  });
});
