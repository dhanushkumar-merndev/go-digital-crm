import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const workspace = source('src/features/tasks/task-workspace.tsx');
const dialogs = source('src/features/tasks/task-workspace-dialogs.tsx');
const dashboard = source('src/features/dashboards/sales-consultant-dashboard.tsx');
const leads = source('src/features/leads/lead-workspace.tsx');
const providers = source('src/components/providers/app-providers.tsx');

describe('task workspace interaction contract', () => {
  it('keeps raw typing local and debounces both the bounded API search and URL update', () => {
    expect(workspace).toContain('const [searchInput, setSearchInput] = useState(query.search)');
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain('() => ({ ...query, search: debouncedSearch })');
    expect(workspace).toContain('toTaskQueryString(requestQuery)');
    expect(workspace).toContain('value={searchInput}');
    expect(workspace).toContain('maxLength={160}');
    expect(workspace).toContain('onSearchChange(event.target.value)');
    expect(workspace).toContain('pointer-events-none absolute left-3');

    const rawSearchHandler = workspace.slice(
      workspace.indexOf('const onSearchChange ='),
      workspace.indexOf('const invalidate =', workspace.indexOf('const onSearchChange =')),
    );
    expect(rawSearchHandler).toContain('setSearchInput(value)');
    expect(rawSearchHandler).not.toContain('router.replace');
    expect(rawSearchHandler).not.toContain('fetchTaskWorkspace');
  });

  it('wires priority, sort, page size, status tabs and pagination to server query state', () => {
    expect(workspace).toContain('aria-label="Filter by priority"');
    expect(workspace).toContain("priority: priority as TaskQuery['priority'], page: 1");
    expect(workspace).toContain('All priorities');
    expect(workspace).toContain('aria-label="Sort tasks"');
    expect(workspace).toContain("sort: sort as TaskQuery['sort'], page: 1");
    expect(workspace).toContain('aria-label="Rows per page"');
    expect(workspace).toContain('pageSize: Number(value) as 25 | 50 | 100, page: 1');
    // The status tabs moved into TaskStatusTabs (below the KPIs, with counts),
    // so they report selection as a tablist rather than a pressed button. The
    // KPI cards are the remaining aria-pressed toggles and filter the same way.
    expect(workspace).toContain('aria-pressed={active}');
    expect(workspace).toContain('aria-selected={active}');
    expect(workspace).toContain('onStatusChange={(status) => onQueryChange({ status, page: 1 })}');
    expect(workspace).toContain('onQueryChange({ page: query.page - 1 })');
    expect(workspace).toContain('onQueryChange({ page: query.page + 1 })');
  });

  it('uses keyboard-and-pointer safe row actions and remounts a fresh create form', () => {
    expect(workspace).toContain('aria-label={`Actions for ${row.original.title}`}');
    expect(workspace).toContain('onSelect={() => onEdit(row.original)}');
    expect(workspace).toContain("onSelect={() => onAction('complete', row.original)}");
    expect(workspace).toContain("onSelect={() => onAction('cancel', row.original)}");
    expect(workspace).not.toMatch(/DropdownMenuItem onClick/);
    expect(workspace).toContain('permissions.canCreate && createOpen &&');
    expect(workspace).toContain('initialLead={createContext}');
    expect(workspace).toContain('if (!open) setCreateContext(null)');
  });
});

describe('task mutation feedback and cache linkage', () => {
  it('keeps mutation requests idempotent, clears stale errors on edits and blocks dismissal while saving', () => {
    expect(
      dialogs.match(/requestId\.current \?\?= globalThis\.crypto\.randomUUID\(\)/g),
    ).toHaveLength(2);
    expect(dialogs.match(/mutation\.reset\(\)/g)).toHaveLength(2);
    expect(dialogs.match(/if \(!mutation\.isPending\) onOpenChange\(nextOpen\)/g)).toHaveLength(2);
    expect(dialogs).toContain('Customer opportunities could not be loaded.');
    expect(dialogs).toContain('No authorized active opportunities match this search.');
    expect(dialogs).toContain('onClick={() => void options.refetch()}');
    expect(dialogs).toContain("title: 'Choose a future due date'");
    expect(dialogs).toContain('A new task cannot be scheduled in the past.');
  });

  it('refreshes the task list and customer timeline through one action', () => {
    expect(workspace).toContain("salesConsultantCache.invalidate('task.changed')");
    const registry = readFileSync(
      'src/features/sales-consultant/sales-consultant-cache.ts',
      'utf8',
    );
    const effect = registry.slice(registry.indexOf("'task.changed'"));
    for (const key of ['taskWorkspace', 'customer360'])
      expect(effect).toContain(`salesConsultantKeys.${key}(scope)`);
  });

  it('refreshes the live dashboard task alert after a task write', () => {
    // The dashboard retains its aggregate cache, but attaches the task count
    // live. Invalidating its in-memory query makes that alert agree with Tasks.
    const registry = readFileSync(
      'src/features/sales-consultant/sales-consultant-cache.ts',
      'utf8',
    );
    const effect = registry.slice(registry.indexOf("'task.changed'"));
    expect(effect).toContain('salesConsultantKeys.dashboard(scope)');
  });

  it('keeps dashboard task links pointed at the Today task filter', () => {
    expect(dashboard).toContain("label: 'Tasks due today'");
    expect(dashboard).toContain("href: '/sales-consultant/tasks?status=today'");
    expect(dashboard).toContain('<Link href="/sales-consultant/tasks">');
  });

  it('opens a lead-linked task form with the selected customer locked in place', () => {
    expect(leads).toContain('aria-label={`Create task for ${row.original.customer_name}`}');
    expect(leads).toContain('/tasks?action=create&lead=${encodeURIComponent(row.original.id)}');
    expect(workspace).toContain('taskCreateContextFromUrl(searchParams)');
    expect(workspace).toContain('initialLead={createContext}');
    expect(dialogs).toContain('initialLead?:');
    expect(dialogs).toContain('enabled: open && !record && !initialLead');
  });

  it('uses the shared toast feedback for successful and failed mutations', () => {
    expect(providers).toContain('new MutationCache');
    expect(providers).toContain("type: 'success'");
    expect(providers).toContain("type: 'error'");
    expect(providers).toContain("title: 'Saved successfully'");
    expect(providers).toContain("title: 'Could not save changes'");
  });
});
