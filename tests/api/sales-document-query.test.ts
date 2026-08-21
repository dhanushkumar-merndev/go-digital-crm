import { describe, expect, it } from 'vitest';
import {
  isSalesDocumentVersionConflict,
  parseSalesDocumentQuery,
  SalesDocumentVersionConflictError,
  salesStatusValue,
  toSalesDocumentQueryString,
} from '../../src/features/sales/sales-document-query';

describe('quotation and booking URL boundary', () => {
  it('keeps status vocabulary isolated by document kind and bounds page state', () => {
    expect(
      parseSalesDocumentQuery(
        new URLSearchParams(
          'page=-3&pageSize=500&status=ready-for-delivery&sort=delivery:desc&q=%20%20Aarav%20%20',
        ),
        'quotations',
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      search: 'Aarav',
      status: 'draft',
      sort: 'updated:desc',
      model: '',
      branchId: '',
      fromDate: '',
      toDate: '',
    });
    expect(
      parseSalesDocumentQuery(
        new URLSearchParams('status=ready-for-delivery&sort=delivery:desc'),
        'bookings',
      ),
    ).toMatchObject({ status: 'ready-for-delivery', sort: 'delivery:desc' });
  });

  it('serializes only meaningful page-local filters and canonicalizes status values', () => {
    expect(
      toSalesDocumentQueryString(
        {
          page: 2,
          pageSize: 50,
          search: 'BK-2026',
          status: 'awaiting-allocation',
          sort: 'amount:desc',
          model: 'Nexon EV',
          branchId: '11111111-1111-4111-8111-111111111111',
          fromDate: '2026-08-01',
          toDate: '2026-08-31',
        },
        'bookings',
      ),
    ).toBe(
      'page=2&pageSize=50&q=BK-2026&status=awaiting-allocation&sort=amount%3Adesc&model=Nexon+EV&branch=11111111-1111-4111-8111-111111111111&from=2026-08-01&to=2026-08-31',
    );
    expect(salesStatusValue('pending-approval')).toBe('PENDING_APPROVAL');
    expect(salesStatusValue('all')).toBe('ALL');
  });

  it('recognizes only optimistic concurrency conflicts', () => {
    expect(isSalesDocumentVersionConflict(new SalesDocumentVersionConflictError('quotation'))).toBe(
      true,
    );
    expect(
      isSalesDocumentVersionConflict({ code: '40001', message: 'BOOKING_VERSION_CONFLICT' }),
    ).toBe(true);
    expect(isSalesDocumentVersionConflict({ code: '42501', message: 'SCOPE_DENIED' })).toBe(false);
  });
});
