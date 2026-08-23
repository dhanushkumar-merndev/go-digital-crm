import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}
const migration = source('supabase/migrations/202608220029_master_data_workspace.sql');
const api = source('src/features/administration/master-data-workspace-api.ts');
const workspace = source('src/features/administration/master-data-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('master data workspace contract', () => {
  it('uses scoped server pagination for actual model, brand, and lead-source records', () => {
    expect(migration).toContain('get_master_data_workspace');
    expect(migration).toContain("('MODELS', 'BRANDS', 'LEAD_SOURCES')");
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain("'integration.manage'");
  });
  it('makes activation changes through an audited server-side mutation', () => {
    expect(migration).toContain('set_master_data_active');
    expect(migration).toContain("'master_data.active_changed'");
    expect(api).toContain("rpc('set_master_data_active'");
    expect(workspace).toContain('The status change is recorded in the audit log.');
  });
  it('routes System Administrator master-data navigation to the real workspace', () => {
    expect(route).toContain("slug[0] === 'master-data'");
    expect(route).toContain('MasterDataWorkspace');
  });
});
