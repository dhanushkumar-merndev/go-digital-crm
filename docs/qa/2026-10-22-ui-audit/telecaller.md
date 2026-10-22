# UI / UX audit — Telecaller (2026-10-22)

Captured with the role-navigation e2e in audit mode against `next dev` on the demo
tenant (`E2E_AUDIT_DIR=playwright-report/ui-audit/<run> E2E_ROLES=telecaller pnpm
test:e2e:role-navigation`). Screenshots and per-page call timings live in the
git-ignored `playwright-report/ui-audit/2026-10-22-before` and `-after` folders.

Timings are network-inclusive from the browser on the shared Micro-tier demo
project, warm (second run), so read them as relative, not absolute.

## Per page

| Page              | Verdict  | What was wrong                                                                                                                                                                                                            | Fix                                                                                                                                                           | Calls before → after          | Settled before → after |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------- |
| Dashboard         | Fix      | Funnel showed stage-over-stage "conversion" of 233% (the RPC reports current stage, not reach); the same four counts appeared three times (KPI row, Requires attention, Tasks & alerts); page waited on all three queries | Lifecycle donut with each stage's share (PRD §24); removed both repeating cards; page renders on the summary, lead/follow-up tiles show their own placeholder | 13 → 13 (first page of a tab) | 11.6 s → 8.0 s         |
| My Leads          | Simplify | Handed-off leads were tinted overdue, so most of the list read red for work that belongs to the consultant                                                                                                                | No overdue tint on read-only handed-off rows                                                                                                                  | 13 → 10                       | 5.4 s → 1.7 s          |
| Follow-ups        | OK       | —                                                                                                                                                                                                                         | —                                                                                                                                                             | 10 → 7                        | 4.1 s → 1.3 s          |
| Tasks             | Simplify | Opens on an empty Today tab while 26 tasks are overdue; empty state said "clear filters"                                                                                                                                  | Empty Today with overdue work explains it and links to Overdue                                                                                                | 10 → 7                        | 7.0 s → 1.2 s          |
| Activity Timeline | Fix      | Raw codes (`FOLLOWUP COMPLETED`, `INBOUND`) under every row; completed and cancelled follow-ups titled "Follow-up scheduled"                                                                                              | Title from the activity code (scheduled / completed / rescheduled / cancelled); codes turned into words; a code the title already says is not repeated        | 10 → 7                        | 4.6 s → 2.2 s          |
| Calls             | Simplify | Different KPI tile from Follow-ups/Tasks on the same role                                                                                                                                                                 | One KPI tile app-wide                                                                                                                                         | 10 → 7                        | 3.3 s → 1.7 s          |
| Inbox             | OK       | —                                                                                                                                                                                                                         | —                                                                                                                                                             | 13 → 10                       | 3.5 s → 1.5 s          |
| Reviews           | Simplify | Title Case labels; older tile                                                                                                                                                                                             | Sentence case; shared tile                                                                                                                                    | 10 → 7                        | 7.5 s → 1.3 s          |
| Performance       | Simplify | Title Case labels; older tile                                                                                                                                                                                             | Sentence case; shared tile                                                                                                                                    | 12 → 9                        | 5.9 s → 4.6 s          |

## Shared fixes found on this role (apply to every role)

- **One KPI tile.** `KpiGrid` had a second, older "classic" tile that Telecaller and
  Sales Consultant got on Calls, Appointments, Test Drives, Quotations, Reviews,
  Performance and Customers, while their dashboards, leads and follow-ups used
  `MetricCard`. `KpiGrid` now always renders `MetricCard`; `kpiVariantForRole` is gone.
  Every tile carries `data-kpi`, which the audit counts.
- **Personal WhatsApp reconnect backoff** lived in memory, so every full page load
  asked the gateway to relink immediately and a full server answered 409 two or
  three times per page. The backoff is now kept in `sessionStorage`.
- **Profile avatar presign** ran on every full page load (0.6–6.5 s Edge call). The
  signed URL is reused from `sessionStorage` while it has more than a minute of its
  five-minute life left; it is never written to IndexedDB.

## Canonical KPI sets (applied in the Sales Consultant pass)

Approved at the Telecaller checkpoint and applied to both sales roles:

- **My Leads:** Total leads, New today, Pending, SLA risk, Hot leads, Follow-up (5 → 6).
- **Follow-ups:** Overdue, Due today, Upcoming, Completed today (5 → 4).
- **Performance:** one row of eight — Leads assigned, Contacted, Calls, Connected
  calls, Qualified, Transferred to sales, Conversion, Target achievement (12 → 8).
  Talk time, connection rate and follow-ups completed are the tiles' helpers.

## Not changed, needs a decision

- **"Appointment" slice on the Telecaller lifecycle chart** comes from the pipeline
  RPC even though Telecaller has no appointment surface. Pre-existing; the donut only
  renders what the RPC returns.
- **Talk time 0:00 with 12 connected calls** on Performance: the demo calls carry no
  duration; not a UI defect.

## Mobile (Telecaller and Sales Consultant share these screens)

