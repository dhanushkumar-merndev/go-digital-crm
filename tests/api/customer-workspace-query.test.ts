import { describe, expect, it } from 'vitest';
import {
  isCustomerUuid,
  parseCustomerQuery,
  toCustomerQueryString,
} from '../../src/features/customers/customer-workspace-query';

describe('customer workspace query boundary', () => {
  it('accepts only bounded server-pagination and sorting state', () => {
    expect(
      parseCustomerQuery(
        new URLSearchParams('page=-2&pageSize=1000&sort=drop-table&q=%20%20Ravi%20%20'),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      search: 'Ravi',
      sort: 'updated:desc',
    });
  });

  it('preserves meaningful URL state for page-local customer search', () => {
    expect(
      toCustomerQueryString({
        page: 3,
        pageSize: 50,
        search: '9876543210',
        sort: 'name:asc',
      }),
    ).toBe('page=3&pageSize=50&q=9876543210&sort=name%3Aasc');
  });

  it('accepts canonical UUID identifiers and rejects contact identifiers as IDs', () => {
    expect(isCustomerUuid('a63c5607-ff04-4d58-9ae8-51dc23c6f100')).toBe(true);
    expect(isCustomerUuid('9876543210')).toBe(false);
    expect(isCustomerUuid('ravi@example.test')).toBe(false);
  });
});
