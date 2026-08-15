import { describe, expect, it } from 'vitest';
import {
  isTestDriveVersionConflict,
  parseTestDriveQuery,
  TestDriveVersionConflictError,
  testDriveViewValue,
  toTestDriveQueryString,
} from '../../src/features/test-drives/test-drive-workspace-query';

describe('test-drive URL boundary', () => {
  it('accepts only bounded pagination, dates, views and sorts', () => {
    expect(
      parseTestDriveQuery(
        new URLSearchParams(
          'page=-8&pageSize=1000&view=all&sort=random&q=%20%20Ravi%20%20&model=Altroz&from=2026-02-31&to=tomorrow',
        ),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      view: 'today',
      search: 'Ravi',
      model: 'Altroz',
      fromDate: '',
      toDate: '',
      sort: 'scheduled:asc',
    });
  });

  it('preserves meaningful server filter state and canonicalizes the RPC view', () => {
    expect(
      toTestDriveQueryString({
        page: 3,
        pageSize: 50,
        view: 'completed',
        search: '9876543210',
        model: 'Nexon EV',
        fromDate: '2026-08-01',
        toDate: '2026-08-15',
        sort: 'updated:desc',
      }),
    ).toBe(
      'page=3&pageSize=50&view=completed&q=9876543210&model=Nexon+EV&from=2026-08-01&to=2026-08-15&sort=updated%3Adesc',
    );
    expect(testDriveViewValue('active')).toBe('ACTIVE');
  });

  it('drops an inverted end date before it reaches the SQL boundary', () => {
    expect(parseTestDriveQuery(new URLSearchParams('from=2026-08-15&to=2026-08-01')).toDate).toBe(
      '',
    );
  });

  it('recognizes only optimistic concurrency failures', () => {
    expect(isTestDriveVersionConflict(new TestDriveVersionConflictError())).toBe(true);
    expect(
      isTestDriveVersionConflict({ code: '40001', message: 'TEST_DRIVE_VERSION_CONFLICT' }),
    ).toBe(true);
    expect(isTestDriveVersionConflict({ code: '42501', message: 'TEST_DRIVE_SCOPE_DENIED' })).toBe(
      false,
    );
  });
});
