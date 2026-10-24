# UI / UX audit — Team Manager (2026-10-24)

Captured with the role-navigation e2e in audit mode against `next dev` on the demo
tenant. Screenshots and per-page call timings are in the git-ignored
`playwright-report/ui-audit/2026-10-24-tm-before` and `2026-10-24-tm-after` folders.
All 16 sidebar pages render in both runs.

## Per page

| Page                                                                               | What was wrong                                                                                                                                                         | Fix                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                                                                          | "Lead pipeline" drew where each open lead is now as a narrowing funnel: New 254 → Contacted 416 → Qualified 2 → Appointment 170 → Sales 773, with "8500.0% conversion" | Each step counts leads that reached it or went further: Open leads 1,616 → Contacted 1,362 (84%) → Qualified 946 (59%) → Transferred to sales 774 (48%). Appointment is folded in; it is not required to reach Sales |
| Dashboard                                                                          | Overdue chips said "overdue 1 day+" on follow-ups due 18 days ago (also on the Telecaller dashboard)                                                                   | "18 days overdue", measured from when the dashboard data was built                                                                                                                                                   |
| Dashboard                                                                          | Team overview had no role, so telecallers read "0% conversion"                                                                                                         | Role column; conversion "—" for telecallers (needs the migration below for the role)                                                                                                                                 |
| Team Leads                                                                         | Total leads helper said "still with you" and left transferred leads out of the active share                                                                            | Managers and consultants read "still active"; only a telecaller's share drops leads handed to Sales                                                                                                                  |
| Lead Assignment                                                                    | "Eligible telecallers" listed sales consultants as "Unavailable"                                                                                                       | "Team members", the people who can take the selected lead first, "Not eligible" for the rest                                                                                                                         |
| Lost Leads                                                                         | No summary; Import CSV and Add lead on a list of closed leads; Next follow-up always "—"                                                                               | Loss reason replaces the empty follow-up column; create buttons hidden; tiles (Lost leads, Lost this month, Last 7 days, Lost to a competitor) and a reason donut from the new summary RPC                           |
| Team Calls                                                                         | Chart plotted calls against bookings; "Call quality snapshot" repeated the tiles; table headed "Consultant" with a Bookings column                                     | Bars of calls per day (Connected beside them once the migration adds the daily count); snapshot card removed; "Calls by team member" with role and average duration                                                  |
| Appointments                                                                       | 8.2 s calendar, called twice; "Today's agenda 0" next to "Today 1" while the second call loaded; two-week-old visits still "Scheduled"                                 | Agenda reuses the month data when it already holds the whole day, shows a skeleton while loading; past unresolved visits read "Overdue". Calendar latency: migration below                                           |
| Quotations                                                                         | Opened on Draft (19 of 350); no All or Converted tab; 3.8 s second call for the tiles                                                                                  | Opens on All like Bookings, so the tiles come from the page call; All and Converted tabs. Latency: migration below                                                                                                   |
| Team Performance                                                                   | A telecaller ranked #2 "top performer" at 0%; "Consultant leaderboard"                                                                                                 | Top performers are consultants (ranked on bookings); "Team leaderboard" with role, conversion "—" for telecallers                                                                                                    |
| Reports                                                                            | Empty grey ring when there were no exports                                                                                                                             | Plain empty-state text                                                                                                                                                                                               |
| Duplicate approvals, Follow-ups, Team activity, Test drives, Bookings, Escalations | Content OK (Test drives' 4.5 s was a cold first call; 350 ms warm)                                                                                                     | —                                                                                                                                                                                                                    |

## Server latency (migration `202610240173_manager_list_scope_once`, awaiting approval)

Every role except Sales Consultant reaches these through `*_legacy` functions that
call `can_access_record` (and, for the calendar, `can_access_customer` and
`can_access_lead`) once per row. Rewritten to resolve scope once and filter on its
arrays; compared byte for byte with the live functions for 8 roles × 24 cases
(192 identical, permission errors included). Timed inside the database as the demo
Team Manager:

| RPC                                  | Before | After |
| ------------------------------------ | ------ | ----- |
| `get_appointment_calendar`           | 12.3 s | 72 ms |
| `get_quotation_workspace_page` (All) | 5.1 s  | 61 ms |
| `get_sales_booking_workspace_page`   | 3.0 s  | 87 ms |
| `get_sales_booking_filter_options`   | 3.4 s  | 53 ms |

The same migration adds `member_type` and a daily `connected_calls` to
`get_team_manager_performance`, a `cancelled` booking count, and
`get_lost_lead_summary`.
