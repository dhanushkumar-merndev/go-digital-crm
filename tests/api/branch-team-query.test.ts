import { describe, expect, it } from 'vitest';
import {
  parseAdministrationQuery,
  toAdministrationQueryString,
  type AdministrationQuery,
} from '../../src/features/administration/branch-team-query';

const branchId = '0198c5d0-a3e7-7a31-9ab1-f12e50a0a991';

describe('branch and team workspace query contract', () => {
  it('uses bounded production defaults for invalid branch input', () => {
    const query = parseAdministrationQuery(
      new URLSearchParams(
        'page=-1&pageSize=1000&status=deleted&sort=members%3Adesc&branch=unsafe&q=%20North%20',
      ),
      'branches',
    );
    expect(query).toEqual({
      page: 1,
      pageSize: 25,
      search: 'North',
      status: 'ALL',
      branchId: 'all',
      sort: 'updated:desc',
    });
  });

  it('accepts only team-specific filters, paging, and sorts', () => {
    const query = parseAdministrationQuery(
      new URLSearchParams(
        `page=3&pageSize=100&status=INACTIVE&sort=members%3Adesc&branch=${branchId}`,
      ),
      'teams',
    );
    expect(query).toMatchObject({
      page: 3,
      pageSize: 100,
      status: 'INACTIVE',
      sort: 'members:desc',
      branchId,
    });
  });

  it('serializes only non-default API state', () => {
    const query: AdministrationQuery = {
      page: 2,
      pageSize: 50,
      search: 'Central',
      status: 'ACTIVE',
      branchId,
      sort: 'name:asc',
    };
    expect(toAdministrationQueryString(query)).toBe(
      `page=2&pageSize=50&q=Central&status=ACTIVE&branch=${branchId}&sort=name%3Aasc`,
    );
    expect(
      toAdministrationQueryString({
        page: 1,
        pageSize: 25,
        search: '',
        status: 'ALL',
        branchId: 'all',
        sort: 'updated:desc',
      }),
    ).toBe('');
  });

  it('caps page-local search input at the backend contract limit', () => {
    const query = parseAdministrationQuery(new URLSearchParams(`q=${'a'.repeat(300)}`), 'teams');
    expect(query.search).toHaveLength(160);
  });
});
