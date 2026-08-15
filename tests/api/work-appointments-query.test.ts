import { describe, expect, it } from 'vitest';
import { isUuid, parseWorkQuery, toWorkQueryString } from '../../src/features/work/workspace-query';

describe('work workspace query boundary', () => {
  it('accepts only bounded pagination, filters, UUID scopes, and whitelisted sorting', () => {
    expect(
      parseWorkQuery(
        new URLSearchParams(
          'page=-2&pageSize=1000&status=drop-table&sort=random&branch=not-a-uuid&q=%20%20Ravi%20%20',
        ),
        'followups',
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      search: 'Ravi',
      status: 'all',
      priority: 'all',
      appointmentType: 'all',
      branchId: 'all',
      teamId: 'all',
      ownerId: 'all',
      sort: 'scheduled:asc',
    });
  });

  it('keeps follow-up and appointment filter vocabularies separate', () => {
    expect(parseWorkQuery(new URLSearchParams('status=overdue'), 'followups').status).toBe(
      'overdue',
    );
    expect(parseWorkQuery(new URLSearchParams('status=overdue'), 'appointments').status).toBe(
      'all',
    );
    expect(parseWorkQuery(new URLSearchParams('status=no-show'), 'appointments').status).toBe(
      'no-show',
    );
  });

  it('preserves meaningful page-local URL state', () => {
    const branchId = '123e4567-e89b-42d3-a456-426614174000';
    const ownerId = '223e4567-e89b-42d3-a456-426614174001';
    expect(
      toWorkQueryString({
        page: 3,
        pageSize: 50,
        search: '9876543210',
        status: 'today',
        priority: 'HIGH',
        appointmentType: 'all',
        branchId,
        teamId: 'all',
        ownerId,
        sort: 'customer:asc',
      }),
    ).toBe(
      `page=3&pageSize=50&q=9876543210&status=today&priority=HIGH&branch=${branchId}&owner=${ownerId}&sort=customer%3Aasc`,
    );
  });

  it('treats only canonical UUIDs as resource identifiers', () => {
    expect(isUuid('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isUuid('9876543210')).toBe(false);
  });
});
