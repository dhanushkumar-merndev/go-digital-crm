'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

/**
 * "Back" on a detail page, done as history rather than as a link.
 *
 * A detail page is almost always opened from a list that is holding state the
 * URL of the list alone cannot restore the feel of: the active tab, the page
 * number, the filters, the scroll position. Linking to the bare list href threw
 * all of that away, so returning from a lead put you back on the default tab at
 * page one and you had to find your place again.
 *
 * Going back through history restores the previous entry as the browser had it.
 * The fallback matters for the case history cannot serve: the detail page opened
 * directly in a fresh tab, from a bookmark, or from a link someone shared, where
 * there is no previous entry inside this app to return to. `replace` there keeps
 * the dead-end detail entry from sitting between the list and whatever the user
 * presses next.
 */
export function useReturnToList(fallbackHref: string) {
  const router = useRouter();
  return useCallback(() => {
    // Fresh tab: the only entry is this page, so there is nothing to go back to.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.replace(fallbackHref);
  }, [fallbackHref, router]);
}
