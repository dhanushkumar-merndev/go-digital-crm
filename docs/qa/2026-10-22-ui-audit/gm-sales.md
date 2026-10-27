# UI / UX audit — GM Sales (2026-10-27)

Captured with the role-navigation e2e in audit mode against `next dev`, signed in
as the demo GM Sales Executive (all four showrooms). Screenshots and timings are in
the git-ignored `playwright-report/ui-audit/2026-10-27` (before) and
`2026-10-27-r2` (after) folders. All ten sidebar pages and the four Sales
Analytics tabs render in both runs.

## Per page

| Page                                        | What was wrong                                                                                                 | Fix                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                                   | No funnel (deliberate: GM reads it on Sales Analytics); target bars fine                                       | —                                                                                                                                                 |
| Sales Analytics · Performance               | "Sales funnel volumes" mixed calls (2,995) into a lead funnel; ECharts re-sorted the stages and drew no labels | PRD stages Leads → Contacted → Qualified → Test drive → Quotation → Booking with side labels; bars when a later step outgrows an earlier one      |
| Sales Analytics · Showroom comparison       | The Performance table again, no charts                                                                         | Bookings by showroom and Conversion by showroom (lead → booking, test drive → booking, lost %) above the table; Lost column                       |
| Sales Analytics · Sales consultant ranking  | Telecallers ranked at 0% conversion (PRD 54.5 §5: do not mix them in); tab said "Consultant ranking"           | Consultants only; renamed                                                                                                                         |
| Sales Analytics · Model performance         | Lead interest only; legend "Actual"                                                                            | Leads, test drives, quotations, bookings, lost and conversion per model; available / incoming stock for callers who may check stock; grouped bars |
| Lead Source Performance                     | Funnel labels invisible; four identical tile icons; every other source missing from the bar axis               | Labels inside the bands with counts; icons per tile; all source names (tilted)                                                                    |
| Targets                                     | 1.2–1.4 s RPC (per-row `can_access_record`); "Bengaluru Whitefield Showroom" missing from both axes            | Same result in 53 ms; every showroom labelled                                                                                                     |
| Sales Leads                                 | "Read only" page offered Import CSV and Add lead                                                               | Hidden on read-only pages                                                                                                                         |
| Bookings Overview                           | Dashboard description; Create booking and row menus on a read-only page                                        | Bookings description; view only                                                                                                                   |
| Approvals, Lost Leads, Escalations, Reports | Shared with the Sales Manager pages already fixed                                                              | —                                                                                                                                                 |

Charts across every role benefit: proportional funnels had white labels outside the
band (invisible on Business Owner and marketing pages too), and short bar charts
dropped alternate category labels.

## Migration `202610270157_gm_sales_analytics_detail` (pending)

Patches `get_gm_sales_analytics_workspace` (consultant-only ranking, per-model
activity and stock, branch lost counts, contacted / qualified KPIs) and
`get_gm_target_workspace` (branches fully visible to the caller resolved once).
Verified as the demo GM in a rolled-back transaction:

- Analytics: every pre-existing field byte-identical to live; 58 ms warm (live 54 ms);
  11 consultants, no telecallers; stock hidden (the demo GM has no inventory
  permission); Sales Manager and Team Manager still `GM_SALES_ACCESS_REQUIRED`.
- Targets: identical md5 for the current and previous month; 53 ms against 1,235 ms.

Until it is applied the page code falls back: the funnel omits Contacted and
Qualified, models show leads only, and the Lost column and lost % are hidden.