- **My Leads** rebuilt to the reference: title "My Leads" with the lead total, chips
  with counts (lead counts, as on the web tabs), Sort by (last updated / next
  follow-up / newest / name), Updated + refresh, cards with initials avatar,
  temperature badge, model • source, phone, Call and WhatsApp, and a footer with
  next follow-up, stage, and budget or location. A floating Add button opens a new
  **Add lead** screen (`/new-lead`, same `create_lead` as the web).
- Later pages no longer ask the RPC for KPIs (`target_include_kpis` only on page 1).
- **Home** for both roles: Today's targets (only when targets exist — the demo users
  have none, so it stays hidden), quick actions to screens that exist, a four-tile
  snapshot, Call next, and a sideways Recent leads strip.
- **Budget and location** are wired through (the card reads `budget_min`,
  `budget_max` and `customer_city`) but not yet returned by the list RPC; the
  patch to the deployed function is drafted and not applied.
- **Visual check blocked:** Expo Go 57.0.9 fails inside `NativeWorklets.installUnpackers`
  with `react-native-worklets` 0.11.4, and the local JDK 27 is likely too new for a
  Gradle dev build. Mobile changes are type-checked only.

## Round 2 (page by page, 2026-10-22)

Screenshots: `playwright-report/ui-audit/2026-10-22-r2-telecaller` (before) and
`2026-10-22-r2-telecaller-after`.

| Page               | What was wrong                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard          | The funnel read only the 437 open leads by current stage, so Contacted (262) drew wider than New (112) and the 373 handed to Sales were missing. Recent leads showed follow-up dates two weeks past with no marker | Cumulative funnel from the My Leads counts already on the page: Assigned 964 → Contacted 852 → Qualified 438 → Transferred 373, each as a share of assigned, plus "130 lost after contact". Past follow-ups read red "· overdue". Contacted tile caption "Reached, not yet qualified" |
| My Leads           | Total tile said "86.5% still active" counting leads already with Sales; share helpers carried trend arrows (a red ↘ on SLA risk read as worsening); "Transferred to Sales" tab                                     | "47.8% still with you" (transferred and lost excluded for the telecaller); no arrows on shares; sentence case                                                                                                                                                                         |
| Follow-ups / Tasks | Same arrows; "missed against open workload"; Tasks filters stretched across the bar; "In Progress" tab                                                                                                             | No arrows; "of open follow-ups / tasks"; fixed-width filters; sentence case                                                                                                                                                                                                           |
| Activity Timeline  | Test drives and Quotations summary tiles (always 0 for a telecaller); "No follow-ups are scheduled" while 146 are overdue                                                                                          | Tiles hidden for the telecaller; empty text points to overdue follow-ups                                                                                                                                                                                                              |
| Calls              | Chart lines: Connected drew exactly over Calls on days every call connected, so Calls read 0; developer copy ("page-local search", "authorized sales scope")                                                       | Grouped bars; plain copy; empty state says "No calls here yet" unless a filter is applied                                                                                                                                                                                             |
| Inbox              | "Workspace / Inbox" breadcrumb unlike every other page                                                                                                                                                             | Same Dashboard › Inbox trail                                                                                                                                                                                                                                                          |
| Reviews            | Sent hidden behind Filled; "09-23" dates; star chart legend "Actual"                                                                                                                                               | Grouped bars, "23 Sept" dates, legend "Reviews"                                                                                                                                                                                                                                       |
| Performance        | Daily chart had the same Calls/Connected overlap; consultant table squeezed to half width, names on three lines                                                                                                    | Grouped bars up to 31 days; table 7/12 of the row                                                                                                                                                                                                                                     |

Warm settle after: 1.1–1.9 s for every page; the dashboard is 3.6 s as the first
page of the run.

### Database change proposed (not applied)

`get_tenant_dashboard_summary` (→ `app_private.tenant_performance_dashboard`, 989
lines, shared by every role's dashboard) takes 0.55–0.95 s for the telecaller. It
resolves eight record scopes and ten `has_permission` checks on every call and
computes stock, booking and case counts a telecaller never sees. The page's other
calls are 0.1–0.35 s.

### Follow-up (same day)

- **Dashboard summary latency.** Profiled inside PostgreSQL as the demo telecaller:
  the function is ~170 ms warm (leads 41 ms, follow-ups 51 ms; scopes and
  permission checks ~25 ms). The Edge/Redis hop cost 380–840 ms even on a hit, and
  an own-records summary shares nothing across users. The telecaller dashboard
  now reads `get_tenant_dashboard_summary` directly (`direct: true`); a manual
  refresh still goes through Edge so its quota holds. No database change was
  needed.
- **Lead detail.** "Sales owner" / "Assigned consultant" named the telecaller →
  "Lead owner". A follow-up two weeks past read "On track" → "Follow-up overdue"
  and the date in red. Work state shows "SLA risk" instead of "SLA RISK". The
  second "Open customer 360" button is gone.
- **Customer 360.** Duplicate "Edit customer" (the blue "+ Edit customer" by the
  tabs) removed; "Lead owner"; "Customer ID"; plain identifier note.
- **Not applied — needs approval:** `get_customer_operational_cases` returns 404
  because migrations `202610210005`–`202610210011` (committed on 21 Oct) were
  never applied. 0011 alone is self-contained and dry-runs cleanly.
