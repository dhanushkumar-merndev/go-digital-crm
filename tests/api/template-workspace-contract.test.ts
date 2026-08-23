import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220028_template_management_workspace.sql');
const api = source('src/features/administration/template-workspace-api.ts');
const workspace = source('src/features/administration/template-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('template management workspace contract', () => {
  it('uses tenant-scoped, server-side pagination and management permission', () => {
    expect(migration).toContain('get_template_workspace');
    expect(migration).toContain("'integration.manage'");
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('deleted_at is null');
    expect(migration).toContain('enable row level security');
  });

  it('keeps new local templates as drafts and archives instead of hard-deleting', () => {
    expect(migration).toContain('create_draft_template');
    expect(migration).toContain("'DRAFT'");
    expect(migration).toContain('archive_template');
    expect(migration).toContain('action, resource_type, resource_id');
    expect(migration).toContain("'template.archived'");
  });

  it('provides typed RPC access and an administrator templates route', () => {
    expect(api).toContain("rpc('get_template_workspace'");
    expect(api).toContain("rpc('create_draft_template'");
    expect(api).toContain("rpc('archive_template'");
    expect(workspace).toContain('Provider approval is intentionally not implied');
    expect(route).toContain("slug[0] === 'templates'");
    expect(route).toContain('TemplateWorkspace');
  });
});
