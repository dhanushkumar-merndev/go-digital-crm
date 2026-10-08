'use client';

import {
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { clear, createStore, del, get, set, type UseStore } from 'idb-keyval';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { DASHBOARD_QUERY_STALE_TIME_MS } from './cache-policy';

/**
 * Browser-first aggregates: a reload inside the freshness window paints from
 * IndexedDB with no network call, then Redis, then PostgreSQL only when Redis
 * is missing or out of date. Only aggregate counts and series belong here.
 * Customer names, phone numbers, transcripts and signed URLs never do (AGENTS
 * §43, §72), so live rows stay in ordinary memory-only queries.
 */
const PERSISTED_QUERY_MAX_AGE_MS = DASHBOARD_QUERY_STALE_TIME_MS;

type PersistedEntry = { version: number; savedAt: number; data: unknown };

let store: UseStore | null = null;
function persistedStore() {
  if (typeof window === 'undefined' || !window.indexedDB) return null;
  store ??= createStore('gdm-query-cache', 'aggregates');
  return store;
}

function storageKey(queryKey: QueryKey) {
  return JSON.stringify(queryKey);
}

async function readPersisted<T>(queryKey: QueryKey, version: number, schema: z.ZodType<T>) {
  const target = persistedStore();
  if (!target) return null;
  try {
    const entry = await get<PersistedEntry>(storageKey(queryKey), target);
    if (!entry || entry.version !== version) return null;
    if (Date.now() - entry.savedAt >= PERSISTED_QUERY_MAX_AGE_MS) {
      void del(storageKey(queryKey), target).catch(() => undefined);
      return null;
    }
    const parsed = schema.safeParse(entry.data);
    return parsed.success ? { data: parsed.data, savedAt: entry.savedAt } : null;
  } catch {
    // Private windows and blocked site data reject IndexedDB. The page then
    // simply loads from the server, as it always could.
    return null;
  }
}

async function writePersisted(queryKey: QueryKey, version: number, data: unknown, savedAt: number) {
  const target = persistedStore();
  if (!target) return;
  try {
    await set(storageKey(queryKey), { version, savedAt, data } satisfies PersistedEntry, target);
  } catch {
    // Persistence is a convenience; a failed write never affects the page.
  }
}

/** Called on sign-out and user switch, beside queryClient.clear(). */
export async function clearPersistedQueries() {
  const target = persistedStore();
  if (!target) return;
  try {
    await clear(target);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/**
 * useQuery whose successful result is mirrored to IndexedDB and seeded back on
 * the next page load. The query key must already carry organization, user and
 * scope (workspaceQueryScope), because it is also the storage key.
 */
export function usePersistedQuery<T>(
  options: Omit<UseQueryOptions<T, Error, T, QueryKey>, 'enabled'> & {
    enabled?: boolean;
    persist: { version: number; schema: z.ZodType<T> };
  },
) {
  const { persist, ...queryOptions } = options;
  const queryClient = useQueryClient();
  const key = storageKey(queryOptions.queryKey);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  // Already in memory (an in-session revisit): IndexedDB has nothing newer.
  const inMemory = queryClient.getQueryData(queryOptions.queryKey) !== undefined;

  useEffect(() => {
    if (inMemory) return;
    let cancelled = false;
    void readPersisted(queryOptions.queryKey, persist.version, persist.schema).then((entry) => {
      if (cancelled) return;
      // updatedAt is the original save time, so staleTime counts from when the
      // data was fetched, not from this reload.
      if (entry && queryClient.getQueryData(queryOptions.queryKey) === undefined)
        queryClient.setQueryData(queryOptions.queryKey, entry.data, { updatedAt: entry.savedAt });
      setHydratedKey(key);
    });
    return () => {
      cancelled = true;
    };
    // queryKey is represented by `key`; persist is static per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, inMemory, queryClient]);

  const ready = inMemory || hydratedKey === key;
  const query = useQuery({
    ...queryOptions,
    enabled: ready && (queryOptions.enabled ?? true),
  });

  const { data, dataUpdatedAt, isSuccess } = query;
  useEffect(() => {
    if (!isSuccess || data === undefined || !ready) return;
    void writePersisted(queryOptions.queryKey, persist.version, data, dataUpdatedAt);
    // Written once per successful fetch; dataUpdatedAt changes exactly then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt, isSuccess, ready, key]);

  return query;
}

/** Persistence check for a flat bundle of counts, such as a workspace's KPI object. */
export function countRecordSchema<T>() {
  return z.custom<T>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((count) => count === null || typeof count === 'number'),
  );
}
