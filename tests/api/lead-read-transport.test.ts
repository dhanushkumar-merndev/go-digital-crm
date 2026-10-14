import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { defaultLeadQuery } from '../../src/features/leads/lead-workspace-query';
import { retryRpcRead } from '../../src/lib/supabase/read-rpc';
import { parseInventoryQuery } from '../../src/features/inventory/inventory-query';
import { parseOperationalCaseQuery } from '../../src/features/operations/operational-case-query';

const boundary = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => boundary.client }));
vi.mock('@/lib/supabase/read-rpc', () => import('../../src/lib/supabase/read-rpc'));
vi.mock(
  '@/lib/query/cached-dashboard-api',
  () => import('../../src/lib/query/cached-dashboard-api'),
);

import {
  fetchAssignableUsers,
  fetchInterestedModelOptions,
  fetchLeadPhoneHistory,
  fetchLeadWorkspaceMeta,
  fetchLeadWorkspaceRecords,
  fetchPersonalLeadFlags,
  toLeadMetaQuery,
} from '../../src/features/leads/lead-workspace-api';
import { fetchLeadDetail } from '../../src/features/leads/lead-detail-api';
import {
  fetchAllocationPage,
  fetchBookingOptions,
  fetchInventoryBranches,
  fetchMovementPage,
  fetchStockCheckFilterOptions,
  fetchStockCheckPage,
  fetchStockUnitDetail,
  fetchStockUnitPage,
  fetchVariantOptions,
} from '../../src/features/inventory/inventory-api';
import {
  fetchOperationalCaseBookingOptions,
  fetchOperationalCaseDetail,
  fetchOperationalCaseWorkspace,
} from '../../src/features/operations/operational-case-api';

const leadId = '65d2a775-8b6d-45f6-a031-52b0be7b1125';
const inventoryQuery = parseInventoryQuery(new URLSearchParams(), 'units');
const operationalQuery = parseOperationalCaseQuery(new URLSearchParams());
const reads = [
  {
    name: 'lead rows',
    read: (signal?: AbortSignal) => fetchLeadWorkspaceRecords(defaultLeadQuery, signal),
  },
  {
    name: 'lead counters',
    read: (signal?: AbortSignal) =>
      fetchLeadWorkspaceMeta(toLeadMetaQuery(defaultLeadQuery), signal),
  },
  { name: 'phone history', read: (signal?: AbortSignal) => fetchLeadPhoneHistory(leadId, signal) },
  { name: 'pins and stars', read: (signal?: AbortSignal) => fetchPersonalLeadFlags(signal) },
  {
    name: 'assignment candidates',
    read: (signal?: AbortSignal) => fetchAssignableUsers(leadId, '', signal),
  },
  {
    name: 'vehicle model options',
    read: (signal?: AbortSignal) => fetchInterestedModelOptions({}, signal),
  },
  { name: 'lead detail', read: (signal?: AbortSignal) => fetchLeadDetail(leadId, signal) },
  { name: 'inventory branches', read: (signal?: AbortSignal) => fetchInventoryBranches(signal) },
  {
    name: 'stock units',
    read: (signal?: AbortSignal) => fetchStockUnitPage(inventoryQuery, signal),
  },
  {
    name: 'stock filters',
    read: (signal?: AbortSignal) => fetchStockCheckFilterOptions('', signal),
  },
  {
    name: 'stock check',
    read: (signal?: AbortSignal) => fetchStockCheckPage(inventoryQuery, signal),
  },
  {
    name: 'allocations',
    read: (signal?: AbortSignal) => fetchAllocationPage(inventoryQuery, signal),
  },
  { name: 'movements', read: (signal?: AbortSignal) => fetchMovementPage(inventoryQuery, signal) },
  { name: 'variant options', read: (signal?: AbortSignal) => fetchVariantOptions('', signal) },
  {
    name: 'booking options',
    read: (signal?: AbortSignal) => fetchBookingOptions(leadId, '', signal),
  },
  { name: 'stock detail', read: (signal?: AbortSignal) => fetchStockUnitDetail(leadId, signal) },
  {
    name: 'department cases',
    read: (signal?: AbortSignal) => fetchOperationalCaseWorkspace('RTO', operationalQuery, signal),
  },
  {
    name: 'department booking options',
    read: (signal?: AbortSignal) => fetchOperationalCaseBookingOptions('RTO', '', signal),
  },
  {
    name: 'department case detail',
    read: (signal?: AbortSignal) => fetchOperationalCaseDetail('RTO', leadId, signal),
  },
];

// Keep the actual PostgREST client and request builder: only HTTP is replaced.
const http = vi.fn<typeof fetch>();
beforeEach(() => {
  http.mockReset();
  boundary.client = createSupabaseClient('https://lead-test.supabase.co', 'test-anon-key', {
    accessToken: async () => 'test-token',
    global: { fetch: http },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
});
afterEach(() => vi.restoreAllMocks());

describe.each(reads)('$name transport', ({ read }) => {
  it('keeps denied reads to one request and preserves the server status', async () => {
    http.mockResolvedValue(
      new Response(JSON.stringify({ code: '42501', message: 'Permission denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new QueryClient();
    try {
      await expect(
        client.fetchQuery<unknown>({
          queryKey: ['read'],
          queryFn: () => read(),
          retry: retryRpcRead,
        }),
      ).rejects.toMatchObject({ code: '42501', status: 403 });
      expect(http).toHaveBeenCalledOnce();
    } finally {
      client.clear();
    }
  });

  it('preserves cancellation without issuing an obsolete HTTP request', async () => {
    const caller = new AbortController();
    caller.abort();
    await expect(read(caller.signal)).rejects.toBe(caller.signal.reason);
    expect(http).not.toHaveBeenCalled();
  });

  it('retries an uncoded gateway failure once, then stops on permission denial', async () => {
    http
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Service unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: '42501', message: 'Permission denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = new QueryClient();
    try {
      await expect(
        client.fetchQuery<unknown>({
          queryKey: ['transient-read'],
          queryFn: () => read(),
          retry: retryRpcRead,
          retryDelay: 0,
        }),
      ).rejects.toMatchObject({ code: '42501', status: 403 });
      expect(http).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
    }
  });

  it('exits an expired read deadline as a retryable timeout', async () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('Read deadline elapsed', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    http.mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(read()).rejects.toMatchObject({ code: 'READ_TIMEOUT', status: 408 });
    expect(http).not.toHaveBeenCalled();
  });
});
