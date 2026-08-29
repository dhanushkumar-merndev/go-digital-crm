'use client';

import { useEffect, useMemo, useState } from 'react';
import { replaceQueryString } from './replace-query-string';

/**
 * Opening a record's own module and marking the row it lives on.
 *
 * A lead's stage badge used to link to `?q=<lead uuid>`, which filtered the
 * destination list down to a single row and left a database identifier sitting
 * in a search box the user can read, edit and copy. Focusing does the opposite:
 * the destination keeps its normal list, and the row that matters is marked and
 * scrolled to. The identifier travels in `?focus=`, is consumed on arrival, and
 * is stripped from the address bar so it is never a visible or shareable
 * artefact of the database.
 *
 * The stage badge only knows the *lead*, while the destination lists
 * follow-ups, appointments, test drives or documents. So callers match on
 * whatever field ties their row back to that lead, and more than one row may
 * match — a lead with two open follow-ups highlights both rather than picking
 * one arbitrarily.
 */
export const FOCUS_PARAM = 'focus';

/**
 * The marked row. A left accent bar carries the emphasis so the row still reads
 * as part of the table, and the tint stays light enough for the row's own
 * status colours to survive on top of it. `transition-colors` means arriving at
 * the row and losing the mark a few seconds later both fade rather than snap.
 */
export const focusedRowClassName =
  'bg-blue-50/90 shadow-[inset_4px_0_0_0_#2563eb] ring-1 ring-inset ring-blue-200 transition-colors duration-500';

export function focusRowElementId(scope: string, recordId: string) {
  return `${scope}-row-${recordId}`;
}

/**
 * Builds a link into `path` that marks whichever rows belong to `leadId`.
 *
 * `extra` exists because most destinations open on a filtered tab by default —
 * the follow-up and task workspaces both land on Today — and a record that is
 * not due today would not be in the list to mark. Callers pass the tab that
 * guarantees the row is present, usually `status=all`.
 */
export function focusRowHref(path: string, leadId: string, extra?: Record<string, string>) {
  const params = new URLSearchParams(extra);
  params.set(FOCUS_PARAM, leadId);
  return `${path}?${params.toString()}`;
}

export function readFocusParam(searchParams: { get: (key: string) => string | null }) {
  const value = searchParams.get(FOCUS_PARAM) ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function useFocusedRows({
  focusId,
  matchedIds,
  scope,
  pathname,
  searchParams,
  holdMs = 3200,
}: {
  focusId: string | null;
  /** Row ids on the current page that belong to `focusId`. */
  matchedIds: readonly string[];
  /** Prefix for the row DOM ids, so two tables on one page cannot collide. */
  scope: string;
  pathname: string;
  searchParams: URLSearchParams;
  holdMs?: number;
}) {
  // Only the *spent* mark is stored. Deriving the highlight from the props and
  // recording what has already been consumed keeps the set of marked rows a
  // function of the URL rather than a copy of it that can drift, and avoids
  // writing state from inside the effect.
  const [consumedKey, setConsumedKey] = useState<string | null>(null);
  // Identity-stable so a caller re-deriving the array every render does not
  // restart the timer and hold the mark up forever.
  const matchKey = matchedIds.join(',');
  const active = Boolean(focusId) && matchKey.length > 0 && consumedKey !== matchKey;

  useEffect(() => {
    if (!active) return;
    const row = document.getElementById(focusRowElementId(scope, matchKey.split(',')[0]));
    globalThis.requestAnimationFrame(() => {
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const timeout = globalThis.setTimeout(() => {
      setConsumedKey(matchKey);
      const next = new URLSearchParams(searchParams.toString());
      if (next.has(FOCUS_PARAM)) {
        next.delete(FOCUS_PARAM);
        replaceQueryString(pathname, next.toString());
      }
    }, holdMs);
    return () => globalThis.clearTimeout(timeout);
  }, [active, holdMs, matchKey, pathname, scope, searchParams]);

  return useMemo(() => new Set(active ? matchKey.split(',') : []), [active, matchKey]);
}
