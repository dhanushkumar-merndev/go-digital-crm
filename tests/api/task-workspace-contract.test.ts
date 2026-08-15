import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/202608150026_tasks_workspace.sql');
const workspace = source('src/features/tasks/task-workspace.tsx');
const dialogs = source('src/features/tasks/task-workspace-dialogs.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');
const pageSpecs = source('src/config/page-specs.ts');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('task read and integrity boundary', () => {
  it('adds dedicated permissions, contextual tenant keys, read RLS, and closes direct writes', () => {
    for (const permission of [
      'task.view',
      'task.create',
      'task.update',
      'task.complete',
      'task.cancel',
      'task.assign',
    ])
      expect(migration).toContain(`'${permission}'`);
    expect(migration).toContain('tasks_branch_org_fk');
    expect(migration).toContain('tasks_team_branch_org_fk');
    expect(migration).toContain('tasks_lead_org_fk');
    expect(migration).toContain('tasks_customer_org_fk');
    expect(migration).toContain('create policy tasks_read');
    expect(migration).toContain('revoke insert, update, delete on public.tasks');
  });

  it('uses bounded server pagination, page-local search, stable sort and one KPI bundle', () => {
    const list = section(
      'create or replace function public.get_task_workspace_page(',
      'create or replace function public.get_task_lead_options(',
    );
    expect(list).toContain('target_page_size not in (25, 50, 100)');
    expect(list).toContain('INVALID_TIMEZONE');
    expect(list).toContain('app_private.can_access_record(');
    expect(list).toContain('app_private.can_access_lead(task_row.lead_id)');
    expect(list).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
    expect(list).toContain("'kpis', jsonb_build_object(");
    expect(list).not.toMatch(/select\s+\*\s+from\s+public\.tasks/i);
  });

  it('returns only 25 accessible lead options instead of loading the tenant', () => {
    const options = section(
      'create or replace function public.get_task_lead_options(',
      'create or replace function public.create_task(',
    );
    expect(options).toContain('target_limit not between 1 and 25');
    expect(options).toContain('app_private.can_access_record(');
    expect(options).toContain('limit target_limit');
  });
});

describe('task mutation boundary', () => {
  it('ships focused create/edit/complete/cancel RPCs with optimistic versions and idempotency', () => {
    for (const functionName of ['create_task', 'update_task', 'complete_task', 'cancel_task']) {
      expect(migration).toContain(`create or replace function public.${functionName}(`);
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}\\(`),
      );
    }
    expect(migration).toContain('app_private.replay_work_request(');
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(migration).toContain('TASK_VERSION_CONFLICT');
    expect(migration).toContain('TASK_TERMINAL');
  });

  it('keeps assignment/context immutable, validates patches, and audits every state change', () => {
    const update = section(
      'create or replace function public.update_task(',
      'create or replace function public.complete_task(',
    );
    expect(update).toContain(
      "task_patch - array['title', 'description', 'priority', 'status', 'due_at']",
    );
    expect(update).not.toContain("'assigned_user_id'");
    expect(migration.match(/insert into public\.audit_logs/g)?.length).toBe(4);
    expect(migration.match(/insert into public\.activities/g)?.length).toBe(3);
    expect(migration).toContain("'task.created'");
    expect(migration).toContain("'task.updated'");
    expect(migration).toContain("'task.completed'");
    expect(migration).toContain("'task.cancelled'");
  });

  it('uses soft terminal states and never hard-deletes task business data', () => {
    expect(migration).toContain("set status = 'COMPLETED'");
    expect(migration).toContain("set status = 'CANCELLED'");
    expect(migration).not.toMatch(/delete\s+from\s+public\.tasks/i);
  });
});

describe('task web contract', () => {
  it('uses shadcn, TanStack Query/Table, 300ms search and private work invalidation', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain('manualPagination: true');
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain("resource: 'work'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(dialogs).toContain("from '@/components/ui/dialog'");
    expect(`${workspace}\n${dialogs}`).not.toMatch(/recharts|chart\.js|apexcharts|@mui/i);
  });

  it('wires only the two requested frontline task routes in configured mode', () => {
    expect(pageSpecs).toContain("if (slug === 'tasks') return 'tasks'");
    expect(route).toContain("slug[0] === 'tasks'");
    expect(route).toContain("role === 'telecaller' || role === 'sales-consultant'");
    expect(route).toContain('<TaskWorkspace spec={spec} role={role} />');
    expect(route.indexOf("slug[0] === 'tasks'")).toBeLessThan(
      route.indexOf('if (!isLocalPreviewMode()) return <ProductionDataUnavailable />'),
    );
  });
});
