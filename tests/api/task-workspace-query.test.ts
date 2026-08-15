import { describe, expect, it } from 'vitest';
import {
  isTaskVersionConflict,
  parseTaskQuery,
  TaskVersionConflictError,
  taskStatusValue,
  toTaskQueryString,
} from '../../src/features/tasks/task-workspace-query';

describe('task URL boundary', () => {
  it('accepts only bounded pagination and allowlisted filters', () => {
    expect(
      parseTaskQuery(
        new URLSearchParams(
          'page=-2&pageSize=500&status=drop-table&priority=critical&sort=random&q=%20%20Ravi%20%20',
        ),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      search: 'Ravi',
      status: 'all',
      priority: 'all',
      sort: 'due:asc',
    });
  });

  it('preserves meaningful state and canonicalizes derived filters', () => {
    expect(
      toTaskQueryString({
        page: 3,
        pageSize: 50,
        search: '9876543210',
        status: 'in-progress',
        priority: 'HIGH',
        sort: 'priority:desc',
      }),
    ).toBe('page=3&pageSize=50&q=9876543210&status=in-progress&priority=HIGH&sort=priority%3Adesc');
    expect(taskStatusValue('in-progress')).toBe('IN_PROGRESS');
    expect(taskStatusValue('all')).toBe('ALL');
  });

  it('recognizes only optimistic concurrency failures', () => {
    expect(isTaskVersionConflict(new TaskVersionConflictError())).toBe(true);
    expect(isTaskVersionConflict({ code: '40001', message: 'TASK_VERSION_CONFLICT' })).toBe(true);
    expect(isTaskVersionConflict({ code: '42501', message: 'TASK_SCOPE_DENIED' })).toBe(false);
  });
});
