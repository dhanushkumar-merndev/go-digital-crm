import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const header = readFileSync('src/components/shared/app-header.tsx', 'utf8');

describe('Quick add lead dialog', () => {
  it('routes both front-line roles into their own lead workspace', () => {
    expect(header).toContain("role === 'sales-consultant' || role === 'telecaller'");
    expect(header).toContain('router.push(`/${role}/${item.slug}?action=create`)');
  });

  it('keeps the create request while Sales Consultant defaults are applied', () => {
    expect(workspace).toContain("const createRequested = searchParams.get('action') === 'create';");
    expect(workspace).toContain("if (createRequested) params.set('action', 'create');");
    expect(workspace).toContain('const createDialogOpen = createOpen || createRequested;');
  });

  it('clears the create request only when the dialog is closed', () => {
    expect(workspace).toContain("nextParams.delete('action');");
    expect(workspace).toContain('open={createDialogOpen}');
    expect(workspace).toContain('open ? setCreateOpen(true) : closeCreateDialog()');
  });
});
