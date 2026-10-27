# UI / UX audit — Sales Manager (2026-10-24)

Captured with the role-navigation e2e in audit mode against `next dev` on the demo
tenant, signed in as the demo Sales Manager (`ALL_BRANCHES`, four showrooms).
Screenshots and per-page call timings are in the git-ignored
`playwright-report/ui-audit/2026-10-24-r3` (before), `2026-10-24-sm-r4` and
`2026-10-24-sm-r5` folders. Many fixes are shared with the Team Manager pass
(funnel, Lost Leads summary, Quotations default, list latency).

## Per page

| Page                                                                                                           | What was wrong                                                                                               | Fix                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                                                                                                      | Team overview stuck on a skeleton; once loaded it did not say which showroom it covered; roles in Title Case | Loads (branch choice below); "Last 7 days at Bengaluru Demo Showroom, busiest first"; sentence-case roles; shares the Sales Teams query key, so either page warms the other                                                                                                                        |
| Showroom Leads                                                                                                 | Column headed "Consultant" listed telecallers too                                                            | "Owner" (Team Leads too)                                                                                                                                                                                                                                                                           |
| Lead Assignment, Follow-ups, Team Calls, Appointments, Test Drives, Quotations, Bookings, Escalations, Reports | Content OK after the shared Team Manager fixes                                                               | —                                                                                                                                                                                                                                                                                                  |
| Lost Leads                                                                                                     | Legend of eight reasons wrapped into the donut                                                               | Donuts with more than five slices list the legend beside the ring                                                                                                                                                                                                                                  |
| Approvals                                                                                                      | Two tiles; "Value on this page" summed only the visible rows                                                 | Pending, Waiting over a day, Approved today, Rejected today, Discount requested, from one summary call over the whole queue                                                                                                                                                                        |
| Sales Teams                                                                                                    | "is unavailable": the RPC refused any manager whose scope held more than one branch                          | Opens on the first branch by name with a branch picker; "Team members" / "Member" headings; conversion "—" for telecallers                                                                                                                                                                         |
| Showroom Targets                                                                                               | Same refusal; bar axis read 180,000,000; telecallers listed at a ₹0 sales target                             | Branch picker; axes from one lakh up read "18 Cr" / "45 L"; consultants only                                                                                                                                                                                                                       |
| Performance                                                                                                    | Only the telecaller-to-sales handoff report; no member comparison (PRD 54.4 §49-52)                          | The Team Performance page with a showroom preset: branch picker with All branches, six tiles (leads, qualified, test drives, quotations, bookings, conversion), trend, conversion funnel (bars when the steps do not narrow), leaderboard with team and qualified columns, then the handoff report |

## Migrations

| Version                               | What                                                                                                                                                                                                                                                   | State              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `202610240191_showroom_branch_choice` | `target_branch_id` on the Sales Teams and Showroom Targets RPCs, checked with `can_access_branch`; opens on the first accessible branch; returns the branch list                                                                                       | Applied            |
| `202610240203_showroom_performance`   | `get_team_manager_performance` serves a Sales Manager over the teams in their branches (optional branch, checked against those teams), adds `qualified` and `team_name`; Showroom Targets lists consultants only; new `get_quotation_approval_summary` | Applied 2026-10-27 |

Verified in a rolled-back transaction as the demo users before applying:

- Sales Manager: 19 members over three branches; 87–155 ms warm in the database
  (1.6 s cold), one branch 130 ms.
- Team Manager: KPIs, daily series and leaderboard identical to the live function
  apart from the two added fields.
- Telecaller and GM: still `TEAM_MANAGER_ACCESS_REQUIRED`; an outside branch:
  `TEAM_PERFORMANCE_BRANCH_DENIED`.
- Approval summary: 17 pending for the Sales Manager and GM (matches the list
  total), 1 for the Team Manager, 0 for a consultant.

## Page timings (2026-10-24-sm-r4, settled)

All sixteen pages settle in 1.1–2.8 s on `next dev`; the slowest single calls are
the Edge-cached dashboard (842 ms) and the lead list (816 ms).
