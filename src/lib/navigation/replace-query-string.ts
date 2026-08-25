/**
 * Writes workspace filter state back into the address bar without a server
 * round trip.
 *
 * `router.replace` issues an RSC request for the page it is already on, which
 * re-runs proxy.ts and its get_workspace_bootstrap RPC on every filter click,
 * sort or page change. None of these workspaces need that: they hold their own
 * query state and read the URL only to seed it, so the address bar is for
 * shareable links and the back button rather than for driving a re-render.
 *
 * Next patches history.replaceState to keep usePathname and useSearchParams in
 * sync (a client-side ACTION_RESTORE, no fetch), so the workspaces that derive
 * their query from useSearchParams keep updating exactly as before.
 */
export function replaceQueryString(pathname: string, queryString?: string | null) {
  if (typeof window === 'undefined') return;
  const next = queryString ? `${pathname}?${queryString}` : pathname;
  if (`${window.location.pathname}${window.location.search}` === next) return;
  window.history.replaceState(null, '', next);
}
