import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608240008_optimize_audit_log_cursor.sql',
  'utf8',
);
const api = readFileSync('src/features/administration/audit-log-api.ts', 'utf8');
const rpc = readFileSync('supabase/migrations/202610050004_audit_log_page_rpc.sql', 'utf8');
const securityApi = readFileSync('src/features/administration/security-workspace-api.ts', 'utf8');

describe('audit log scale contract', () => {
  it('supports both platform cursor order and the two bounded substring filters', () => {
    expect(migration.match(/create index concurrently if not exists/g)).toHaveLength(3);
    expect(migration).toContain(
      'audit_logs_global_cursor_idx\n  on public.audit_logs (created_at desc, id desc)',
    );
    expect(migration).toContain(
      'audit_logs_action_trgm_idx\n  on public.audit_logs using gin (action gin_trgm_ops)',
    );
    expect(migration).toContain(
      'audit_logs_resource_type_trgm_idx\n  on public.audit_logs using gin (resource_type gin_trgm_ops)',
    );
  });

  it('uses stable keyset pagination instead of OFFSET', () => {
    // Paging, ordering and LIKE escaping run inside get_audit_log_page.
    expect(rpc).toContain('order by log_row.created_at desc, log_row.id desc');
    expect(rpc).toContain('or (log_row.created_at = cursor_created_at and log_row.id < cursor_id)');
    expect(rpc).not.toMatch(/\boffset\b/i);
    expect(api).not.toContain('.range(');
    expect(api).toContain('cursor_id: input.cursor ? Number(input.cursor.id) : null');
    expect(rpc).toContain("'%', '\\%'");
    expect(rpc).toContain("'_', '\\_'");
  });

  it('keeps BIGINT audit identities as strings in both audit consumers', () => {
    for (const source of [api, securityApi]) {
      expect(source).toContain('z.string().regex(/^[1-9]\\d*$/)');
      expect(source).toContain('Number.isSafeInteger');
      expect(source).toContain('.transform(String)');
    }
  });
});
