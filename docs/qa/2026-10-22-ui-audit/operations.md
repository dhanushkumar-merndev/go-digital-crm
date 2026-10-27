# UI / UX audit — Operations desks (2026-10-27)

Inventory, Finance, Insurance, RTO, Exchange, Delivery and Customer Care, managers
and executives (14 roles). Captured with the role-navigation e2e in audit mode
against `next dev`; screenshots and timings are in the git-ignored
`playwright-report/ui-audit/2026-10-27-ops` (before), `2026-10-27-ops-r2` and
`2026-10-27-ops-exec` (after) folders. Every sidebar page and case-list tab
renders for all 14 roles.

## Per page

| Page                                                                 | What was wrong                                                                                                      | Fix                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finance / Insurance / RTO / Exchange / Delivery dashboards           | The generic sales dashboard: "Bookings this month", a bookings-only trend, five tiles, through the 1.6 s Edge cache | Desk dashboard (PRD 54.7 §4): open, overdue, due today, pending documents, completed this month; "Requires attention" (open cases, earliest due first, overdue in red); cases by status. One 250 ms call (the case list's), page settles 1.3 s instead of 2.5 s |
| Inventory dashboard                                                  | — (8 tiles, attention, model donut, branch bar)                                                                     | Model donut legend now beside the ring (shared chart fix)                                                                                                                                                                                                       |
| Inventory · Stock Transfer                                           | 1.9–2.3 s RPC                                                                                                       | 54 ms, same result (migration below)                                                                                                                                                                                                                            |
| Inventory · Stock Allocation                                         | 0.9 s RPC                                                                                                           | 71 ms, same result                                                                                                                                                                                                                                              |
| Delivery · Feedback                                                  | 1.0–1.2 s RPC                                                                                                       | ~230 ms, same result                                                                                                                                                                                                                                            |
| Customer Care · Reviews                                              | 1.3–1.8 s RPC; placeholder description "Configure this CRM capability…"                                             | 39–49 ms, same result; describes the page                                                                                                                                                                                                                       |
| Case lists (all desks), My Performance, Reports, Customer Care pages | Content OK                                                                                                          | —                                                                                                                                                                                                                                                               |

## Migration `202610270179_operations_lists_scope_once` (pending)

`get_stock_movement_page`, `get_stock_allocation_page` and
`get_review_approval_queue` called `can_access_branch` once per row (twice per
stock movement); the caller's accessible branches are now resolved once into an
array, which is exact because a branch's answer does not depend on the row.
`get_delivery_feedback_workspace_page` called `can_access_record` and
`can_access_customer` per row; it now skips the record check for branches fully
visible to the caller (the per-record check still runs elsewhere, so own-team and
own-record scopes are unchanged) and reads customer access from
`resolve_customer_access_scope`, the predicate the appointment calendar already
uses.

Compared with the live functions in a rolled-back transaction: identical results
(md5) for inventory manager and executive, delivery manager and executive,
customer-relationship manager and executive, Client Admin, Business Owner, GM,
Sales Manager and Sales Consultant, permission errors included.
