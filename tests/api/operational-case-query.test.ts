import { describe, expect, it } from 'vitest';
import {
  isOperationalCaseVersionConflict,
  operationalCaseNextStatuses,
  operationalCaseRoute,
  parseOperationalCaseQuery,
  toOperationalCaseQueryString,
} from '../../src/features/operations/operational-case-query';

describe('operational case route and query boundary', () => {
  it('maps only the approved department routes', () => {
    expect(operationalCaseRoute('finance', 'finance-cases')).toMatchObject({
      department: 'FINANCE',
      initialStatus: 'OPEN',
    });
    expect(operationalCaseRoute('delivery', 'pending-checklist')).toMatchObject({
      department: 'DELIVERY',
      initialStatus: 'CHECKLIST_PENDING',
    });
    expect(operationalCaseRoute('finance', 'dashboard')).toMatchObject({
      department: 'FINANCE',
      initialStatus: 'OPEN',
    });
    expect(operationalCaseRoute('sales-consultant', 'exchange')).toMatchObject({
      department: 'EXCHANGE',
      canOriginateRequest: true,
    });
    expect(operationalCaseRoute('sales-consultant', 'finance-cases')).toBeNull();
  });

  it('bounds pagination, dates, text and sorting', () => {
    expect(
      parseOperationalCaseQuery(
        new URLSearchParams(
          `page=-1&pageSize=1000&status=${'X'.repeat(60)}&q=${'a'.repeat(200)}` +
            '&from=2026-02-30&to=2025-01-01&sort=unsafe',
        ),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      status: 'OPEN',
      search: 'a'.repeat(160),
      fromDate: '',
      toDate: '2025-01-01',
      sort: 'updated:desc',
    });
  });

  it('serializes only meaningful page-local state', () => {
    expect(
      toOperationalCaseQueryString({
        page: 2,
        pageSize: 50,
        status: 'APPROVED',
        search: 'BK-1002',
        fromDate: '2026-08-01',
        toDate: '2026-08-15',
        sort: 'due:asc',
      }),
    ).toBe(
      'page=2&pageSize=50&status=APPROVED&q=BK-1002&from=2026-08-01&to=2026-08-15&sort=due%3Aasc',
    );
  });
});

describe('operational case lifecycle vocabulary', () => {
  it('allows only explicit forward or terminal transitions', () => {
    expect(operationalCaseNextStatuses('FINANCE', 'UNDER_REVIEW')).toEqual([
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ]);
    expect(operationalCaseNextStatuses('DELIVERY', 'SCHEDULED')).toEqual([
      'DELIVERED',
      'CANCELLED',
    ]);
    expect(operationalCaseNextStatuses('RTO', 'REGISTERED')).toEqual([]);
  });

  it('recognizes optimistic concurrency errors without treating arbitrary failures as conflicts', () => {
    expect(isOperationalCaseVersionConflict({ code: '40001' })).toBe(true);
    expect(
      isOperationalCaseVersionConflict({ message: 'DELIVERY_CHECKLIST_VERSION_CONFLICT' }),
    ).toBe(true);
    expect(isOperationalCaseVersionConflict(new Error('network unavailable'))).toBe(false);
  });
});
