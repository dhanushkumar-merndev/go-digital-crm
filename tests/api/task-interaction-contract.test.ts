import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const workspace = source('src/features/tasks/task-workspace.tsx');
const dialogs = source('src/features/tasks/task-workspace-dialogs.tsx');
const taskCenter = source('src/features/tasks/task-center-sheet.tsx');
const dashboard = source('src/features/dashboards/sales-consultant-dashboard.tsx');

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
    expect(workspace).toContain('aria-pressed={active}');
    expect(workspace).toContain('onQueryChange({ status: value, page: 1 })');
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
    expect(workspace).toContain('<TaskFormDialog open onOpenChange={setCreateOpen}');
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
  });

  it('invalidates the task list, task center, customer timeline and scoped dashboard', () => {
    for (const key of [
      "['task-workspace', ...queryScope]",
      "['task-center', ...queryScope]",
      "['customer-360']",
      "['sales-consultant-dashboard', ...queryScope]",
    ]) {
      expect(workspace).toContain(key);
      expect(taskCenter).toContain(key);
    }
  });

  it('keeps Task Center live, retryable and idempotent for one-click completion', () => {
    expect(taskCenter).toContain("resource: 'work'");
    expect(taskCenter).toContain("queryKeys: [['task-center', ...queryScope]]");
    expect(taskCenter).toContain(
      'const completeRequest = useRef<{ key: string; requestId: string } | null>(null)',
    );
    expect(taskCenter).toContain('completeRequest.current?.key !== key');
    expect(taskCenter).toContain('requestId: completeRequest.current.requestId');
    expect(taskCenter).toContain('complete.variables?.id === record.id');
    expect(taskCenter).toContain('void taskPage.refetch()');
    expect(taskCenter).toContain('aria-pressed={status === tab.value}');
  });

  it('keeps dashboard task links pointed at the Today task filter', () => {
    expect(dashboard).toContain("label: 'Tasks due today'");
    expect(dashboard).toContain("href: '/sales-consultant/tasks?status=today'");
    expect(dashboard).toContain('<Link href="/sales-consultant/tasks">');
  });
});
