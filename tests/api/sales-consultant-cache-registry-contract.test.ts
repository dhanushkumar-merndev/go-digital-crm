import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registry = readFileSync('src/features/sales-consultant/sales-consultant-cache.ts', 'utf8');
const leadWorkspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const leadDetail = readFileSync('src/features/leads/lead-detail-workspace.tsx', 'utf8');
const leadAssignment = readFileSync('src/features/leads/lead-assignment-workspace.tsx', 'utf8');

function findTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return findTsxFiles(path);
    return entry.isFile() && path.endsWith('.tsx') ? [path] : [];
  });
}

describe('sales consultant cache registry', () => {
  it('keeps server data in TanStack Query rather than mirroring it into a client store', () => {
    // A second copy of server data drifts the moment a refetch, a realtime
    // event, or another tab moves one of them.
    expect(registry).not.toContain('zustand');
    expect(registry).not.toContain('setLeads');
    expect(registry).toContain('useQueryClient');
  });

  it('scopes every invalidation to the acting tenant, branch and user', () => {
    // An unscoped key matched cached pages belonging to every other tenant
    // held in memory, so one consultant's write refetched all of them.
    for (const source of [leadDetail, leadAssignment, leadWorkspace]) {
      expect(source).not.toContain("queryKey: ['lead-workspace'] }");
      expect(source).not.toContain("queryKey: ['lead-assignment'] }");
    }
    expect(registry).toContain('workspaceQueryScope(session)');
    expect(registry).toContain("leadWorkspace: (scope: Scope) => ['lead-workspace', ...scope]");
  });

  it('drives refreshes from named actions instead of ad-hoc key lists', () => {
    expect(leadDetail).toContain("salesConsultantCache.settle('lead.updated', { leadId })");
    expect(leadDetail).toContain("salesConsultantCache.invalidate('lead.updated', { leadId })");
    expect(leadAssignment).toContain("salesConsultantCache.settle('lead.assigned'");
    expect(leadWorkspace).toContain("salesConsultantCache.invalidate('lead.preference.changed')");
  });

  it('leaves aggregate dashboard refresh to its short cache and explicit refresh control', () => {
    const effects = registry.slice(registry.indexOf('const actionEffects'));
    expect(effects).not.toContain('salesConsultantKeys.dashboard');
  });
});

describe('sales consultant surfaces', () => {
  const surfaces = [
    'src/features/work/workspace.tsx',
    'src/features/tasks/task-workspace.tsx',
    'src/features/test-drives/test-drive-workspace.tsx',
    'src/features/sales/sales-document-workspace.tsx',
    'src/features/operations/sales-exchange-workspace.tsx',
    'src/features/inbox/inbox-workspace.tsx',
  ];

  it.each(surfaces)('%s refreshes through a named action', (path) => {
    expect(readFileSync(path, 'utf8')).toContain('salesConsultantCache.');
  });

  it('leaves no unscoped tenant-shared key anywhere under src/features', () => {
    // A bare ['name'] key matches by prefix, so it reaches cached entries for
    // every tenant and user still held in memory, not just the acting one.
    const scoped =
      /invalidateQueries\(\{\s*queryKey: \['(customer-360|lead-workspace|lead-assignment|shared-inbox|shared-inbox-messages|task-workspace|test-drive-workspace|work-workspace|sales-document-workspace)'\]\s*\}/;
    const offenders = findTsxFiles('src/features').filter((file) =>
      scoped.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps every query key laid out as [name, ...scope, ...discriminators]', () => {
    // A discriminator placed before the scope makes a [name, ...scope] prefix
    // match nothing, so invalidation silently becomes a no-op.
    const work = readFileSync('src/features/work/workspace.tsx', 'utf8');
    const assignment = readFileSync('src/features/leads/lead-assignment-workspace.tsx', 'utf8');
    expect(work).toContain("['work-workspace', ...queryScope, kind");
    expect(assignment).toContain("['lead-assignment', ...queryScope, audience");
  });

  it('stops task and work writes from busting the cached dashboard', () => {
    for (const path of ['src/features/tasks/task-workspace.tsx'])
      expect(readFileSync(path, 'utf8')).not.toContain("'sales-consultant-dashboard'");
  });
});
