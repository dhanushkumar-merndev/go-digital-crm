import { describe, expect, it } from 'vitest';
import {
  customerCareInitialView,
  customerCareNextStatuses,
  isCustomerCareVersionConflict,
  parseCustomerCareQuery,
  toCustomerCareQueryString,
} from '../../src/features/customer-care/customer-care-query';

describe('customer-care route and query boundary', () => {
  it('maps the approved Customer Care routes to scoped views', () => {
    expect(customerCareInitialView('dashboard')).toBe('OPEN');
    expect(customerCareInitialView('feedback')).toBe('FEEDBACK');
    expect(customerCareInitialView('reviews')).toBe('REVIEW_REQUEST');
    expect(customerCareInitialView('complaints-escalations')).toBe('COMPLAINT');
    expect(customerCareInitialView('unknown')).toBeNull();
  });

  it('bounds server pagination, page-local search, view and sort', () => {
    expect(
      parseCustomerCareQuery(
        new URLSearchParams(`page=-4&pageSize=500&view=unsafe&q=${'a'.repeat(220)}&sort=unsafe`),
        'OPEN',
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      view: 'OPEN',
      search: 'a'.repeat(160),
      sort: 'updated:desc',
    });
  });

  it('serializes only meaningful page-local state', () => {
    expect(
      toCustomerCareQueryString(
        {
          page: 2,
          pageSize: 50,
          view: 'SLA_RISK',
          search: 'CC-1002',
          sort: 'sla:asc',
        },
        'OPEN',
      ),
    ).toBe('page=2&pageSize=50&view=SLA_RISK&q=CC-1002&sort=sla%3Aasc');
  });
});

describe('customer-care lifecycle boundary', () => {
  it('allows only explicit forward resolution flow', () => {
    expect(customerCareNextStatuses('ASSIGNED')).toEqual(['IN_PROGRESS']);
    expect(customerCareNextStatuses('CUSTOMER_CONTACTED')).toEqual(['IN_PROGRESS', 'RESOLVED']);
    expect(customerCareNextStatuses('CLOSED')).toEqual([]);
  });

  it('recognizes only optimistic concurrency errors', () => {
    expect(isCustomerCareVersionConflict({ code: '40001' })).toBe(true);
    expect(isCustomerCareVersionConflict({ message: 'CUSTOMER_CARE_VERSION_CONFLICT' })).toBe(true);
    expect(isCustomerCareVersionConflict(new Error('network unavailable'))).toBe(false);
  });
});
